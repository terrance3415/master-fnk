package com.terrance.masterfnk

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.StatFs
import android.provider.OpenableColumns
import android.view.View
import android.widget.MediaController
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.VideoView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.terrance.nitrate.DecryptionException
import com.terrance.nitrate.NitrateCrypto
import java.io.File
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private val io = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "nitrate").apply { isDaemon = true }
    }
    private var playback: File? = null
    private var pendingPlain: Uri? = null

    private val openLocked = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) askPassword(confirm = false) { password -> decryptAndPlay(uri, password) }
    }
    private val openPlain = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) askPassword(confirm = true) { password ->
            pendingPlain = uri
            createLocked.launch(suggestedName(uri))
            pendingPassword = password
        }
    }
    private val openSharePlain = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) confirmPlainShare(uri)
    }
    private val createLocked = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val source = pendingPlain
        val password = pendingPassword
        pendingPlain = null
        pendingPassword = null
        if (uri != null && source != null && password != null) encryptTo(source, uri, password, shareAfter = true)
    }

    private var pendingPassword: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        sweepPlayback()
        findViewById<MaterialButton>(R.id.openButton).setOnClickListener {
            openLocked.launch(arrayOf("*/*"))
        }
        findViewById<MaterialButton>(R.id.lockButton).setOnClickListener {
            openPlain.launch(arrayOf("video/*", "application/octet-stream", "*/*"))
        }
        findViewById<MaterialButton>(R.id.sharePlainButton).setOnClickListener {
            openSharePlain.launch(arrayOf("video/*", "*/*"))
        }
        findViewById<MaterialButton>(R.id.doneButton).setOnClickListener { deletePlayback() }
    }

    override fun onDestroy() {
        if (isFinishing) deletePlayback()
        super.onDestroy()
    }

    private fun askPassword(confirm: Boolean, onOk: (String) -> Unit) {
        val view = layoutInflater.inflate(R.layout.dialog_password, null)
        val password = view.findViewById<TextInputEditText>(R.id.password)
        val repeatLayout = view.findViewById<View>(R.id.repeatLayout)
        val repeat = view.findViewById<TextInputEditText>(R.id.repeat)
        val hint = view.findViewById<TextView>(R.id.passwordHint)
        repeatLayout.visibility = if (confirm) View.VISIBLE else View.GONE
        hint.text = if (confirm) {
            "At least 8 characters. This phone uses the lighter lock so it can open the file later. The password is not saved."
        } else {
            "The password that locked this file."
        }
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(if (confirm) "Choose a password" else "Password")
            .setView(view)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Continue", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val first = password.text?.toString().orEmpty()
                if (confirm && first.length < 8) {
                    hint.text = "Use at least 8 characters."
                    return@setOnClickListener
                }
                if (confirm && first != repeat.text?.toString().orEmpty()) {
                    hint.text = "Those passwords do not match."
                    return@setOnClickListener
                }
                if (!confirm && first.isEmpty()) {
                    hint.text = "Type the password."
                    return@setOnClickListener
                }
                dialog.dismiss()
                onOk(first)
            }
        }
        dialog.show()
    }

    private fun decryptAndPlay(uri: Uri, password: String) {
        val status = findViewById<TextView>(R.id.status)
        runIo {
            val length = displaySize(uri)
            val out = File(cacheDir, "playback-${System.currentTimeMillis()}.mp4")
            if (!hasRoom(out.parentFile ?: cacheDir, length)) {
                ui { status.text = spaceText(length) }
                return@runIo
            }
            try {
                contentResolver.openInputStream(uri).use { input ->
                    if (input == null) error("Could not read that file.")
                    out.outputStream().use { output ->
                        NitrateCrypto.decryptStream(input, output, password = password)
                    }
                }
                ui { play(out) }
            } catch (error: Throwable) {
                out.delete()
                throw error
            }
        }
    }

    private fun encryptTo(source: Uri, dest: Uri, password: String, shareAfter: Boolean) {
        runIo {
            val length = displaySize(source)
            val destFileGuess = length
            if (!hasRoom(cacheDir, destFileGuess)) {
                ui { findViewById<TextView>(R.id.status).text = spaceText(destFileGuess) }
                return@runIo
            }
            val temp = File(cacheDir, "share-${System.currentTimeMillis()}.nenc")
            try {
                contentResolver.openInputStream(source).use { input ->
                    if (input == null) error("Could not read that video.")
                    temp.outputStream().use { output ->
                        NitrateCrypto.encryptStream(
                            input,
                            output,
                            password = password,
                            lowMemory = true,
                        )
                    }
                }
                contentResolver.openOutputStream(dest)?.use { output ->
                    temp.inputStream().use { input -> input.copyTo(output) }
                } ?: error("Could not save the locked file.")
                ui {
                    findViewById<TextView>(R.id.status).text =
                        "Locked. Only ciphertext was saved. The password is not on this phone."
                    if (shareAfter) shareFile(temp, "application/octet-stream") else temp.delete()
                }
            } catch (error: Throwable) {
                temp.delete()
                contentResolver.delete(dest, null, null)
                throw error
            }
        }
    }

    private fun confirmPlainShare(uri: Uri) {
        MaterialAlertDialogBuilder(this)
            .setTitle("Unprotected copy")
            .setMessage("Anyone who receives this file can watch it. It is not locked.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Share") { _, _ ->
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = contentResolver.getType(uri) ?: "video/*"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(Intent.createChooser(send, "Share unprotected video"))
            }
            .show()
    }

    private fun play(file: File) {
        playback = file
        val player = findViewById<VideoView>(R.id.player)
        val done = findViewById<MaterialButton>(R.id.doneButton)
        player.visibility = View.VISIBLE
        done.visibility = View.VISIBLE
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        player.setVideoURI(uri)
        val controls = MediaController(this)
        controls.setAnchorView(player)
        player.setMediaController(controls)
        player.setOnPreparedListener { it.start() }
        player.setOnErrorListener { _, _, _ ->
            findViewById<TextView>(R.id.status).text =
                "The file unlocked, but this phone could not play it. H.264 MP4 works best."
            true
        }
        findViewById<TextView>(R.id.status).text =
            "Playing. This unlocked copy stays in the app until you delete it."
    }

    private fun shareFile(file: File, type: String) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            this.type = type
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(send, "Share locked video"))
    }

    private fun runIo(block: () -> Unit) {
        setBusy(true)
        io.execute {
            try {
                block()
            } catch (error: Throwable) {
                ui { findViewById<TextView>(R.id.status).text = friendly(error) }
            } finally {
                ui { setBusy(false) }
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        findViewById<ProgressBar>(R.id.progress).visibility = if (busy) View.VISIBLE else View.GONE
        findViewById<MaterialButton>(R.id.openButton).isEnabled = !busy
        findViewById<MaterialButton>(R.id.lockButton).isEnabled = !busy
        if (busy) findViewById<TextView>(R.id.status).text = "Working on this phone. Keep the screen open."
    }

    private fun friendly(error: Throwable): String {
        val raw = error.message.orEmpty()
        return when {
            error is OutOfMemoryError ->
                "This phone ran out of memory. If the video was locked on a computer, it may use the heavy password setup. Lock it again here."
            raw.contains("bad magic", true) || raw.contains("not a Nitrate", true) ->
                "That file is not a locked Nitrate video (.nenc or .enc)."
            error is DecryptionException -> raw.ifBlank { "Could not open that file." }
            else -> raw.ifBlank { "Something went wrong." }
        }
    }

    private fun displaySize(uri: Uri): Long {
        contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getLong(0)
        }
        return 0L
    }

    private fun suggestedName(uri: Uri): String {
        var name = "video"
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) name = cursor.getString(0) ?: name
        }
        return name.substringBeforeLast('.') + ".nenc"
    }

    private fun hasRoom(dir: File, bytes: Long): Boolean {
        if (bytes <= 0) return true
        val free = StatFs(dir.absolutePath).availableBytes
        return free > bytes + 32L * 1024L * 1024L
    }

    private fun spaceText(bytes: Long): String {
        val mb = (bytes / (1024 * 1024)).coerceAtLeast(1)
        return "This phone does not have enough free space for that video (about $mb MB plus working room). Delete something and try again."
    }

    private fun sweepPlayback() {
        cacheDir.listFiles()?.filter { it.name.startsWith("playback-") }?.forEach { it.delete() }
    }

    private fun deletePlayback() {
        val player = findViewById<VideoView>(R.id.player)
        player.stopPlayback()
        player.visibility = View.GONE
        findViewById<MaterialButton>(R.id.doneButton).visibility = View.GONE
        playback?.delete()
        playback = null
    }

    private fun ui(block: () -> Unit) {
        runOnUiThread {
            if (!isDestroyed) block()
        }
    }
}
