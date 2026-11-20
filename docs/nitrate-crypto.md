# Client-side video encryption (`nitrate_crypto`)

Optional tool. You do not need it to use the Master FNK phone studio. It encrypts a video on your own device with AES-256-GCM before the file is stored or shared. The output is an opaque `.nenc` (or `.enc`) file.

- Ciphertext only. No thumbnails, no filename, no duration. The 54-byte header holds only what decryption needs: magic and version, KDF parameters, salt, base nonce, and chunk size.
- The key comes from your password with scrypt, or from a raw 32-byte session key. argon2id is optional when `argon2-cffi` is installed. The key is never written by this module.
- A wrong password, a flipped byte, reordered chunks, or a cut-off file fails with `DecryptionError`. `decrypt_file` does not leave a partial plaintext file behind.
- Data is sealed in 1 MiB chunks (the CLI allows 1–4 MiB).

The header is 54 bytes. `struct.Struct(">8sBBIII16s12sI").size` is 54.

## Install

```bash
python -m pip install cryptography
```

On Termux: `pkg install python python-cryptography`. Optional: `pip install argon2-cffi`.

`nitrate_crypto/` lives at the repository root, next to `remaster/`. The desktop test job installs `cryptography` from `requirements.txt`.

## Use it

```bash
python -m nitrate_crypto encrypt video.mp4 video.nenc
python -m nitrate_crypto decrypt video.nenc video.mp4
python -m nitrate_crypto encrypt video.mp4 video.nenc --low-memory
python -m nitrate_crypto encrypt video.mp4 video.nenc --key-file session.key
```

`--low-memory` uses scrypt n=2^15 (about 32 MB) so a phone can open the file. The default n=2^17 needs about 128 MB.

```python
import nitrate_crypto as nc

nc.encrypt_file("clip.mp4", "clip.nenc", password=pw, kdf_params=nc.SCRYPT_LOW_MEMORY)
nc.decrypt_file("clip.nenc", "clip.mp4", password=pw)
```

The Android app (`android/`) and the phone studio share sheet write this same format with the lighter scrypt. The Kotlin source is `kotlin/src/com/terrance/nitrate/NitrateCrypto.kt`.

**Lose the password or key and the video cannot be opened. There is no backdoor.**

## KDF

| Setting | Params | RAM |
|---|---|---|
| scrypt default | n=2**17, r=8, p=1 | ~128 MiB |
| scrypt low-memory | n=2**15, r=8, p=1 | ~32 MiB |
| argon2id (optional) | t=3, m=64 MiB, p=1 | 64 MiB |

Parameters are stored in the header, so a file made on a computer opens on the phone when the phone has the RAM.

## Tests

```bash
python -m pytest tests/test_nitrate_crypto.py -q
```
