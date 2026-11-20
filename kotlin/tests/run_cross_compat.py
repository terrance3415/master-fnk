#!/usr/bin/env python3
"""Cross-check Kotlin NitrateCrypto against the Python nitrate_crypto module."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_ROOT = ROOT.parent
KOTLINC = Path("/tmp/kt-tools/kotlinc/bin/kotlinc")
BCPROV = ROOT / "lib" / "bcprov-jdk18on-1.80.jar"
SRC = ROOT / "src" / "com" / "terrance" / "nitrate" / "NitrateCrypto.kt"
BCPROV_URL = "https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/1.80/bcprov-jdk18on-1.80.jar"
JAR = Path("/tmp/nitrate-crypto-kotlin-tests.jar")

sys.path.insert(0, str(PY_ROOT))
import nitrate_crypto as nc  # noqa: E402


def run(cmd, check=True):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def ensure_bcprov():
    if BCPROV.exists():
        return
    BCPROV.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {BCPROV_URL}")
    import urllib.request
    urllib.request.urlretrieve(BCPROV_URL, BCPROV)


def compile_cli():
    if not KOTLINC.exists():
        # Fall back to kotlinc on PATH (CI / dev machines).
        global KOTLINC
        found = shutil.which("kotlinc")
        if not found:
            sys.exit(f"kotlinc not found at {KOTLINC} and not on PATH")
        KOTLINC = Path(found)
    ensure_bcprov()
    src = [SRC, ROOT / "tests" / "NitrateCryptoCli.kt"]
    cmd = [str(KOTLINC), *[str(s) for s in src], "-cp", str(BCPROV), "-include-runtime", "-d", str(JAR)]
    r = run(cmd)
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        sys.exit(f"kotlinc failed: {r.returncode}")
    if r.stderr:
        # kotlinc -version style info only; still print warnings
        sys.stderr.write(r.stderr)


def kt(args, check=True):
    cmd = ["java", "-cp", f"{JAR}:{BCPROV}", "com.terrance.nitrate.NitrateCryptoCliKt", *args]
    return run(cmd, check=check)


def write_key(path: Path, key: bytes):
    path.write_bytes(key)


def main() -> int:
    compile_cli()
    failed = []
    passed = 0

    def check(name, cond, detail=""):
        nonlocal passed
        if cond:
            passed += 1
            print(f"PASS  {name}")
        else:
            failed.append(name)
            print(f"FAIL  {name}  {detail}")

    with tempfile.TemporaryDirectory(prefix="nenc-xcompat-") as td:
        d = Path(td)
        # A few sizes: empty, mid-chunk, exact 2 chunks, multi-chunk leftover
        plains = {
            "empty": b"",
            "small": os.urandom(1000),
            "two_exact": os.urandom(8192),
            "multi": os.urandom(20_000),
        }
        chunk = 4096
        fast = nc.SCRYPT_DEFAULT  # will override
        scrypt_kw = dict(kdf="scrypt", kdf_params={"n": 2**10, "r": 8, "p": 1}, chunk_size=chunk)
        password = "correct horse"
        key = nc.generate_session_key()
        write_key(d / "session.key", key)

        # 1 + 2: Python encrypt -> Kotlin decrypt, both modes, several sizes
        for label, data in plains.items():
            src = d / f"{label}.bin"
            src.write_bytes(data)

            py_pw = d / f"{label}.py.pw.nenc"
            out = d / f"{label}.kt.from_py.pw"
            nc.encrypt_file(src, py_pw, password=password, **scrypt_kw)
            r = kt(["decrypt", str(py_pw), str(out), "--password", password])
            check(
                f"python-encrypt/kotlin-decrypt scrypt {label}",
                r.returncode == 0 and out.exists() and out.read_bytes() == data,
                f"rc={r.returncode} stderr={r.stderr!r} size={out.stat().st_size if out.exists() else 'missing'}",
            )

            py_key = d / f"{label}.py.key.nenc"
            outk = d / f"{label}.kt.from_py.key"
            nc.encrypt_file(src, py_key, key=key, chunk_size=chunk)
            r = kt(["decrypt", str(py_key), str(outk), "--key-file", str(d / "session.key")])
            check(
                f"python-encrypt/kotlin-decrypt session-key {label}",
                r.returncode == 0 and outk.exists() and outk.read_bytes() == data,
                f"rc={r.returncode} stderr={r.stderr!r}",
            )

            # Kotlin encrypt -> Python decrypt
            kt_pw = d / f"{label}.kt.pw.nenc"
            outp = d / f"{label}.py.from_kt.pw"
            r = kt([
                "encrypt", str(src), str(kt_pw), "--password", password,
                "--n", "1024", "--r", "8", "--p", "1", "--chunk-size", str(chunk),
            ])
            try:
                nc.decrypt_file(kt_pw, outp, password=password)
                ok = outp.read_bytes() == data
                err = ""
            except Exception as e:
                ok = False
                err = repr(e)
            check(
                f"kotlin-encrypt/python-decrypt scrypt {label}",
                r.returncode == 0 and ok,
                f"rc={r.returncode} stderr={r.stderr!r} py={err}",
            )

            kt_key = d / f"{label}.kt.key.nenc"
            outpk = d / f"{label}.py.from_kt.key"
            r = kt(["encrypt", str(src), str(kt_key), "--key-file", str(d / "session.key"),
                    "--chunk-size", str(chunk)])
            try:
                nc.decrypt_file(kt_key, outpk, key=key)
                ok = outpk.read_bytes() == data
                err = ""
            except Exception as e:
                ok = False
                err = repr(e)
            check(
                f"kotlin-encrypt/python-decrypt session-key {label}",
                r.returncode == 0 and ok,
                f"rc={r.returncode} stderr={r.stderr!r} py={err}",
            )

        # Default scrypt params (n=2**17) on a tiny file, both directions
        src = d / "hello.bin"
        src.write_bytes(b"hello")
        py_def = d / "hello.py.default.nenc"
        nc.encrypt_file(src, py_def, password=password, kdf="scrypt")
        out = d / "hello.kt.from_py.default"
        r = kt(["decrypt", str(py_def), str(out), "--password", password])
        check(
            "python-encrypt/kotlin-decrypt scrypt default n=2**17",
            r.returncode == 0 and out.read_bytes() == b"hello",
            f"rc={r.returncode} stderr={r.stderr!r}",
        )
        kt_def = d / "hello.kt.default.nenc"
        outp = d / "hello.py.from_kt.default"
        r = kt(["encrypt", str(src), str(kt_def), "--password", password])  # default n
        try:
            nc.decrypt_file(kt_def, outp, password=password)
            ok = outp.read_bytes() == b"hello"
            err = ""
        except Exception as e:
            ok = False
            err = repr(e)
        check(
            "kotlin-encrypt/python-decrypt scrypt default n=2**17",
            r.returncode == 0 and ok,
            f"rc={r.returncode} stderr={r.stderr!r} py={err}",
        )

        # argon2id both ways, if Python has it
        if nc.HAVE_ARGON2:
            py_a = d / "hello.py.argon2.nenc"
            nc.encrypt_file(
                src, py_a, password=password, kdf="argon2id",
                kdf_params={"time_cost": 1, "memory_cost": 8192, "parallelism": 1},
            )
            out = d / "hello.kt.from_py.argon2"
            r = kt(["decrypt", str(py_a), str(out), "--password", password])
            check(
                "python-encrypt/kotlin-decrypt argon2id",
                r.returncode == 0 and out.read_bytes() == b"hello",
                f"rc={r.returncode} stderr={r.stderr!r}",
            )
            # Kotlin encrypt with argon2id via --kdf (uses default 64MiB; too heavy for a
            # quick test). Drive through a small-params path: reuse Python only if we
            # add CLI flags. Encode with Python-matched small params by a one-off:
            # we didn't expose argon2 time/memory flags. Skip kotlin->python argon2
            # with defaults (64 MiB) or add flags. Add a quick in-Python check later.
        else:
            print("SKIP  argon2id (argon2-cffi not installed in Python)")

        # Wrong password (Python file, Kotlin decrypt)
        src = d / "small.bin"
        py_pw = d / "small.py.pw.nenc"
        out = d / "wrong.out"
        r = kt(["decrypt", str(py_pw), str(out), "--password", "wrong"], check=False)
        check(
            "kotlin decrypt wrong password fails cleanly",
            r.returncode != 0 and (not out.exists() or out.stat().st_size == 0),
            f"rc={r.returncode} stderr={r.stderr!r} exists={out.exists()}",
        )

        # Tampered byte in first chunk
        tampered = d / "tampered.nenc"
        data = bytearray(py_pw.read_bytes())
        data[nc.HEADER_SIZE + 5] ^= 0x01
        tampered.write_bytes(data)
        out = d / "tampered.out"
        r = kt(["decrypt", str(tampered), str(out), "--password", password], check=False)
        check(
            "kotlin decrypt tampered byte fails cleanly",
            r.returncode != 0 and (not out.exists() or out.stat().st_size == 0),
            f"rc={r.returncode} stderr={r.stderr!r}",
        )

        # Wrong session key
        py_key = d / "small.py.key.nenc"
        bad = d / "bad.key"
        write_key(bad, nc.generate_session_key())
        out = d / "badkey.out"
        r = kt(["decrypt", str(py_key), str(out), "--key-file", str(bad)], check=False)
        check(
            "kotlin decrypt wrong session key fails cleanly",
            r.returncode != 0 and (not out.exists() or out.stat().st_size == 0),
            f"rc={r.returncode} stderr={r.stderr!r}",
        )

    print()
    print(f"{passed} passed, {len(failed)} failed")
    if failed:
        print("failed:", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
