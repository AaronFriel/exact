package dev.exact.canvas

import android.os.Bundle
import android.view.View
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner

/** Made at the first module or hatch view, never at launch (LLP 1115.001.000 D2). */
internal class ModuleOwners(root: View, state: Bundle?, retained: Any?) : SavedStateRegistryOwner, ViewModelStoreOwner {
    private val registry = LifecycleRegistry(this)
    private val saved = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = registry
    override val savedStateRegistry get() = saved.savedStateRegistry
    override val viewModelStore = retained as? ViewModelStore ?: ViewModelStore()

    init {
        saved.performAttach()
        saved.performRestore(state)
        // Compose's window recomposer reads the content child, rather than the requesting view.
        root.setViewTreeLifecycleOwner(this)
        root.setViewTreeSavedStateRegistryOwner(this)
        root.setViewTreeViewModelStoreOwner(this)
    }

    fun move(phase: Int) {
        registry.currentState = when (phase) {
            3 -> Lifecycle.State.RESUMED
            2 -> Lifecycle.State.STARTED
            else -> Lifecycle.State.CREATED
        }
    }

    fun save(): Bundle {
        registry.currentState = Lifecycle.State.CREATED
        return Bundle().also { saved.performSave(it) }
    }

    fun destroy(recreating: Boolean) {
        registry.currentState = Lifecycle.State.DESTROYED
        if (!recreating) viewModelStore.clear()
    }

    companion object {
        fun clear(retained: Any) { (retained as? ViewModelStore)?.clear() }
    }
}
