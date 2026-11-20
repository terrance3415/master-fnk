package com.terrance.nitrate

import java.io.File

/**
 * Tiny driver used by the cross-compatibility tests.
 *
 *   encrypt IN OUT --password PW [--n N] [--r R] [--p P] [--chunk-size N] [--kdf scrypt|argon2id] [--low-memory]
 *   encrypt IN OUT --key-file KEY
 *   decrypt IN OUT --password PW
 *   decrypt IN OUT --key-file KEY
 */
fun main(args: Array<String>) {
    if (args.isEmpty()) {
        System.err.println("usage: encrypt|decrypt IN OUT (--password PW | --key-file KEY) [options]")
        kotlin.system.exitProcess(2)
    }
    val mode = args[0]
    val rest = args.drop(1).toMutableList()
    fun take(): String = if (rest.isNotEmpty()) rest.removeAt(0) else error("missing argument")
    fun opt(name: String): String? {
        val i = rest.indexOf(name)
        if (i < 0) return null
        rest.removeAt(i)
        return if (i < rest.size) rest.removeAt(i) else error("missing value for $name")
    }
    fun flag(name: String): Boolean {
        val i = rest.indexOf(name)
        if (i < 0) return false
        rest.removeAt(i)
        return true
    }
    val input = File(take())
    val output = File(take())
    val password = opt("--password")
    val keyFile = opt("--key-file")
    val key = keyFile?.let { File(it).readBytes() }
    when (mode) {
        "encrypt" -> {
            val n = opt("--n")?.toInt()
            val r = opt("--r")?.toInt() ?: 8
            val p = opt("--p")?.toInt() ?: 1
            val chunk = opt("--chunk-size")?.toInt() ?: NitrateCrypto.DEFAULT_CHUNK_SIZE
            val kdf = opt("--kdf") ?: "scrypt"
            val low = flag(" --low-memory".trim()) || flag("--low-memory")
            val scrypt = if (n != null) NitrateCrypto.ScryptParams(n, r, p) else NitrateCrypto.ScryptParams.Default
            NitrateCrypto.encryptFile(
                input, output, password = password, key = key,
                kdf = kdf, scrypt = scrypt, chunkSize = chunk, lowMemory = low,
            )
        }
        "decrypt" -> NitrateCrypto.decryptFile(input, output, password = password, key = key)
        else -> {
            System.err.println("unknown mode $mode")
            kotlin.system.exitProcess(2)
        }
    }
}
