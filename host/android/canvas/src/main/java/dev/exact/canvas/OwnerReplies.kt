package dev.exact.canvas

/** Answers may arrive while an agent operation holds the owner. Only that owner takes them, either
 * inside the operation's wait or in the posted handler turn; neither path dispatches other handler jobs. */
internal class OwnerReplies(private val post: (() -> Unit) -> Unit, private val apply: (Int, String?) -> Unit) {
    private val pending = ArrayDeque<Pair<Int, String?>>()

    fun answer(id: Int, value: String?) {
        val reply = id to value
        synchronized(pending) { pending.addLast(reply) }
        post {
            if (synchronized(pending) { pending.removeAll { it === reply } }) apply(id, value)
        }
    }

    fun take(): List<Pair<Int, String?>> = synchronized(pending) {
        pending.toList().also { pending.clear() }
    }
}
