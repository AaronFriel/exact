package exact.clipboard

import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import android.view.View
import android.view.ViewTreeObserver
import dev.exact.canvas.AgentClipboard
import dev.exact.canvas.Cause
import dev.exact.canvas.ExactExtension
import dev.exact.canvas.ExtensionContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReferenceArray

private const val MAX_TEXT = 1024 * 1024
private const val PROVIDER_TIMEOUT_MS = 1500L
private class TooLarge : Exception()
private fun refused(code: String, message: String) = JSONObject().put("error", code).put("message", message)
private fun tooLarge() = refused("DataError", "text/plain is over 1 MiB")
private fun denied() = refused("NotAllowedError", "clipboard access was denied")
private val main = Handler(Looper.getMainLooper())

// A provider can ignore cancellation during open. Limit how many threads it can keep.
private val workers = ThreadPoolExecutor(0, 4, 10, TimeUnit.SECONDS, SynchronousQueue())

class ClipboardModule(context: ExtensionContext) : ExactExtension(context) {
    private val pending = mutableMapOf<Int, PendingRead>()

    override fun later(name: String, args: JSONObject, reply: (JSONObject) -> Unit) = read(name, null, reply)

    override fun later(name: String, args: JSONObject, preferred: Any?, cause: Cause, reply: (JSONObject) -> Unit) =
        read(name, cause.request, reply)

    override fun cancel(request: Int) { pending.remove(request)?.cancel() }

    private fun read(name: String, request: Int?, reply: (JSONObject) -> Unit) {
        if (name != "read" && name != "readText") return reply(JSONObject().put("error", "NotSupportedError"))
        val first = name == "readText"
        val activity = context.activity ?: return reply(denied())
        val view = activity.window.decorView
        if (!view.hasWindowFocus()) return reply(denied())
        if (AgentClipboard.active) {
            val clip = AgentClipboard.text?.let { ClipData.newPlainText(null, it) }
            return reply(TextItems(clip, first).answer())
        }
        val clip = try {
            val board = activity.getSystemService(ClipboardManager::class.java)
            if (!offersText(board.primaryClipDescription)) null else board.primaryClip.also {
                if (it == null && offersText(board.primaryClipDescription)) return reply(denied())
            }
        } catch (_: SecurityException) {
            return reply(denied())
        } catch (_: RuntimeException) {
            return reply(refused("NotReadableError", "could not read the clipboard"))
        }
        if (!view.hasWindowFocus()) return reply(denied())
        if (clip == null) {
            // The clipboard service can see a focus loss before the UI thread receives it.
            main.post {
                val locked = activity.getSystemService(KeyguardManager::class.java).isDeviceLocked
                reply(if (view.hasWindowFocus() && !locked) TextItems(null, first).answer() else denied())
            }
            return
        }
        val items = TextItems(clip.takeIf { offersText(it.description) }, first)
        if (!items.needsProvider()) return reply(items.answer())
        val read = PendingRead(view, items) {
            if (request != null) pending.remove(request)
            reply(it)
        }
        if (request != null) pending[request] = read
        read.start(context.application)
    }

    private fun offersText(description: ClipDescription?) = description != null &&
        (description.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) ||
            description.hasMimeType(ClipDescription.MIMETYPE_TEXT_HTML) || description.hasMimeType("text/x-moz-url"))
}

internal class TextItems(private val clip: ClipData?, private val first: Boolean) {
    private val count = clip?.itemCount ?: 0
    private val resolved = AtomicReferenceArray<String?>(count)

    fun needsProvider(): Boolean {
        for (i in 0 until count) {
            val item = clip!!.getItemAt(i)
            if (item.text != null) { if (first) return false }
            else if (item.uri?.scheme == ContentResolver.SCHEME_CONTENT) return true
        }
        return false
    }

    // At the deadline, keep inline strings and any provider text that finished in time, in clipboard order.
    fun answer(provider: ((Uri, Int, Boolean) -> String?)? = null): JSONObject {
        val records = JSONArray()
        var remaining = MAX_TEXT
        var unavailable: JSONObject? = null
        for (i in 0 until count) {
            val item = clip!!.getItemAt(i)
            val value = try {
                item.text?.toString() ?: resolved.get(i) ?: item.uri
                    ?.takeIf { it.scheme == ContentResolver.SCHEME_CONTENT }
                    ?.let { provider?.invoke(it, remaining, i == 0) }
            } catch (_: TooLarge) {
                return tooLarge()
            } catch (e: Exception) {
                unavailable = if (e is SecurityException) denied() else refused("NotReadableError", "could not read clipboard text")
                continue
            } ?: continue
            if (value.length > remaining) return tooLarge()
            remaining -= value.toByteArray().size
            if (remaining < 0) return tooLarge()
            if (item.text == null) resolved.set(i, value)
            if (first) return JSONObject().put("exact:answer", value)
            records.put(JSONObject().put("text/plain", value))
        }
        if (records.length() == 0 && unavailable != null) return unavailable
        return JSONObject().put("exact:answer", if (first) "" else records)
    }
}

private class PendingRead(
    private val view: View, private val items: TextItems, private val reply: (JSONObject) -> Unit,
) : ViewTreeObserver.OnWindowFocusChangeListener, View.OnAttachStateChangeListener {
    private val signal = CancellationSignal()
    private val deadline = SystemClock.uptimeMillis() + PROVIDER_TIMEOUT_MS
    private val timeout = Runnable { finish(items.answer(), cancel = true) }
    private var done = false

    fun start(app: Context) {
        view.viewTreeObserver.addOnWindowFocusChangeListener(this)
        view.addOnAttachStateChangeListener(this)
        main.postAtTime(timeout, deadline)
        try {
            readProviders(app, items, signal, deadline, WeakReference(this))
        } catch (busy: RejectedExecutionException) {
            finish(items.answer { _, _, _ -> throw busy })
        }
    }

    fun cancel() = finish(null, cancel = true)

    override fun onWindowFocusChanged(focused: Boolean) { if (!focused) finish(denied(), cancel = true) }
    override fun onViewDetachedFromWindow(view: View) = finish(denied(), cancel = true)
    override fun onViewAttachedToWindow(view: View) {}

    fun finish(answer: JSONObject?, cancel: Boolean = false) {
        if (done) return
        done = true
        main.removeCallbacks(timeout)
        if (view.viewTreeObserver.isAlive) view.viewTreeObserver.removeOnWindowFocusChangeListener(this)
        view.removeOnAttachStateChangeListener(this)
        if (cancel) signal.cancel()
        if (answer != null) reply(if (view.hasWindowFocus()) answer else denied())
    }
}

private fun readProviders(app: Context, items: TextItems, signal: CancellationSignal, deadline: Long, read: WeakReference<PendingRead>) {
    workers.execute {
        val result = items.answer { uri, remaining, primary ->
            signal.throwIfCanceled()
            if (SystemClock.uptimeMillis() >= deadline) null else uriText(app, uri, remaining, primary, signal, deadline)
        }
        main.post { read.get()?.finish(result) }
    }
}

internal fun uriText(app: Context, uri: Uri, remaining: Int, primary: Boolean, signal: CancellationSignal, deadline: Long): String? {
    val authority = uri.authority?.substringAfterLast('@') ?: return null
    val owner = app.packageManager.resolveContentProvider(authority, 0)
    if (owner?.applicationInfo?.uid == Process.myUid()) return null
    // A foreign clip must not borrow an unrelated read permission held by this app.
    val public = owner != null && owner.exported && owner.readPermission == null && owner.pathPermissions.isNullOrEmpty()
    if (!public && app.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) !=
        PackageManager.PERMISSION_GRANTED) return null
    val resolver = app.contentResolver
    val type = resolver.getType(uri)
    signal.throwIfCanceled()
    val format = when {
        type == "text/plain" -> "text/plain"
        !resolver.getStreamTypes(uri, "text/plain").isNullOrEmpty() -> "text/plain"
        // Android Chrome exposes the primary item’s coerced string through both plain-text reads.
        primary && type?.startsWith("text/") == true -> "text/*"
        else -> return null
    }
    signal.throwIfCanceled()
    val file = resolver.openTypedAssetFileDescriptor(uri, format, null, signal)
    return file?.use { descriptor ->
        descriptor.createInputStream().use { stream ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            val fd = descriptor.fileDescriptor
            // Another reader of a provider pipe can take the bytes between poll and read.
            val mode = Os.fstat(fd).st_mode
            if (OsConstants.S_ISFIFO(mode) || OsConstants.S_ISSOCK(mode)) {
                val flags = Os.fcntlInt(fd, OsConstants.F_GETFL, 0)
                Os.fcntlInt(fd, OsConstants.F_SETFL, flags or OsConstants.O_NONBLOCK)
            }
            val poll = arrayOf(StructPollfd().apply { this.fd = fd; events = OsConstants.POLLIN.toShort() })
            while (true) {
                signal.throwIfCanceled()
                val left = deadline - SystemClock.uptimeMillis()
                if (left <= 0) return null
                if (Os.poll(poll, minOf(left, 100).toInt()) == 0) continue
                signal.throwIfCanceled()
                val size = stream.read(buffer, 0, minOf(buffer.size, remaining - out.size() + 1))
                if (size < 0) break
                if (size == 0) continue
                if (size > remaining - out.size()) throw TooLarge()
                out.write(buffer, 0, size)
            }
            if (SystemClock.uptimeMillis() < deadline) out.toString("UTF-8") else null
        }
    }
}
