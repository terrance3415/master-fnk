"""CLI:  python -m nitrate_crypto encrypt|decrypt IN OUT [options]

The password is read with getpass (never from argv, so it stays out of shell
history). --key-file reads a raw 32-byte session key instead.
"""

import argparse
import getpass
import sys

from . import (
    SCRYPT_LOW_MEMORY,
    NitrateCryptoError,
    decrypt_file,
    encrypt_file,
)

_DESCRIPTION = """Encrypt or decrypt a video on this device before you store it.

If you omit --key-file, it prompts for a password.
The output holds only ciphertext (no thumbnails or metadata).
A wrong password or a tampered file fails with a clear error.
"""

_EPILOG = """examples:
  python -m nitrate_crypto encrypt video.mp4 video.enc
  python -m nitrate_crypto decrypt video.enc video.mp4
  python -m nitrate_crypto encrypt video.mp4 video.enc --key-file session.key
"""


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_help(sys.stderr)
        sys.stderr.write(f"\nerror: {message}\n")
        self.exit(2)


def _read_key(path):
    with open(path, "rb") as f:
        k = f.read()
    if len(k) != 32:
        sys.exit("key file must contain exactly 32 raw bytes")
    return k


def main(argv=None):
    ap = _Parser(
        prog="python -m nitrate_crypto",
        description=_DESCRIPTION,
        epilog=_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "mode",
        choices=["encrypt", "decrypt"],
        help="encrypt seals the file; decrypt opens it",
    )
    ap.add_argument("inp", metavar="IN", help="input file path")
    ap.add_argument("out", metavar="OUT", help="output file path")
    ap.add_argument(
        "--key-file",
        metavar="KEY_FILE",
        help="raw 32-byte session key file instead of a password prompt",
    )
    ap.add_argument(
        "--kdf",
        default="scrypt",
        choices=["scrypt", "argon2id", "auto"],
        help="encrypt only (default: scrypt; argon2id is optional)",
    )
    ap.add_argument(
        "--low-memory",
        action="store_true",
        help="encrypt only: lighter scrypt (~32 MiB) for Termux / low-RAM phones",
    )
    ap.add_argument(
        "--chunk-mib",
        metavar="CHUNK_MIB",
        type=int,
        default=1,
        help="encrypt only: chunk size in MiB (1-4, default 1)",
    )
    a = ap.parse_args(argv)

    key = password = None
    if a.key_file:
        key = _read_key(a.key_file)
    else:
        password = getpass.getpass("Password: ")
        if a.mode == "encrypt" and getpass.getpass("Repeat password: ") != password:
            sys.exit("passwords do not match")
        if not password:
            sys.exit("empty password")

    try:
        if a.mode == "encrypt":
            opts = {"chunk_size": a.chunk_mib * 1024 * 1024}
            if password is not None:
                kdf = "scrypt" if a.low_memory else a.kdf
                opts["kdf"] = kdf
                if a.low_memory:
                    opts["kdf_params"] = SCRYPT_LOW_MEMORY
            encrypt_file(a.inp, a.out, password=password, key=key, **opts)
        else:
            decrypt_file(a.inp, a.out, password=password, key=key)
    except NitrateCryptoError as e:
        sys.exit(f"error: {e}")
    print(f"{a.mode}ed -> {a.out}")


if __name__ == "__main__":
    main()
