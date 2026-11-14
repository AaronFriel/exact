package dev.exact.canvas

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray

/**
 * A person's act on the platform's own UI that an extension posted, such as a notification's tap (LLP 1133.004 D6;
 * LLP 1133.004.000 D4): the extension makes the intent the tap starts ([ExtensionContext.activation]) and the activity
 * hands it back here. It opens its `navigate` location as a link's, or raises the extension's event with a person's
 * origin.
 *
 * The intent goes to `.Notify`, an `<activity-alias>` of the app's activity with `android:exported="false"`. Only the
 * app, or the system acting on the app's `PendingIntent`, can start it, so an activation is read only from an intent
 * whose component is the alias, and needs no secret. `MainActivity` is exported: an activation extra on an intent to
 * it is another app's, and is dropped and journaled.
 *
 * Raised once the first frame is drawn: a tap that starts the process waits for the session that hears it. Main
 * thread.
 */
internal object Activations {
    /** The alias the shell's manifest declares. */
    const val ALIAS = "dev.exact.app.Notify"
    private const val EXTENSION = "dev.exact.activation.extension"
    private const val EVENT = "dev.exact.activation.event"
    private const val ARGS = "dev.exact.activation.args"

    /** The first frame was drawn in this process: an activation is raised at once. */
    private var ready = false
    /** What arrived before it: an event to raise, or a journal line (`event` null). */
    private class Held(val extension: String, val event: String?, val args: String)
    private val held = ArrayList<Held>()

    /** The intent a tap starts: the alias, at [navigate] when given, else raising [event] of [extension] with [args]. */
    fun intent(context: Context, extension: String, event: String, args: JSONArray, navigate: String?): Intent {
        val intent = Intent().setComponent(ComponentName(context.packageName, ALIAS))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (!navigate.isNullOrEmpty()) return intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse(navigate))
        return intent.putExtra(EXTENSION, extension).putExtra(EVENT, event).putExtra(ARGS, args.toString())
    }

    /** Whether [intent] reached the app through the alias. */
    fun aliased(intent: Intent): Boolean = intent.component?.className == ALIAS

    /**
     * Whether [intent] carried an activation: taken off it, so a recreated activity does not raise it again. One that
     * came through the alias is raised; one that came to the exported activity is dropped and journaled.
     */
    fun receive(intent: Intent): Boolean {
        val extension = intent.getStringExtra(EXTENSION) ?: return false
        val event = intent.getStringExtra(EVENT)
        val args = intent.getStringExtra(ARGS) ?: "[]"
        for (key in listOf(EXTENSION, EVENT, ARGS)) intent.removeExtra(key)
        val raised = if (aliased(intent) && event != null) Held(extension, event, args)
            else Held(extension, null, "an activation of $extension that did not come through the app's own notification was dropped")
        if (ready) raise(raised) else held.add(raised)
        return true
    }

    /** The first frame: what a launching tap carried is raised now. */
    fun started() {
        if (ready) return
        ready = true
        held.forEach(::raise)
        held.clear()
    }

    private fun raise(a: Held) {
        try {
            if (a.event != null) Exact.activate(a.extension, a.event, a.args) else Exact.journal(a.args)
        } catch (e: UnsatisfiedLinkError) {
            android.util.Log.w("exact", "activation: no session")
        }
    }
}
