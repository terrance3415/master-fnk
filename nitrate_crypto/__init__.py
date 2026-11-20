"""nitrate_crypto - client-side AES-256-GCM encryption layer for Nitrate videos.

Encrypt a video *before* it reaches any storage or server. Only ciphertext is
written: no thumbnails, no metadata, no preview frames, no filename, no
duration. The key comes from a user password (scrypt by default; argon2id is optional) or from a raw
32-byte session key, and is never stored anywhere by this module.

File format (".nenc"), all integers big-endian:

    header (54 bytes):
        magic      8s   b"NITRATE\\x00"
        version    B    1
        kdf_id     B    0 = raw key, 1 = scrypt, 2 = argon2id
        kdf_a      I    scrypt: n        argon2id: time_cost    raw: 0
        kdf_b      I    scrypt: r        argon2id: memory KiB   raw: 0
        kdf_c      I    scrypt: p        argon2id: parallelism  raw: 0
        salt       16s  random (unused for raw key)
        base_nonce 12s  random per file
        chunk_size I    plaintext bytes per chunk
    chunks:
        AES-256-GCM(ciphertext || 16-byte tag) for each plaintext chunk.
        Every chunk except the last holds exactly chunk_size plaintext bytes;
        the last holds 0..chunk_size bytes (an empty file = one empty chunk).

    nonce_i = base_nonce XOR i  (i = chunk index in the low 8 bytes)
    aad_i   = header || uint64(i) || uint8(is_final)

Binding the whole header into every chunk's AAD means changing any KDF param,
salt or chunk size breaks decryption. Binding (i, is_final) stops chunk
reordering, dropping and truncation: a file cut at a chunk boundary ends on a
chunk that was sealed with is_final=0, so its tag fails.

Wrong password/key or any tampering raises ``DecryptionError``.
"""

from __future__ import annotations

import hashlib
import os
import struct
import tempfile
from typing import BinaryIO, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

try:  # optional alternative KDF; scrypt is the default
    from argon2.low_level import Type as _Argon2Type, hash_secret_raw as _argon2_raw

    HAVE_ARGON2 = True
except ImportError:  # pragma: no cover - depends on environment
    HAVE_ARGON2 = False

__all__ = [
    "encrypt_file",
    "decrypt_file",
    "encrypt_stream",
    "decrypt_stream",
    "derive_key",
    "generate_session_key",
    "NitrateCryptoError",
    "DecryptionError",
    "SCRYPT_DEFAULT",
    "SCRYPT_LOW_MEMORY",
    "ARGON2_DEFAULT",
    "DEFAULT_CHUNK_SIZE",
    "HAVE_ARGON2",
]

MAGIC = b"NITRATE\x00"
VERSION = 1
KDF_RAW, KDF_SCRYPT, KDF_ARGON2ID = 0, 1, 2

_HEADER = struct.Struct(">8sBBIII16s12sI")
HEADER_SIZE = _HEADER.size  # 61
KEY_SIZE = 32
TAG_SIZE = 16
SALT_SIZE = 16
NONCE_SIZE = 12

DEFAULT_CHUNK_SIZE = 1024 * 1024  # 1 MiB
MAX_CHUNK_SIZE = 64 * 1024 * 1024

# scrypt n=2**17,r=8,p=1 uses ~128 MiB RAM and ~0.3-1 s on a laptop.
SCRYPT_DEFAULT = {"n": 2**17, "r": 8, "p": 1}
# For Termux / old phones / low-RAM Chromebooks: ~32 MiB.
SCRYPT_LOW_MEMORY = {"n": 2**15, "r": 8, "p": 1}
# argon2id: 3 passes over 64 MiB.
ARGON2_DEFAULT = {"time_cost": 3, "memory_cost": 64 * 1024, "parallelism": 1}

# Refuse absurd params from a (possibly hostile) header: avoid memory bombs.
_MAX_KDF_MEMORY = 1024 * 1024 * 1024  # 1 GiB


class NitrateCryptoError(Exception):
    """Base error."""


class DecryptionError(NitrateCryptoError):
    """Wrong password/key, tampered, truncated or corrupt ciphertext."""


# --------------------------------------------------------------------------- keys


def generate_session_key() -> bytes:
    """Return a fresh random 32-byte key (for session-key mode)."""
    return os.urandom(KEY_SIZE)


def _scrypt(password: bytes, salt: bytes, n: int, r: int, p: int) -> bytes:
    if n < 2 or n & (n - 1):
        raise NitrateCryptoError("scrypt n must be a power of two >= 2")
    mem = 128 * r * n * p + 128 * r * n + 1024 * 1024
    if 128 * r * n > _MAX_KDF_MEMORY:
        raise NitrateCryptoError("scrypt params exceed memory limit")
    return hashlib.scrypt(password, salt=salt, n=n, r=r, p=p, maxmem=mem, dklen=KEY_SIZE)


def _argon2id(password: bytes, salt: bytes, t: int, m: int, p: int) -> bytes:
    if not HAVE_ARGON2:
        raise NitrateCryptoError(
            "this file uses argon2id; install it with: pip install argon2-cffi"
        )
    if m * 1024 > _MAX_KDF_MEMORY:
        raise NitrateCryptoError("argon2 params exceed memory limit")
    return _argon2_raw(
        password, salt, time_cost=t, memory_cost=m, parallelism=p,
        hash_len=KEY_SIZE, type=_Argon2Type.ID,
    )


def _to_bytes(password) -> bytes:
    if isinstance(password, str):
        return password.encode("utf-8")
    if isinstance(password, (bytes, bytearray)):
        return bytes(password)
    raise TypeError("password must be str or bytes")


def derive_key(password, salt: bytes, kdf_id: int, a: int, b: int, c: int) -> bytes:
    """Derive a 32-byte key from a password with the given KDF params."""
    pw = _to_bytes(password)
    if not pw:
        raise NitrateCryptoError("empty password")
    if kdf_id == KDF_SCRYPT:
        return _scrypt(pw, salt, a, b, c)
    if kdf_id == KDF_ARGON2ID:
        return _argon2id(pw, salt, a, b, c)
    raise NitrateCryptoError(f"unknown KDF id {kdf_id}")


def _pick_kdf(kdf: str, kdf_params: Optional[dict]):
    if kdf == "auto":
        kdf = "scrypt"
    if kdf == "scrypt":
        prm = dict(SCRYPT_DEFAULT, **(kdf_params or {}))
        return KDF_SCRYPT, prm["n"], prm["r"], prm["p"]
    if kdf == "argon2id":
        if not HAVE_ARGON2:
            raise NitrateCryptoError("argon2id requested but argon2-cffi is not installed")
        prm = dict(ARGON2_DEFAULT, **(kdf_params or {}))
        return KDF_ARGON2ID, prm["time_cost"], prm["memory_cost"], prm["parallelism"]
    raise NitrateCryptoError(f"unknown kdf {kdf!r} (use 'scrypt', 'argon2id' or 'auto')")


def _check_secret(password, key):
    if (password is None) == (key is None):
        raise NitrateCryptoError("pass exactly one of password= or key=")
    if key is not None and (not isinstance(key, (bytes, bytearray)) or len(key) != KEY_SIZE):
        raise NitrateCryptoError("key must be exactly 32 bytes")


# ------------------------------------------------------------------- chunk helpers


def _nonce(base: bytes, index: int) -> bytes:
    if index >= 2**64:
        raise NitrateCryptoError("too many chunks")
    tail = int.from_bytes(base[4:], "big") ^ index
    return base[:4] + tail.to_bytes(8, "big")


def _aad(header: bytes, index: int, final: bool) -> bytes:
    return header + struct.pack(">QB", index, 1 if final else 0)


def _read_exact(f: BinaryIO, n: int) -> bytes:
    """Read up to n bytes, looping over short reads (pipes, sockets)."""
    buf = bytearray()
    while len(buf) < n:
        part = f.read(n - len(buf))
        if not part:
            break
        buf += part
    return bytes(buf)


# ------------------------------------------------------------------------ streams


def encrypt_stream(
    src: BinaryIO,
    dst: BinaryIO,
    password=None,
    key: Optional[bytes] = None,
    *,
    kdf: str = "scrypt",
    kdf_params: Optional[dict] = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> None:
    """Encrypt everything readable from ``src`` into ``dst`` (binary file objects)."""
    _check_secret(password, key)
    if not 1 <= chunk_size <= MAX_CHUNK_SIZE:
        raise NitrateCryptoError(f"chunk_size must be 1..{MAX_CHUNK_SIZE}")

    salt = os.urandom(SALT_SIZE)
    base_nonce = os.urandom(NONCE_SIZE)
    if key is not None:
        kdf_id, a, b, c = KDF_RAW, 0, 0, 0
        k = bytes(key)
    else:
        kdf_id, a, b, c = _pick_kdf(kdf, kdf_params)
        k = derive_key(password, salt, kdf_id, a, b, c)

    header = _HEADER.pack(MAGIC, VERSION, kdf_id, a, b, c, salt, base_nonce, chunk_size)
    aes = AESGCM(k)
    dst.write(header)

    index = 0
    cur = _read_exact(src, chunk_size)
    while True:
        nxt = _read_exact(src, chunk_size) if len(cur) == chunk_size else b""
        final = not nxt
        dst.write(aes.encrypt(_nonce(base_nonce, index), cur, _aad(header, index, final)))
        if final:
            break
        cur = nxt
        index += 1


def _parse_header(header: bytes):
    if len(header) < HEADER_SIZE:
        raise DecryptionError("file too short / not a Nitrate encrypted file")
    magic, ver, kdf_id, a, b, c, salt, base_nonce, chunk_size = _HEADER.unpack(header)
    if magic != MAGIC:
        raise DecryptionError("not a Nitrate encrypted file (bad magic)")
    if ver != VERSION:
        raise DecryptionError(f"unsupported format version {ver}")
    if not 1 <= chunk_size <= MAX_CHUNK_SIZE:
        raise DecryptionError("corrupt header (chunk size)")
    return kdf_id, a, b, c, salt, base_nonce, chunk_size


def decrypt_stream(
    src: BinaryIO,
    dst: BinaryIO,
    password=None,
    key: Optional[bytes] = None,
) -> None:
    """Decrypt a .nenc stream from ``src`` into ``dst``.

    Raises DecryptionError on a wrong key or any tampering/truncation. Chunks
    are verified one at a time, so on failure ``dst`` may already hold some
    verified plaintext; ``decrypt_file`` handles that by writing to a temp file
    and only renaming it into place after the whole file verifies.
    """
    _check_secret(password, key)
    header = _read_exact(src, HEADER_SIZE)
    kdf_id, a, b, c, salt, base_nonce, chunk_size = _parse_header(header)

    if kdf_id == KDF_RAW:
        if key is None:
            raise DecryptionError("this file was encrypted with a session key, not a password")
        k = bytes(key)
    else:
        if password is None:
            raise DecryptionError("this file was encrypted with a password, not a session key")
        k = derive_key(password, salt, kdf_id, a, b, c)

    aes = AESGCM(k)
    rec = chunk_size + TAG_SIZE
    index = 0
    cur = _read_exact(src, rec)
    while True:
        if len(cur) < TAG_SIZE:
            raise DecryptionError("truncated or corrupt file")
        nxt = _read_exact(src, rec) if len(cur) == rec else b""
        final = not nxt
        try:
            pt = aes.decrypt(_nonce(base_nonce, index), cur, _aad(header, index, final))
        except InvalidTag:
            if index == 0:
                raise DecryptionError(
                    "decryption failed: wrong password/key, or the file was modified"
                ) from None
            raise DecryptionError(
                f"decryption failed at chunk {index}: file was modified or truncated"
            ) from None
        dst.write(pt)
        if final:
            return
        cur = nxt
        index += 1


# -------------------------------------------------------------------------- files


def _atomic_write(out_path, fn):
    out_path = os.fspath(out_path)
    d = os.path.dirname(os.path.abspath(out_path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".nitrate-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as dst:
            fn(dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(tmp, out_path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def encrypt_file(in_path, out_path, password=None, key=None, **opts) -> None:
    """Encrypt ``in_path`` to ``out_path`` (conventionally ``*.nenc``).

    opts: kdf='scrypt'|'argon2id'|'auto' (auto means scrypt), kdf_params=dict, chunk_size=int.
    """
    _check_secret(password, key)
    with open(in_path, "rb") as src:
        _atomic_write(out_path, lambda dst: encrypt_stream(src, dst, password, key, **opts))


def decrypt_file(in_path, out_path, password=None, key=None) -> None:
    """Decrypt ``in_path`` to ``out_path``. Nothing is left at ``out_path`` on failure."""
    _check_secret(password, key)
    with open(in_path, "rb") as src:
        _atomic_write(out_path, lambda dst: decrypt_stream(src, dst, password, key))
