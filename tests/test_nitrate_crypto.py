import io
import os
import sys

import pytest

pytest.importorskip("cryptography")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nitrate_crypto as nc  # noqa: E402
from nitrate_crypto import DecryptionError, NitrateCryptoError  # noqa: E402

FAST = {"kdf": "scrypt", "kdf_params": {"n": 2**10, "r": 8, "p": 1}}
CHUNK = 1024 * 1024  # 1 MiB -> ~10 chunks for a 10 MB file


@pytest.fixture(scope="module")
def big(tmp_path_factory):
    p = tmp_path_factory.mktemp("d") / "video.mp4"
    p.write_bytes(os.urandom(10 * 1000 * 1000 + 12345))  # not a chunk multiple
    return p


def _enc(src, dst, **kw):
    opts = dict(FAST, chunk_size=CHUNK)
    opts.update(kw)
    nc.encrypt_file(src, dst, **opts)


def test_roundtrip_multichunk_password(big, tmp_path):
    enc, out = tmp_path / "v.nenc", tmp_path / "v.out"
    _enc(big, enc, password="correct horse")
    data = enc.read_bytes()
    assert data[:8] == b"NITRATE\x00"
    assert len(data) == nc.HEADER_SIZE + big.stat().st_size + 10 * nc.TAG_SIZE
    assert big.read_bytes()[:4096] not in data
    nc.decrypt_file(enc, out, password="correct horse")
    assert out.read_bytes() == big.read_bytes()


def test_exact_chunk_multiple(tmp_path):
    src = tmp_path / "s"
    src.write_bytes(os.urandom(3 * 4096))
    _enc(src, tmp_path / "e", password="pw", chunk_size=4096)
    nc.decrypt_file(tmp_path / "e", tmp_path / "o", password="pw")
    assert (tmp_path / "o").read_bytes() == src.read_bytes()


def test_empty_file(tmp_path):
    src = tmp_path / "empty"
    src.write_bytes(b"")
    _enc(src, tmp_path / "e", password="pw")
    assert (tmp_path / "e").stat().st_size == nc.HEADER_SIZE + nc.TAG_SIZE
    nc.decrypt_file(tmp_path / "e", tmp_path / "o", password="pw")
    assert (tmp_path / "o").read_bytes() == b""


def test_wrong_password_fails(big, tmp_path):
    enc, out = tmp_path / "v.nenc", tmp_path / "v.out"
    _enc(big, enc, password="right")
    with pytest.raises(DecryptionError):
        nc.decrypt_file(enc, out, password="wrong")
    assert not out.exists()  # no partial plaintext left behind


@pytest.mark.parametrize("where", ["header_salt", "first_chunk", "middle_chunk", "last_tag"])
def test_tampered_byte_fails(big, tmp_path, where):
    enc, out = tmp_path / "v.nenc", tmp_path / "v.out"
    _enc(big, enc, password="pw")
    b = bytearray(enc.read_bytes())
    pos = {
        "header_salt": 30,
        "first_chunk": nc.HEADER_SIZE + 5,
        "middle_chunk": nc.HEADER_SIZE + 5 * (CHUNK + 16) + 100,
        "last_tag": len(b) - 1,
    }[where]
    b[pos] ^= 0x01
    enc.write_bytes(bytes(b))
    with pytest.raises(DecryptionError):
        nc.decrypt_file(enc, out, password="pw")
    assert not out.exists()


def test_tampered_chunk_size_header_fails(big, tmp_path):
    enc = tmp_path / "v.nenc"
    _enc(big, enc, password="pw")
    b = bytearray(enc.read_bytes())
    b[nc.HEADER_SIZE - 1] ^= 0x10  # chunk_size field
    enc.write_bytes(bytes(b))
    with pytest.raises(DecryptionError):
        nc.decrypt_file(enc, tmp_path / "o", password="pw")


@pytest.mark.parametrize("cut", ["chunk_boundary", "mid_chunk", "drop_last_chunk", "header_only"])
def test_truncated_fails(big, tmp_path, cut):
    enc, out = tmp_path / "v.nenc", tmp_path / "v.out"
    _enc(big, enc, password="pw")
    b = enc.read_bytes()
    n = {
        "chunk_boundary": nc.HEADER_SIZE + 3 * (CHUNK + 16),
        "mid_chunk": len(b) - 5000,
        "drop_last_chunk": nc.HEADER_SIZE + 9 * (CHUNK + 16),  # 10 chunks total
        "header_only": nc.HEADER_SIZE,
    }[cut]
    enc.write_bytes(b[:n])
    with pytest.raises(DecryptionError):
        nc.decrypt_file(enc, out, password="pw")
    assert not out.exists()


def test_reordered_chunks_fail(tmp_path):
    src = tmp_path / "s"
    src.write_bytes(os.urandom(4 * 4096))
    _enc(src, tmp_path / "e", password="pw", chunk_size=4096)
    b = (tmp_path / "e").read_bytes()
    h, rec = nc.HEADER_SIZE, 4096 + 16
    c = [b[h + i * rec: h + (i + 1) * rec] for i in range(4)]
    (tmp_path / "e").write_bytes(b[:h] + c[1] + c[0] + c[2] + c[3])
    with pytest.raises(DecryptionError):
        nc.decrypt_file(tmp_path / "e", tmp_path / "o", password="pw")


def test_session_key_mode(big, tmp_path):
    key = nc.generate_session_key()
    enc, out = tmp_path / "v.nenc", tmp_path / "v.out"
    nc.encrypt_file(big, enc, key=key, chunk_size=CHUNK)
    nc.decrypt_file(enc, out, key=key)
    assert out.read_bytes() == big.read_bytes()
    with pytest.raises(DecryptionError):
        nc.decrypt_file(enc, tmp_path / "x", key=nc.generate_session_key())
    with pytest.raises(DecryptionError):  # key-mode file can't be opened with a password
        nc.decrypt_file(enc, tmp_path / "x", password="pw")


def test_streams_in_memory():
    data = os.urandom(300_000)
    buf = io.BytesIO()
    nc.encrypt_stream(io.BytesIO(data), buf, password="pw", chunk_size=65536, **FAST)
    out = io.BytesIO()
    nc.decrypt_stream(io.BytesIO(buf.getvalue()), out, password="pw")
    assert out.getvalue() == data


def test_same_input_gives_different_ciphertext(tmp_path):
    src = tmp_path / "s"
    src.write_bytes(b"x" * 1000)
    _enc(src, tmp_path / "a", password="pw")
    _enc(src, tmp_path / "b", password="pw")
    assert (tmp_path / "a").read_bytes() != (tmp_path / "b").read_bytes()


def test_bad_arguments(tmp_path):
    src = tmp_path / "s"
    src.write_bytes(b"x")
    with pytest.raises(NitrateCryptoError):
        nc.encrypt_file(src, tmp_path / "e")  # neither
    with pytest.raises(NitrateCryptoError):
        nc.encrypt_file(src, tmp_path / "e", password="a", key=b"\0" * 32)  # both
    with pytest.raises(NitrateCryptoError):
        nc.encrypt_file(src, tmp_path / "e", key=b"short")


def test_not_a_nitrate_file(tmp_path):
    p = tmp_path / "plain.mp4"
    p.write_bytes(os.urandom(500))
    with pytest.raises(DecryptionError):
        nc.decrypt_file(p, tmp_path / "o", password="pw")


@pytest.mark.skipif(not nc.HAVE_ARGON2, reason="argon2-cffi not installed")
def test_argon2id_roundtrip(tmp_path):
    src = tmp_path / "s"
    src.write_bytes(os.urandom(50_000))
    nc.encrypt_file(src, tmp_path / "e", password="pw", kdf="argon2id",
                    kdf_params={"time_cost": 1, "memory_cost": 8192, "parallelism": 1})
    nc.decrypt_file(tmp_path / "e", tmp_path / "o", password="pw")
    assert (tmp_path / "o").read_bytes() == src.read_bytes()


def test_default_kdf_is_scrypt(tmp_path):
    """Default encrypt (no kdf=) must use scrypt, even if argon2id is installed."""
    src = tmp_path / "s"
    src.write_bytes(b"hello")
    nc.encrypt_file(src, tmp_path / "e", password="pw")
    header = (tmp_path / "e").read_bytes()[: nc.HEADER_SIZE]
    _magic, _ver, kdf_id, a, b, c, _salt, _nonce, _cs = nc._HEADER.unpack(header)
    assert kdf_id == nc.KDF_SCRYPT
    assert (a, b, c) == (nc.SCRYPT_DEFAULT["n"], nc.SCRYPT_DEFAULT["r"], nc.SCRYPT_DEFAULT["p"])
    nc.decrypt_file(tmp_path / "e", tmp_path / "o", password="pw")
    assert (tmp_path / "o").read_bytes() == b"hello"


def test_default_scrypt_params_work(tmp_path):
    """The real default (n=2**17) must run within hashlib's memory limit."""
    src = tmp_path / "s"
    src.write_bytes(b"hello")
    nc.encrypt_file(src, tmp_path / "e", password="pw", kdf="scrypt")
    nc.decrypt_file(tmp_path / "e", tmp_path / "o", password="pw")
    assert (tmp_path / "o").read_bytes() == b"hello"


def test_cli_roundtrip(tmp_path, monkeypatch):
    from nitrate_crypto.__main__ import main
    src = tmp_path / "s"
    src.write_bytes(os.urandom(20_000))
    monkeypatch.setattr("getpass.getpass", lambda prompt="": "pw")
    main(["encrypt", str(src), str(tmp_path / "e"), "--kdf", "scrypt", "--low-memory"])
    main(["decrypt", str(tmp_path / "e"), str(tmp_path / "o")])
    assert (tmp_path / "o").read_bytes() == src.read_bytes()
