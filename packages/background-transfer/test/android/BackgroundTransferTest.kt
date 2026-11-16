package exact.backgroundtransfer

import android.app.ActivityManager
import android.content.Context
import android.os.Looper
import dev.exact.canvas.ExtensionContext
import dev.exact.canvas.Extensions
import dev.exact.canvas.Native
import exact.backgroundtransfer.Lifecycle.Job
import exact.backgroundtransfer.Lifecycle.JobStarted
import exact.backgroundtransfer.Lifecycle.JobStopped
import exact.backgroundtransfer.Lifecycle.Key
import exact.backgroundtransfer.Lifecycle.Limits
import exact.backgroundtransfer.Lifecycle.Run
import exact.backgroundtransfer.Lifecycle.Stop
import exact.backgroundtransfer.Lifecycle.Write
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Executor

/** The module over [Transfers], with [Sessions] as the host: the package's calls, its session's life and its wakes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, shadows = [BackgroundTransferTest.Session::class, BackgroundTransferTest.Transport::class])
@LooperMode(LooperMode.Mode.PAUSED)
class BackgroundTransferTest {
    @Implements(Native::class, isInAndroidSdk = false)
    class Session {
        companion object {
            lateinit var root: File
            /** Whether a drive runs the session: its implementation told so ([agent], off under `--bind`), and its
             * storage the drive's ([scratch], whatever it binds). */
            var agent = false
            var scratch = false
            /** Whether the library has the entry point that says so. */
            var linked = true
            val wakes = mutableListOf<JSONObject>()
            val expired = mutableListOf<String>()
            @JvmStatic @Implementation fun trust(context: Context) {}
            @JvmStatic @Implementation fun __staticInitializer__() {}
            @JvmStatic @Implementation fun underAgent(name: String) = agent
            @JvmStatic @Implementation fun scratchStorage(): Boolean = if (linked) scratch else throw UnsatisfiedLinkError("scratchStorage")
            @JvmStatic @Implementation fun appRoot(index: Int) = File(root, listOf("data", "cache", "tmp")[index]).path
            @JvmStatic @Implementation fun changed(topic: String) {
                if (topic.startsWith("exact-wake:")) wakes += JSONObject(topic.removePrefix("exact-wake:"))
                if (topic.startsWith("exact-wake-expired:")) expired += JSONObject(topic.removePrefix("exact-wake-expired:")).getString("id")
            }
        }
    }
    @Implements(NativeTransfer::class, isInAndroidSdk = false)
    class Transport {
        companion object { @JvmStatic @Implementation fun __staticInitializer__() {} }
    }
    private class Store(root: File) : Registrations(root) {
        var failing = false
        @Synchronized override fun write(write: Write, admission: Admission?, response: Response?) {
            if (failing) { failing = false; throw IOException("disk full") }
            super.write(write, admission, response)
        }
    }

    private lateinit var base: File
    private lateinit var store: Store
    private lateinit var transport: FakeTransport
    private lateinit var transfers: Transfers
    private lateinit var context: ExtensionContext
    private var module: BackgroundTransferModule? = null
    private val platform = FakePlatform()
    private val main get() = shadowOf(Looper.getMainLooper())
    private val app: Context get() = RuntimeEnvironment.getApplication()

    @Before fun setup() {
        base = Files.createTempDirectory("transfer-module").toFile()
        Session.root = base
        Session.agent = false
        Session.scratch = false
        Session.linked = true
        Session.wakes.clear()
        Session.expired.clear()
        listOf("data", "cache", "tmp").forEach { File(base, it).mkdirs() }
        transport = FakeTransport(base)
        process()
    }
    @After fun cleanup() {
        close()
        Extensions.stopped(false)
        Jobs.visible = null
        base.deleteRecursively()
    }

    /** A process: its transfers over what the last one left. Every effect and operation runs where it is asked for. */
    private fun process(limits: Limits = Limits()) {
        store = Store(File(base, "private"))
        transfers = Transfers(store, transport::exchange, platform, Sessions, Fixture.inline, Fixture.inline { transfers }, limits)
    }
    /** The session starts, with an activity that shows it when [visible]. */
    private fun open(visible: Boolean = true) {
        if (visible) Extensions.started() else Extensions.stopped(false)
        context = ExtensionContext(app, "background-transfer")
        context.authority = "net.fetch https://example.test\nfs.write app:/data"
        module = BackgroundTransferModule(context, { transfers }, transport::exchange, Executor { it.run() })
        main.idle()
    }
    private fun close() {
        module?.destroy {}
        module = null
        main.idle()
    }
    private fun call(name: String, args: JSONObject = JSONObject()): JSONObject {
        var answer: JSONObject? = null
        module!!.later(name, args) { answer = it }
        main.idle()
        return answer!!
    }
    private fun named(id: String = "visitor") = JSONObject().put("id", id)
    private fun start(id: String = "visitor", url: String = "https://example.test/a%2Fb?token=private#hidden", saveTo: String? = null) =
        call("backgroundFetch", named(id).put("title", JSONObject.NULL).put("requests", JSONArray().put(JSONObject().put("url", url)
            .put("method", JSONObject.NULL).put("saveTo", saveTo ?: JSONObject.NULL)
            .put("headers", JSONArray().put(JSONObject().put("name", "Authorization").put("value", "secret"))))))
    private fun key(id: String = "visitor"): Key = transfers.namespaces().firstNotNullOf { transfers.find(it, id) }
    private fun record(key: Key) = store.durable().records[key]!!
    private fun run(key: Key, id: Int) { transfers.feed(JobStarted(key, Run(id, Job.Work), transfers.conditions)); main.idle() }
    private fun end(wake: JSONObject, outcome: String) { context.ended.remove(wake.getString("id"))!!(outcome); main.idle() }

    @Test fun aStartCapturesItsAuthorityAndKeepsCredentialsOffDisk() {
        open()
        val answer = start()
        assertEquals("visitor", answer.getString("id"))
        assertEquals("", answer.getString("result"))
        val key = key()
        val kept = store.get(key)!!
        assertEquals(context.authority, kept.getString("source"))
        assertEquals("app", kept.getString("origin"))
        assertEquals("visitor", kept.getString("title"))
        assertEquals(base.path + "/data", kept.getString("data"))
        assertEquals("GET", kept.getJSONArray("requests").getJSONObject(0).getString("method"))
        assertEquals("https://example.test/a%2Fb", kept.getJSONArray("requests").getJSONObject(0).getString("url"))
        assertFalse(kept.toString().contains("token=private") || kept.toString().contains("secret"))
        assertEquals("secret", transport.secrets.values.single().getJSONArray("headers").getJSONObject(0).getString("value"))
        assertEquals(context.authority, transport.secrets.values.single().getString("authority"))
        // The runtime does not yet say a call is a person's act: a start is a program's, though the app shows.
        assertEquals(Lifecycle.Intent.Ordinary, record(key).intent)
        assertEquals(setOf(key to Job.Work), platform.jobs.toSet())
        assertEquals("visitor", call("backgroundFetchRegistration", named()).getJSONObject("exact:answer").getString("id"))
        assertEquals("[\"visitor\"]", call("backgroundFetchIds").getJSONArray("exact:answer").toString())
    }

    @Test fun anAbortEndsTheTransferAndARetirementRemovesIt() {
        open()
        start()
        val key = key()
        assertTrue(call("abortBackgroundFetch", named()).getBoolean("exact:answer"))
        // The view is up, so the ending is delivered at once.
        val wake = Session.wakes.single()
        assertEquals("backgroundfetchabort", wake.getString("event"))
        assertEquals("transfer.${key.generation}.1", wake.getString("id"))
        assertEquals("aborted", wake.getJSONArray("args").getJSONObject(0).getString("failureReason"))
        end(wake, "completed")
        assertFalse(call("abortBackgroundFetch", named()).getBoolean("exact:answer"))
        assertFalse(call("retireBackgroundFetch", named()).has("error"))
        assertTrue(transport.secrets.isEmpty())
        assertTrue(platform.jobs.isEmpty())
        assertEquals(0, call("backgroundFetchIds").getJSONArray("exact:answer").length())
        assertEquals(JSONObject.NULL, call("backgroundFetchRegistration", named()).get("exact:answer"))
        assertFalse(call("abortBackgroundFetch", named()).getBoolean("exact:answer"))
        assertEquals("the id is free again", "visitor", start().getString("id"))
    }

    @Test fun aRefusedStartAnswersItsErrorAndKeepsNothing() {
        open()
        assertEquals("NotAllowedError", start(url = "https://denied.test/a").getString("error"))
        assertEquals(0, call("backgroundFetchIds").getJSONArray("exact:answer").length())
        assertTrue(transport.secrets.isEmpty())
        assertTrue(platform.jobs.isEmpty())
        assertEquals("visitor", start().getString("id"))
        assertEquals("an id is registered once", "TypeError", start().getString("error"))
        assertEquals(1, transport.secrets.size)
        for (bad in listOf(named(""), named("none").put("requests", JSONArray()), named("x".repeat(65)),
            JSONObject("{\"id\":\"total\",\"downloadTotal\":-1,\"requests\":[{\"url\":\"https://example.test/a\"}]}"))) {
            assertEquals(bad.toString(), "TypeError", call("backgroundFetch", bad).getString("error"))
        }
        assertEquals("NotSupportedError", call("pauseBackgroundFetch", named()).getString("error"))
    }

    @Test fun anAppRestrictedInTheBackgroundIsDenied() {
        open()
        assertEquals("granted", call("backgroundFetchStatus").getString("state"))
        assertTrue(call("backgroundFetchStatus").getBoolean("available"))
        shadowOf(app.getSystemService(ActivityManager::class.java)).setBackgroundRestricted(true)
        assertEquals("denied", call("backgroundFetchStatus").getString("state"))
        assertEquals("NotAllowedError", start().getString("error"))
        assertTrue(transfers.ids(Fixture.app).isEmpty())
    }

    @Test fun admissionUsesTheSharedParsersPublicUrl() {
        open()
        for ((url, public) in listOf("https://example.test/file?secret=1#part" to "https://example.test/file",
            "http://upload_server.example/file" to "http://upload_server.example/file")) {
            val answer = start(url = url)
            assertFalse(answer.toString(), answer.has("error"))
            assertEquals(public, store.get(key())!!.getJSONArray("requests").getJSONObject(0).getString("url"))
            assertEquals(url, transport.seen.last { it.getString("op") == "keep" }.getString("url"))
            call("retireBackgroundFetch", named())
        }
    }

    @Test fun aLaunchDeliversAnEndingNoSessionHeard() {
        open(visible = false)
        start()
        val key = key()
        close()
        // With no session the host's seam reports each wake expired.
        for (id in 1..3) run(key, id)
        assertTrue(Session.wakes.isEmpty())
        assertEquals(listOf(1 to true, 2 to true, 3 to false), platform.finished.toList())
        assertTrue(platform.jobs.isEmpty())
        process()
        open()
        val wake = Session.wakes.single()
        assertEquals("backgroundfetchsuccess", wake.getString("event"))
        assertEquals("transfer.${key.generation}.4", wake.getString("id"))
        val path = wake.getJSONArray("args").getJSONObject(0).getJSONArray("records").getJSONObject(0).getString("path")
        assertEquals("response", File(base, path.removePrefix("app:/")).readText())
        end(wake, "completed")
        // An unretired ending is delivered again at the next launch.
        close()
        open()
        assertEquals("transfer.${key.generation}.5", Session.wakes.last().getString("id"))
        call("retireBackgroundFetch", named())
        assertFalse(File(base, path.removePrefix("app:/")).exists())
        assertFalse(File(base, "private/app.app/${key.generation}").exists())
    }

    @Test fun aWakesOutcomeReachesTheLifecycle() {
        process(Limits(completedWakes = 1))
        open(visible = false)
        start("expired")
        start("completed")
        run(key("expired"), 1)
        run(key("completed"), 2)
        assertEquals(listOf("backgroundfetchsuccess", "backgroundfetchsuccess"), Session.wakes.map { it.getString("event") })
        assertTrue("each run is held through its wake", platform.finished.isEmpty())
        end(Session.wakes[0], "expired")
        assertEquals(listOf(1 to true), platform.finished.toList())
        end(Session.wakes[1], "completed")
        assertEquals(listOf(1 to true, 2 to false), platform.finished.toList())
        assertEquals(Job.Work to null, record(key("expired")).job to record(key("completed")).job)
    }

    @Test fun aStoppedRunExpiresItsWake() {
        open(visible = false)
        start()
        val key = key()
        run(key, 1)
        val wake = Session.wakes.single()
        transfers.feed(JobStopped(key, 1, Stop.System))
        main.idle()
        assertEquals(listOf(wake.getString("id")), Session.expired)
        end(wake, "expired")
        assertEquals(Job.Work, record(key).job)
    }

    @Test fun aSessionsEndSupersedesItsWakes() {
        open(visible = false)
        start()
        val key = key()
        run(key, 1)
        val wake = Session.wakes.single().getString("id")
        close()
        assertEquals(listOf(wake), Session.expired)
        val (process, _) = transfers.state()
        assertNull(process.session)
        assertTrue(process.waking.isEmpty())
        assertEquals(listOf(1 to true), platform.finished.toList())
        // The outcome the runner tells afterwards is no one's.
        context.ended.remove(wake)?.invoke("completed")
        open()
        assertEquals("transfer.${key.generation}.2", Session.wakes.last().getString("id"))
    }

    @Test fun theSessionsViewFollowsItsActivity() {
        open(visible = false)
        assertEquals(false, transfers.state().first.session!!.view)
        Extensions.started()
        module!!.resumed()
        assertEquals(true, transfers.state().first.session!!.view)
        module!!.foreground(false)
        assertEquals(false, transfers.state().first.session!!.view)
        module!!.foreground(true)
        module!!.foreground(true)
        assertEquals(true, transfers.state().first.session!!.view)
        val incarnation = transfers.state().first.session!!.incarnation
        close()
        open()
        assertNotEquals(incarnation, transfers.state().first.session!!.incarnation)
    }

    @Test fun aSaveToIsPlacedOnceAndARetirementLeavesIt() {
        open()
        start(saveTo = "app:/data/saved")
        assertEquals("app:/data/saved", transport.seen.single { it.getString("op") == "checkSave" }.getString("path"))
        val key = key()
        run(key, 1)
        val path = Session.wakes.single().getJSONArray("args").getJSONObject(0).getJSONArray("records").getJSONObject(0).getString("path")
        assertEquals("app:/data/saved", path)
        File(base, "data/saved").writeText("the app's now")
        end(Session.wakes.single(), "completed")
        close()
        process()
        open()
        assertEquals(1, transport.ops().count { it == "place" })
        call("retireBackgroundFetch", named())
        assertEquals("the app's now", File(base, "data/saved").readText())
        assertFalse("removePlaced" in transport.ops())
    }

    @Test fun aRetirementAnswersWhenItsFilesAreGoneAndTheIdIsFreeFromThen() {
        // The retirement's cleanup waits for the test to run it.
        val cleanups = ArrayList<() -> Lifecycle.Event?>()
        transfers = Transfers(store, transport::exchange, platform, Sessions, Fixture.inline,
            { effect, _, body -> if (effect is Lifecycle.Clean) cleanups += body else body()?.let { transfers.feed(it) } })
        open()
        start()
        run(key(), 1)
        assertTrue(File(base, "data/transfers/visitor/0").isFile)
        var retired: JSONObject? = null
        module!!.later("retireBackgroundFetch", named()) { retired = it }
        main.idle()
        assertNull(retired)
        assertEquals(JSONObject.NULL, call("backgroundFetchRegistration", named()).get("exact:answer"))
        // The first transfer's files are still under the id.
        assertEquals("InvalidStateError", start().getString("error"))
        transfers.feed(cleanups.single()()!!)
        main.idle()
        assertFalse(retired!!.has("error"))
        assertFalse(File(base, "data/transfers/visitor").exists())
        assertEquals("visitor", start().getString("id"))
    }

    @Test fun aLibraryThatCannotSayWhoseStorageItIsMakesNoModule() {
        Session.linked = false
        val made = ExtensionContext(app, "background-transfer")
        // The app's namespace is not the answer to a question the library cannot be asked.
        assertThrows(UnsatisfiedLinkError::class.java) {
            BackgroundTransferModule(made, { transfers }, transport::exchange, Executor { it.run() })
        }
    }

    @Test fun anAgentDriveHasItsOwnNamespace() {
        open()
        start()
        close()
        Session.agent = true
        Session.scratch = true
        Session.root = File(base, "drive").also { File(it, "data").mkdirs() }
        open()
        assertEquals(0, call("backgroundFetchIds").getJSONArray("exact:answer").length())
        assertEquals("visitor", start().getString("id"))
        val drive = transfers.namespaces().single { it.agent }
        assertTrue(Regex("[0-9a-f]{16}").matches(drive.name))
        assertTrue(File(base, "private/agent.${drive.name}").isDirectory)
        assertEquals(listOf("visitor"), transfers.ids(drive))
        // The same store at a later launch is the same namespace, and another drive's store is not.
        close()
        open()
        assertEquals(1, call("backgroundFetchIds").getJSONArray("exact:answer").length())
        close()
        Session.root = File(base, "other").also { File(it, "data").mkdirs() }
        open()
        assertEquals(0, call("backgroundFetchIds").getJSONArray("exact:answer").length())
        assertEquals("visitor", start().getString("id"))
        assertEquals(2, transfers.namespaces().count { it.agent })
    }

    @Test fun aRetirementWhoseCleanupFailsSaysSoAndIsTriedAgain() {
        open()
        start()
        run(key(), 1)
        val key = key()
        val response = File(base, "data/transfers/visitor/0")
        assertTrue(response.isFile)
        // The secret store is locked: the credentials cannot be removed.
        transport.failing = setOf("forget")
        assertEquals("UnknownError", call("retireBackgroundFetch", named()).getString("error"))
        assertEquals(Lifecycle.Phase.Retired, record(key).phase)
        assertFalse(transport.secrets.isEmpty())
        // The registration is retired, and its id is taken while what it kept remains.
        assertEquals(JSONObject.NULL, call("backgroundFetchRegistration", named()).get("exact:answer"))
        assertEquals("InvalidStateError", start().getString("error"))
        assertEquals("UnknownError", call("retireBackgroundFetch", named()).getString("error"))
        // The store opens: the same call removes it, and answers once the record is gone.
        transport.failing = emptySet()
        var gone: Boolean? = null
        module!!.later("retireBackgroundFetch", named()) { gone = !it.has("error") && store.durable().records[key] == null }
        main.idle()
        assertEquals(true, gone)
        assertTrue(transport.secrets.isEmpty())
        assertFalse(response.exists())
        assertEquals("visitor", start().getString("id"))
        // Nothing of that id is left to retire.
        assertFalse(call("retireBackgroundFetch", named("absent")).has("error"))
    }

    @Test fun aRetirementCutShortByAFailedWriteSaysSo() {
        // The retirement's cleanup waits for the test to run it.
        val cleanups = ArrayList<() -> Lifecycle.Event?>()
        transfers = Transfers(store, transport::exchange, platform, Sessions, Fixture.inline,
            { effect, _, body -> if (effect is Lifecycle.Clean) cleanups += body else body()?.let { transfers.feed(it) } })
        open()
        start()
        start("other")
        var retired: JSONObject? = null
        module!!.later("retireBackgroundFetch", named()) { retired = it }
        main.idle()
        assertNull(retired)
        // Another call's write fails: the process goes on as its successor, and the retirement's removal is unknown.
        store.failing = true
        assertEquals("UnknownError", call("abortBackgroundFetch", named("other")).getString("error"))
        assertEquals("UnknownError", retired!!.getString("error"))
    }

    @Test fun aDriveThatBindsThePackageCannotReachTheAppsTransfers() {
        val app = Lifecycle.Namespace("app")
        // The app: a transfer that ended with a kept response, and one waiting with its credentials.
        open()
        start()
        run(key(), 1)
        start("waiting")
        val mine = setOf(key(), key("waiting"))
        val response = File(base, "data/transfers/visitor/0")
        assertTrue(response.isFile)
        val secrets = transport.secrets.keys.toSet()
        assertTrue(secrets.isNotEmpty())
        close()
        // A drive that binds the package as in production: told it is not under the agent, on the drive's store.
        Session.scratch = true
        Session.root = File(base, "drive").also { root -> listOf("data", "cache", "tmp").forEach { File(root, it).mkdirs() } }
        process()
        open()
        assertEquals(0, call("backgroundFetchIds").getJSONArray("exact:answer").length())
        for (id in listOf("visitor", "waiting")) {
            assertEquals(JSONObject.NULL, call("backgroundFetchRegistration", named(id)).get("exact:answer"))
            assertFalse(call("abortBackgroundFetch", named(id)).getBoolean("exact:answer"))
            call("retireBackgroundFetch", named(id))
        }
        assertEquals("the app's records stand", mine, store.durable().records.filterValues { it.phase != Lifecycle.Phase.Retired }.keys)
        assertTrue("with the response", response.isFile)
        assertEquals("and the credentials", secrets, transport.secrets.keys.toSet())
        // The same id is free in the drive, whose retirement removes only its own.
        assertEquals("visitor", start().getString("id"))
        val drive = transfers.namespaces().single { it.agent }
        val first = transfers.find(drive, "visitor")!!
        assertTrue(call("abortBackgroundFetch", named()).getBoolean("exact:answer"))
        assertFalse(call("retireBackgroundFetch", named()).has("error"))
        assertNull(store.durable().records[first])
        assertEquals(mine, store.durable().records.keys)
        assertTrue(response.isFile)
        assertEquals(secrets, transport.secrets.keys.toSet())
        assertEquals("visitor", start().getString("id"))
        val theirs = transfers.find(drive, "visitor")!!
        close()
        // A later process recovers each in its own namespace.
        Session.scratch = false
        Session.root = base
        process()
        open()
        val ids = { call("backgroundFetchIds").getJSONArray("exact:answer").let { a -> (0 until a.length()).map(a::getString).toSet() } }
        assertEquals(setOf("visitor", "waiting"), ids())
        assertEquals(mine, setOf(transfers.find(app, "visitor"), transfers.find(app, "waiting")))
        assertEquals(mine + theirs, store.durable().records.keys)
        close()
        Session.scratch = true
        Session.root = File(base, "drive")
        process()
        open()
        assertEquals(setOf("visitor"), ids())
        assertEquals(theirs, transfers.find(drive, "visitor"))
        assertEquals(mine + theirs, store.durable().records.keys)
    }

    @Test fun aCallAfterAFailedWriteRecoversTheSession() {
        open()
        start()
        store.failing = true
        assertEquals("UnknownError", call("abortBackgroundFetch", named()).getString("error"))
        assertNull(transfers.state().first.session)
        assertEquals("", call("backgroundFetchRegistration", named()).getJSONObject("exact:answer").getString("result"))
        assertEquals(true, transfers.state().first.session!!.view)
        assertTrue(call("abortBackgroundFetch", named()).getBoolean("exact:answer"))
        assertEquals("backgroundfetchabort", Session.wakes.single().getString("event"))
    }
}
