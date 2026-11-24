package dev.exact.canvas

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.findViewTreeLifecycleOwner
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.savedstate.findViewTreeSavedStateRegistryOwner
import dev.exact.app.materialPickers
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], manifest = Config.NONE, shadows = [HeadlessLaunchTest.Host::class, AuthTest.Environment::class])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposeModuleTest {
    @get:Rule val compose = createEmptyComposeRule()
    class Module : NativeModule {
        lateinit var view: ComposeView
        var shown = ""
        var change: (String) -> Unit = {}
        var disposed = false
        override fun create(context: Context, props: JSONObject): View = ComposeView(context).also {
            disposed = false
            view = it
            it.id = 1234 // Stable across Activity recreation, as rememberSaveable requires.
            it.setContent {
                val text = rememberSaveable { mutableStateOf("hello") }
                SideEffect { shown = text.value; change = { text.value = it } }
                DisposableEffect(Unit) { onDispose { disposed = true } }
                BasicText(text.value)
            }
        }
        override fun update(view: View, props: JSONObject) {}
        override fun destroy(view: View) { (view as ComposeView).disposeComposition() }
    }

    class Reader : ExactActivity() {
        val module = Module()
        override val modules get() = mapOf("hello-compose" to module)
        internal lateinit var content: Root
        internal lateinit var hosted: Natives
        override fun getDisplay(): android.view.Display =
            getSystemService(android.hardware.display.DisplayManager::class.java).getDisplay(0)
        override fun onCreate(state: Bundle?) {
            super.onCreate(state)
            content = findViewById<FrameLayout>(android.R.id.content).getChildAt(0) as Root
        }
        fun mount() {
            hosted = content.getChildAt(0) as Natives
            hosted.ensure(7, 2, 360, 48, "{\"module\":\"hello-compose\",\"slot\":2,\"generation\":3}", 0)
            hosted.everywhere()
        }
    }

    class Model : ViewModel() {
        var cleared = false
        override fun onCleared() { cleared = true }
    }

    private val controller = Robolectric.buildActivity(Reader::class.java, Intent()
        .putExtra("owner", "0").putExtra("asyncboot", "0").putExtra("splashfade", "1").putExtra("warmlaunch", "0"))
    private val activity get() = controller.get()
    private fun Reader.state() = content.findViewTreeLifecycleOwner()!!.lifecycle.currentState
    private var destroyed = false
    private fun settle() { compose.waitForIdle() }

    @Before fun start() {
        Exact.owner = null; Exact.reader = null; Exact.live = true; Exact.unshown = false
        AuthTest.Environment.values.clear()
        controller.create().start().resume().visible()
    }

    @After fun finish() {
        if (!destroyed) controller.pause().stop().destroy()
        settle()
        Exact.owner = null; Exact.reader = null; Exact.live = false; Exact.unshown = false
    }

    @Test fun noModuleViewLeavesTheRootWithoutAndroidXOwners() {
        val root = activity.content
        assertEquals(android.app.Activity::class.java, ExactActivity::class.java.superclass)
        assertNull(root.findViewTreeLifecycleOwner())
        assertNull(root.findViewTreeSavedStateRegistryOwner())
        assertNull(root.findViewTreeViewModelStoreOwner())
        controller.pause().stop().start().resume()
        assertNull(root.findViewTreeLifecycleOwner())
    }

    @Test fun aPlainComposeModuleInheritsLazyOwnersAndIsRecreatedAfterAStop() {
        activity.mount()
        settle()
        val root = activity.content
        val view = activity.module.view
        val owner = root.findViewTreeLifecycleOwner()
        assertNotSame(activity, owner)
        for (child in listOf(root, view)) {
            assertSame(owner, child.findViewTreeLifecycleOwner())
            assertSame(owner, child.findViewTreeSavedStateRegistryOwner())
            assertSame(owner, child.findViewTreeViewModelStoreOwner())
        }
        val model = ViewModelProvider(root.findViewTreeViewModelStoreOwner()!!)[Model::class.java]
        activity.module.change("temporary")
        settle()
        assertEquals("temporary", activity.module.shown)
        assertEquals(Lifecycle.State.RESUMED, activity.state())
        controller.pause()
        assertEquals(Lifecycle.State.STARTED, activity.state())
        controller.stop()
        assertEquals(Lifecycle.State.CREATED, activity.state())
        controller.start().resume()
        activity.mount()
        settle()
        assertNotSame(view, activity.module.view)
        assertEquals("hello", activity.module.shown)
        assertSame(model, ViewModelProvider(root.findViewTreeViewModelStoreOwner()!!)[Model::class.java])
        activity.module.change("back again")
        settle()
        assertEquals("back again", activity.module.shown)
        activity.hosted.destroyAll()
        assertTrue(activity.module.disposed)
    }

    @Test fun recreationRestoresComposeStateAndRetainsTheViewModelUntilTheActivityEnds() {
        activity.mount()
        settle()
        val old = activity
        val model = ViewModelProvider(old.content.findViewTreeViewModelStoreOwner()!!)[Model::class.java]
        old.module.change("kept")
        settle()
        assertEquals("kept", old.module.shown)
        controller.recreate()
        activity.mount()
        settle()
        assertNotSame(old, activity)
        assertEquals(Lifecycle.State.DESTROYED, old.state())
        assertTrue(old.module.disposed)
        assertFalse(model.cleared)
        assertSame(model, ViewModelProvider(activity.content.findViewTreeViewModelStoreOwner()!!)[Model::class.java])
        assertEquals("kept", activity.module.shown)
        activity.finish()
        controller.pause().stop().destroy()
        destroyed = true
        assertTrue(model.cleared)
    }

    @Test fun aRecreatedActivityThatNeverMountsAModuleStillClearsItsRetainedStore() {
        activity.mount()
        settle()
        val model = ViewModelProvider(activity.content.findViewTreeViewModelStoreOwner()!!)[Model::class.java]
        controller.recreate()
        assertNull(activity.content.findViewTreeViewModelStoreOwner())
        assertFalse(model.cleared)
        activity.finish()
        controller.pause().stop().destroy()
        destroyed = true
        assertTrue(model.cleared)
    }

    @Test fun closingAMaterialDateOrTimePickerLeavesTheModuleComposed() {
        activity.mount()
        settle()
        val content = activity.findViewById<FrameLayout>(android.R.id.content)
        for ((kind, value) in listOf("date" to "2026-11-24", "time" to "14:05")) {
            val answers = ArrayList<String?>()
            val close = materialPickers!!.show(activity, ExactPicker(kind, value, "", "", ""), {}) { answers += it }
            settle()
            val picker = content.getChildAt(1) as ComposeView
            val owner = picker.findViewTreeLifecycleOwner()!!
            assertNotSame(activity, owner)
            assertEquals(Lifecycle.State.RESUMED, owner.lifecycle.currentState)
            assertTrue(picker.hasComposition)
            close()
            close()
            settle()
            assertEquals(listOf<String?>(null), answers)
            assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
            assertFalse(picker.hasComposition)
            assertEquals(1, content.childCount)
            assertFalse(activity.module.disposed)
            assertEquals("hello", activity.module.shown)
        }
    }
}
