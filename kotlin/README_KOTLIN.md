# Nitrate `.nenc` for Android (Kotlin)

A Kotlin implementation of the same `.nenc` v1 format as the Python `nitrate_crypto` module. Files written here can be opened by `python -m nitrate_crypto decrypt`, and files Python writes can be opened here.

The Android app already compiles `kotlin/src/com/terrance/nitrate/NitrateCrypto.kt` (package `com.terrance.nitrate`). You do not need to copy it again.

AES-256-GCM uses `javax.crypto` (`AES/GCM/NoPadding`, 128-bit tag). Bouncy Castle is only used for scrypt and optional argon2id.

```kotlin
dependencies {
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
}
```

On a phone, pass `lowMemory = true` (scrypt n=2^15, about 32 MB) instead of the default n=2^17 (about 128 MB). The app does this for every file it locks.

Header size is 54 bytes. The Python comment that used to say 61 was wrong.

```bash
python3 kotlin/tests/run_cross_compat.py
```

That checks Python to Kotlin and Kotlin to Python for scrypt passwords and a 32-byte session key.
