package dev.exact.canvas

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class OwnerRepliesTest {
    @Test fun anOrdinaryReplyDoesNotOvertakeAnEarlierInput() {
        val handler = ArrayDeque<() -> Unit>()
        var price = 0
        var selectedPrice = 0
        val replies = OwnerReplies({ handler.addLast(it) }) { _, value -> price = value!!.toInt() }
        replies.answer(1, "10")
        handler.addLast { selectedPrice = price }
        replies.answer(2, "20")

        while (handler.isNotEmpty()) handler.removeFirst().invoke()

        assertEquals(10, selectedPrice)
        assertEquals(20, price)
        assertTrue(replies.take().isEmpty())
    }

    @Test fun anAgentWaitTakesOnlyAnswersOnTheOwnerBeforeItsHandlerCanRun() {
        val owner = Executors.newSingleThreadExecutor()
        val handler = LinkedBlockingQueue<() -> Unit>()
        val waiting = CountDownLatch(1)
        val delivered = CountDownLatch(1)
        val applied = ArrayList<Pair<Int, String?>>()
        var ownerThread: Thread? = null
        var unrelated = false
        val apply = { id: Int, value: String? ->
            assertSame(ownerThread, Thread.currentThread())
            applied.add(id to value)
            Unit
        }
        val replies = OwnerReplies({ handler.add(it) }, apply)
        try {
            val clock = owner.submit {
                ownerThread = Thread.currentThread()
                waiting.countDown()
                assertTrue(delivered.await(10, TimeUnit.SECONDS))
                assertTrue(applied.isEmpty())
                for ((id, value) in replies.take()) apply(id, value)
                assertEquals(listOf(1 to "first", 2 to null), applied)
                assertFalse("a clock wait must not dispatch input or a frame", unrelated)
            }
            assertTrue(waiting.await(10, TimeUnit.SECONDS))
            handler.add { unrelated = true }
            replies.answer(1, "first")
            replies.answer(2, null)
            delivered.countDown()
            clock.get(10, TimeUnit.SECONDS)
            owner.submit {
                while (true) (handler.poll() ?: break).invoke()
                assertTrue(unrelated)
                assertEquals("the queued wake must not deliver an answer twice", 2, applied.size)
                replies.answer(3, "idle")
                handler.remove().invoke()
                assertEquals(listOf(1 to "first", 2 to null, 3 to "idle"), applied)
                assertTrue(replies.take().isEmpty())
            }.get(10, TimeUnit.SECONDS)
        } finally {
            delivered.countDown()
            owner.shutdownNow()
        }
    }
}
