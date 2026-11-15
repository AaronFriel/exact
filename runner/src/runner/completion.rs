//! Runner-issued replies and subscriptions (LLP 1172.019 §2 item 1, Carry).

use super::{CommitReceipt, DataSource, Outcome, RequestOut, Runner, RunnerError, Target};
use std::fmt;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(super) struct Identity {
    session: Arc<()>,
    generation: Arc<()>,
}

#[derive(Debug)]
enum Class {
    UiOwned,
}

#[derive(Clone, Copy, Debug)]
enum Protocol {
    Reply,
    Subscription,
}

/// Authority for one issued delivery. Only the runner can mint it. A one-shot
/// reply moves it; a subscription borrows its binding for each delivery.
/// Carry records identity without adding any refusal policy.
///
/// ```compile_fail
/// use exact_runner::CompletionCapability;
/// fn duplicate(reply: CompletionCapability) -> CompletionCapability { reply.clone() }
/// ```
///
/// ```compile_fail
/// use exact_runner::CompletionCapability;
/// let reply = CompletionCapability { ticket: 1 };
/// ```
pub struct CompletionCapability {
    identity: Identity,
    ticket: u64,
    // The target and ticket name the existing pending record, which owns the
    // source, arguments and component row. No second request registry (E12).
    owner: Target,
    class: Class,
    protocol: Protocol,
}

impl fmt::Debug for CompletionCapability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CompletionCapability")
            .field("session", &Arc::as_ptr(&self.identity.session))
            .field("generation", &Arc::as_ptr(&self.identity.generation))
            .field("ticket", &self.ticket)
            .field("owner", &self.owner)
            .field("class", &self.class)
            .field("protocol", &self.protocol)
            .finish()
    }
}

/// Authority held for a stream or long poll's life, including its terminal
/// outcome. Clones share the runner's original binding; they do not reauthorize
/// a subscription. Deliveries are ordered by calls to [`Runner::deliver`],
/// including messages held behind a yielding mapper.
///
/// ```compile_fail
/// use exact_runner::CompletionSubscription;
/// let subscription = CompletionSubscription::default();
/// ```
///
/// ```compile_fail
/// use exact_runner::{CompletionReply, CompletionSubscription};
/// fn forge(binding: CompletionReply) -> CompletionSubscription {
///     CompletionSubscription { binding }
/// }
/// ```
#[derive(Clone, Debug)]
pub struct CompletionSubscription {
    binding: CompletionReply,
}

impl From<&CompletionSubscription> for CompletionCapability {
    fn from(subscription: &CompletionSubscription) -> Self {
        let slot = subscription
            .binding
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let binding = slot
            .as_ref()
            .expect("subscription binding lives with its holders");
        binding.subscription_delivery()
    }
}

impl CompletionCapability {
    fn subscription_delivery(&self) -> Self {
        Self {
            identity: self.identity.clone(),
            ticket: self.ticket,
            owner: self.owner,
            class: Class::UiOwned,
            protocol: Protocol::Subscription,
        }
    }
}

/// Authority shared by an outgoing request and its pending record. One-shot
/// clones share one take; subscription clones share one binding for its life.
#[derive(Clone, Debug)]
pub struct CompletionReply(Arc<Mutex<Option<CompletionCapability>>>);

impl CompletionReply {
    /// Take the runner's authority once, for [`Runner::deliver`].
    /// A subscription has no one-shot authority; use [`Self::subscription`].
    pub fn take(&self) -> Option<CompletionCapability> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(slot.as_ref()?.protocol, Protocol::Subscription) {
            return None;
        }
        slot.take()
    }

    /// The runner's reusable stream/long-poll binding, for [`Runner::deliver`].
    /// Borrow it on each delivery; neither an event nor its commit consumes it.
    pub fn subscription(&self) -> Option<CompletionSubscription> {
        let slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        matches!(slot.as_ref()?.protocol, Protocol::Subscription).then(|| CompletionSubscription {
            binding: self.clone(),
        })
    }

    pub(super) fn delivery(&self) -> Option<CompletionCapability> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref()?.protocol {
            Protocol::Subscription => Some(slot.as_ref()?.subscription_delivery()),
            Protocol::Reply => slot.take(),
        }
    }
}

/// Completion families admitted by the runner's typed delivery entry.
/// Other host callbacks retain their current entries until their carry slices
/// land (LLP 1172.019 §2 item 1).
#[derive(Debug)]
pub enum Completion {
    /// A one-shot request outcome, with optional executor clock measurements.
    Reply {
        /// HTTP, storage, surface, module or failure outcome of the issued work.
        outcome: Outcome,
        /// Execution and delivery wait, apart from the seekable agent clock.
        timing: Option<crate::CompletionTiming>,
    },
    /// A stream/long-poll event, batch, control reply or terminal outcome.
    Subscription {
        /// Delivered in arrival order under the subscription's original binding.
        outcome: Outcome,
        /// Execution and delivery wait, apart from the seekable agent clock.
        timing: Option<crate::CompletionTiming>,
    },
}

impl<D: DataSource> Runner<D> {
    pub(super) fn issue_completions(&mut self, requests: &mut [RequestOut]) {
        for request in requests {
            let Some(pending) = self.pending.iter_mut().find(|p| p.ticket == request.ticket) else {
                continue;
            };
            let capability = CompletionCapability {
                identity: self
                    .completion_identity
                    .get_or_init(Identity::default)
                    .clone(),
                ticket: pending.ticket,
                owner: pending.target,
                class: Class::UiOwned,
                protocol: if pending.stream.is_some() {
                    Protocol::Subscription
                } else {
                    Protocol::Reply
                },
            };
            let reply = CompletionReply(Arc::new(Mutex::new(Some(capability))));
            pending.completion = Some(reply.clone());
            request.completion = Some(reply);
        }
    }

    /// Deliver one issued completion: move a one-shot capability or borrow a
    /// [`CompletionSubscription`] for each ordered delivery. Carry preserves
    /// today's ticket semantics and host guards; it adds no identity refusal.
    pub fn deliver(
        &mut self,
        capability: impl Into<CompletionCapability>,
        completion: Completion,
    ) -> Result<Option<CommitReceipt>, RunnerError> {
        self.deliver_reply(capability.into().ticket, completion)
    }
}

#[cfg(test)]
mod tests;
