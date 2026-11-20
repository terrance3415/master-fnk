package com.terrance.nitrate

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.generators.SCrypt
import org.bouncycastle.crypto.params.Argon2Parameters

/**
 * Byte-compatible implementation of the Nitrate `.nenc` v1 format used by the
 * Python `nitrate_crypto` module.
 *
 * Header is 54 bytes, all integers big-endian:
 *   magic 8 ("NITRATE\0") | version u8 (1) | kdf_id u8
 *   kdf_a, kdf_b, kdf_c u32 | salt 16 | base_nonce 12 | chunk_size u32
 *
 * kdf_id: 0 = raw 32-byte session key, 1 = scrypt (default), 2 = argon2id
 * For scrypt, (a,b,c) = (n, r, p). For argon2id, (time_cost, memory KiB, parallelism).
 *
 * Each chunk is AES-256-GCM (128-bit tag) over at most chunk_size plaintext
 * bytes. nonce_i = base_nonce with the low 8 bytes XOR the chunk index.
 * AAD_i = header || u64be(index) || u8(is_final).
 * The last chunk (including an empty file) is tagged is_final=1.
 */
object NitrateCrypto {
    const val HEADER_SIZE = 54
    const val KEY_SIZE = 32
    const val TAG_SIZE = 16
    const val SALT_SIZE = 16
    const val NONCE_SIZE = 12
    const val VERSION = 1
    const val KDF_RAW = 0
    const val KDF_SCRYPT = 1
    const val KDF_ARGON2ID = 2
    const val DEFAULT_CHUNK_SIZE = 1024 * 1024
    const val MAX_CHUNK_SIZE = 64 * 1024 * 1024
    const val SCRYPT_DEFAULT_N = 1 shl 17 // 2**17, ~128 MiB RAM
    const val SCRYPT_DEFAULT_R = 8
    const val SCRYPT_DEFAULT_P = 1
    const val SCRYPT_LOW_MEMORY_N = 1 shl 15 // 2**15, ~32 MiB RAM
    const val ARGON2_DEFAULT_TIME = 3
    const val ARGON2_DEFAULT_MEMORY_KIB = 64 * 1024
    const val ARGON2_DEFAULT_PARALLELISM = 1

    val MAGIC: ByteArray = byteArrayOf(
        'N'.code.toByte(), 'I'.code.toByte(), 'T'.code.toByte(), 'R'.code.toByte(),
        'A'.code.toByte(), 'T'.code.toByte(), 'E'.code.toByte(), 0,
    )

    private const val MAX_KDF_MEMORY = 1024L * 1024L * 1024L
    private val RANDOM = SecureRandom()

    data class ScryptParams(val n: Int = SCRYPT_DEFAULT_N, val r: Int = SCRYPT_DEFAULT_R, val p: Int = SCRYPT_DEFAULT_P) {
        companion object {
            val Default = ScryptParams()
            val LowMemory = ScryptParams(n = SCRYPT_LOW_MEMORY_N)
        }
    }

    data class Argon2idParams(
        val timeCost: Int = ARGON2_DEFAULT_TIME,
        val memoryKiB: Int = ARGON2_DEFAULT_MEMORY_KIB,
        val parallelism: Int = ARGON2_DEFAULT_PARALLELISM,
    ) {
        companion object {
            val Default = Argon2idParams()
        }
    }

    fun generateSessionKey(): ByteArray {
        val key = ByteArray(KEY_SIZE)
        RANDOM.nextBytes(key)
        return key
    }

    @JvmOverloads
    fun encryptStream(
        input: InputStream,
        output: OutputStream,
        password: String? = null,
        key: ByteArray? = null,
        kdf: String = "scrypt",
        scrypt: ScryptParams = ScryptParams.Default,
        argon2: Argon2idParams = Argon2idParams.Default,
        chunkSize: Int = DEFAULT_CHUNK_SIZE,
        lowMemory: Boolean = false,
    ) {
        checkSecret(password, key)
        if (chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
            throw NitrateCryptoException("chunk_size must be 1..$MAX_CHUNK_SIZE")
        }
        val salt = ByteArray(SALT_SIZE).also { RANDOM.nextBytes(it) }
        val baseNonce = ByteArray(NONCE_SIZE).also { RANDOM.nextBytes(it) }
        val kdfId: Int
        val a: Int
        val b: Int
        val c: Int
        val rawKey: ByteArray
        if (key != null) {
            kdfId = KDF_RAW
            a = 0; b = 0; c = 0
            rawKey = key.copyOf()
        } else {
            val name = if (kdf == "auto") "scrypt" else kdf
            when (name) {
                "scrypt" -> {
                    val prm = if (lowMemory) ScryptParams.LowMemory else scrypt
                    kdfId = KDF_SCRYPT
                    a = prm.n; b = prm.r; c = prm.p
                    rawKey = deriveKey(password!!, salt, kdfId, a, b, c)
                }
                "argon2id" -> {
                    kdfId = KDF_ARGON2ID
                    a = argon2.timeCost; b = argon2.memoryKiB; c = argon2.parallelism
                    rawKey = deriveKey(password!!, salt, kdfId, a, b, c)
                }
                else -> throw NitrateCryptoException("unknown kdf '$kdf' (use 'scrypt', 'argon2id' or 'auto')")
            }
        }
        val header = packHeader(kdfId, a, b, c, salt, baseNonce, chunkSize)
        output.write(header)

        var index = 0L
        var cur = readExact(input, chunkSize)
        while (true) {
            val nxt = if (cur.size == chunkSize) readExact(input, chunkSize) else ByteArray(0)
            val final = nxt.isEmpty()
            output.write(aesGcm(encrypt = true, rawKey, nonce(baseNonce, index), aad(header, index, final), cur))
            if (final) break
            cur = nxt
            index += 1
            if (index < 0) throw NitrateCryptoException("too many chunks")
        }
    }

    @JvmOverloads
    fun decryptStream(
        input: InputStream,
        output: OutputStream,
        password: String? = null,
        key: ByteArray? = null,
    ) {
        checkSecret(password, key)
        val header = readExact(input, HEADER_SIZE)
        if (header.size < HEADER_SIZE) {
            throw DecryptionException("file too short / not a Nitrate encrypted file")
        }
        val parsed = parseHeader(header)
        val rawKey: ByteArray = when (parsed.kdfId) {
            KDF_RAW -> {
                if (key == null) {
                    throw DecryptionException("this file was encrypted with a session key, not a password")
                }
                key.copyOf()
            }
            else -> {
                if (password == null) {
                    throw DecryptionException("this file was encrypted with a password, not a session key")
                }
                deriveKey(password, parsed.salt, parsed.kdfId, parsed.a, parsed.b, parsed.c)
            }
        }
        val rec = parsed.chunkSize + TAG_SIZE
        var index = 0L
        var cur = readExact(input, rec)
        while (true) {
            if (cur.size < TAG_SIZE) {
                throw DecryptionException("truncated or corrupt file")
            }
            val nxt = if (cur.size == rec) readExact(input, rec) else ByteArray(0)
            val final = nxt.isEmpty()
            val pt = try {
                aesGcm(encrypt = false, rawKey, nonce(parsed.baseNonce, index), aad(header, index, final), cur)
            } catch (e: DecryptionException) {
                if (index == 0L) {
                    throw DecryptionException("decryption failed: wrong password/key, or the file was modified")
                }
                throw DecryptionException("decryption failed at chunk $index: file was modified or truncated")
            }
            output.write(pt)
            if (final) return
            cur = nxt
            index += 1
        }
    }

    @JvmOverloads
    fun encryptFile(
        input: File,
        output: File,
        password: String? = null,
        key: ByteArray? = null,
        kdf: String = "scrypt",
        scrypt: ScryptParams = ScryptParams.Default,
        argon2: Argon2idParams = Argon2idParams.Default,
        chunkSize: Int = DEFAULT_CHUNK_SIZE,
        lowMemory: Boolean = false,
    ) {
        input.inputStream().use { ins ->
            output.outputStream().use { outs ->
                encryptStream(ins, outs, password, key, kdf, scrypt, argon2, chunkSize, lowMemory)
                outs.flush()
            }
        }
    }

    /**
     * Decrypt [input] into [output]. On failure the output file is deleted so
     * a partial plaintext file is not left behind. This does not use a
     * separate plaintext temp file.
     */
    @JvmOverloads
    fun decryptFile(
        input: File,
        output: File,
        password: String? = null,
        key: ByteArray? = null,
    ) {
        try {
            input.inputStream().use { ins ->
                output.outputStream().use { outs ->
                    decryptStream(ins, outs, password, key)
                    outs.flush()
                }
            }
        } catch (e: Exception) {
            if (output.exists() && !output.delete()) {
                output.writeBytes(ByteArray(0))
                output.delete()
            }
            throw e
        }
    }

    fun deriveKey(password: String, salt: ByteArray, kdfId: Int, a: Int, b: Int, c: Int): ByteArray {
        val pw = password.toByteArray(Charsets.UTF_8)
        try {
            if (pw.isEmpty()) throw NitrateCryptoException("empty password")
            return when (kdfId) {
                KDF_SCRYPT -> scrypt(pw, salt, a, b, c)
                KDF_ARGON2ID -> argon2id(pw, salt, a, b, c)
                else -> throw NitrateCryptoException("unknown KDF id $kdfId")
            }
        } finally {
            pw.fill(0)
        }
    }

    internal fun nonce(base: ByteArray, index: Long): ByteArray {
        val out = base.copyOf()
        var tail = 0L
        for (i in 4 until 12) {
            tail = (tail shl 8) or (base[i].toLong() and 0xffL)
        }
        tail = tail xor index
        for (i in 11 downTo 4) {
            out[i] = (tail and 0xffL).toByte()
            tail = tail ushr 8
        }
        return out
    }

    internal fun aad(header: ByteArray, index: Long, final: Boolean): ByteArray {
        val buf = ByteBuffer.allocate(header.size + 9).order(ByteOrder.BIG_ENDIAN)
        buf.put(header)
        buf.putLong(index)
        buf.put(if (final) 1 else 0)
        return buf.array()
    }

    private fun scrypt(password: ByteArray, salt: ByteArray, n: Int, r: Int, p: Int): ByteArray {
        if (n < 2 || (n and (n - 1)) != 0) {
            throw NitrateCryptoException("scrypt n must be a power of two >= 2")
        }
        if (128L * r * n > MAX_KDF_MEMORY) {
            throw NitrateCryptoException("scrypt params exceed memory limit")
        }
        return SCrypt.generate(password, salt, n, r, p, KEY_SIZE)
    }

    private fun argon2id(password: ByteArray, salt: ByteArray, timeCost: Int, memoryKiB: Int, parallelism: Int): ByteArray {
        if (memoryKiB.toLong() * 1024L > MAX_KDF_MEMORY) {
            throw NitrateCryptoException("argon2 params exceed memory limit")
        }
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withIterations(timeCost)
            .withMemoryAsKB(memoryKiB)
            .withParallelism(parallelism)
            .withSalt(salt)
            .build()
        val gen = Argon2BytesGenerator()
        gen.init(params)
        val out = ByteArray(KEY_SIZE)
        gen.generateBytes(password, out)
        return out
    }

    private fun packHeader(
        kdfId: Int, a: Int, b: Int, c: Int,
        salt: ByteArray, baseNonce: ByteArray, chunkSize: Int,
    ): ByteArray {
        val buf = ByteBuffer.allocate(HEADER_SIZE).order(ByteOrder.BIG_ENDIAN)
        buf.put(MAGIC)
        buf.put(VERSION.toByte())
        buf.put(kdfId.toByte())
        buf.putInt(a)
        buf.putInt(b)
        buf.putInt(c)
        buf.put(salt)
        buf.put(baseNonce)
        buf.putInt(chunkSize)
        return buf.array()
    }

    private data class Header(
        val kdfId: Int, val a: Int, val b: Int, val c: Int,
        val salt: ByteArray, val baseNonce: ByteArray, val chunkSize: Int,
    )

    private fun parseHeader(header: ByteArray): Header {
        val buf = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN)
        val magic = ByteArray(8)
        buf.get(magic)
        if (!magic.contentEquals(MAGIC)) {
            throw DecryptionException("not a Nitrate encrypted file (bad magic)")
        }
        val ver = buf.get().toInt() and 0xff
        if (ver != VERSION) {
            throw DecryptionException("unsupported format version $ver")
        }
        val kdfId = buf.get().toInt() and 0xff
        val a = buf.int
        val b = buf.int
        val c = buf.int
        val salt = ByteArray(SALT_SIZE).also { buf.get(it) }
        val baseNonce = ByteArray(NONCE_SIZE).also { buf.get(it) }
        val chunkSize = buf.int
        if (chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
            throw DecryptionException("corrupt header (chunk size)")
        }
        return Header(kdfId, a, b, c, salt, baseNonce, chunkSize)
    }

    private fun checkSecret(password: String?, key: ByteArray?) {
        if ((password == null) == (key == null)) {
            throw NitrateCryptoException("pass exactly one of password= or key=")
        }
        if (key != null && key.size != KEY_SIZE) {
            throw NitrateCryptoException("key must be exactly 32 bytes")
        }
    }

    private fun aesGcm(encrypt: Boolean, key: ByteArray, nonce: ByteArray, aad: ByteArray, data: ByteArray): ByteArray {
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(TAG_SIZE * 8, nonce),
            )
            cipher.updateAAD(aad)
            cipher.doFinal(data)
        } catch (e: AEADBadTagException) {
            throw DecryptionException("AEAD tag check failed", e)
        } catch (e: javax.crypto.BadPaddingException) {
            // Some providers surface a failed tag as BadPaddingException.
            throw DecryptionException("AEAD tag check failed", e)
        }
    }

    private fun readExact(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r < 0) break
            off += r
        }
        return if (off == n) buf else buf.copyOf(off)
    }
}

open class NitrateCryptoException(message: String, cause: Throwable? = null) : Exception(message, cause)

class DecryptionException(message: String, cause: Throwable? = null) : NitrateCryptoException(message, cause)
