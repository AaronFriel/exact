package dev.exact.canvas

/** Answers, and topics extensions announce, may arrive while an agent operation holds the owner. Only that owner
 * takes them, in the order they arrived, either inside the operation's wait or in the posted handler turn; neither
 * path dispatches other handler jobs. A topic goes this way so that an extension's change made before its answer is
 * taken with that answer: the operation then waits for what the change asks again. */
internal class OwnerReplies(
    private val post: (() -> Unit) -> Unit,
    private val announce: (String) -> Unit,
    private val apply: (Int, String?) -> Unit,
) {
    /** The answer to request [id] (null: its cancellation), or, where [id] is null, the topic [value]. */
    class Handed(val id: Int?, val value: String?)

    private val pending = ArrayDeque<Handed>()

    fun answer(id: Int, value: String?) = hand(Handed(id, value))

    fun changed(topic: String) = hand(Handed(null, topic))

    private fun hand(handed: Handed) {
        synchronized(pending) { pending.addLast(handed) }
        post {
            if (synchronized(pending) { pending.removeAll { it === handed } }) deliver(handed)
        }
    }

    /** [handed] applied on the owner: the posted turn's, or an agent wait's for what it took. */
    fun deliver(handed: Handed) {
        val id = handed.id
        if (id == null) announce(handed.value!!) else apply(id, handed.value)
    }

    fun take(): List<Handed> = synchronized(pending) {
        pending.toList().also { pending.clear() }
    }
}
