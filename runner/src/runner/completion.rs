//! Runner-issued request completions (LLP 1172.019 §2 item 1, Carry).

use super::{CommitReceipt, DataSource, Outcome, RequestOut, Runner, RunnerError, Target};
use std::fmt;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(super) struct Identity {
    session: Arc<()>,
    generation: Arc<()>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Owner {
    Ui(Target),
    Mapper { stream: u64, target: Target },
    ModuleWork,
    Background,
    Tool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    UiOwned,
    DurableProcessLocal,
}

#[derive(Clone, Copy, Debug)]
enum Protocol {
    Reply,
    Subscription,
    DurableOperation,
}

struct Binding {
    identity: Identity,
    ticket: u64,
    owner: Owner,
    class: Class,
    protocol: Protocol,
    taken: bool,
}

impl fmt::Debug for Binding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Binding")
            .field("session", &Arc::as_ptr(&self.identity.session))
            .field("generation", &Arc::as_ptr(&self.identity.generation))
            .field("ticket", &self.ticket)
            .field("owner", &self.owner)
            .field("class", &self.class)
            .field("protocol", &self.protocol)
            .field("taken", &self.taken)
            .finish()
    }
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
/// use exact_runner::{CompletionCapability, CompletionReply};
/// fn forge(binding: CompletionReply) -> CompletionCapability {
///     CompletionCapability { binding }
/// }
/// ```
#[derive(Debug)]
pub struct CompletionCapability {
    binding: CompletionReply,
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
        Self {
            binding: subscription.binding.clone(),
        }
    }
}

/// Authority shared by an outgoing request and its lifetime record. One-shot
/// and durable-round clones share one take; subscriptions keep their binding.
#[derive(Clone, Debug)]
pub struct CompletionReply(Arc<Mutex<Binding>>);

impl CompletionReply {
    /// Take the runner's authority once, for [`Runner::deliver`].
    /// A subscription has no one-shot authority; use [`Self::subscription`].
    pub fn take(&self) -> Option<CompletionCapability> {
        let mut binding = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(binding.protocol, Protocol::Subscription) || binding.taken {
            return None;
        }
        binding.taken = true;
        Some(CompletionCapability {
            binding: self.clone(),
        })
    }

    /// The runner's reusable stream/long-poll binding, for [`Runner::deliver`].
    /// Borrow it on each delivery; neither an event nor its commit consumes it.
    pub fn subscription(&self) -> Option<CompletionSubscription> {
        let binding = self.0.lock().unwrap_or_else(|e| e.into_inner());
        matches!(binding.protocol, Protocol::Subscription).then(|| CompletionSubscription {
            binding: self.clone(),
        })
    }

    pub(super) fn retain(&self) {
        let mut binding = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // The host may already have extracted its capability. Transfer the
        // shared binding, never mint a replacement (LLP 1172.019 Carry).
        binding.owner = Owner::ModuleWork;
        binding.class = Class::DurableProcessLocal;
        binding.protocol = Protocol::DurableOperation;
    }

    pub(super) fn delivery(&self) -> Option<CompletionCapability> {
        let mut binding = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(binding.protocol, Protocol::Subscription) {
            if binding.taken {
                return None;
            }
            binding.taken = true;
        }
        Some(CompletionCapability {
            binding: self.clone(),
        })
    }

    pub(super) fn completion(
        &self,
        outcome: Outcome,
        timing: Option<crate::CompletionTiming>,
    ) -> Completion {
        match self.0.lock().unwrap_or_else(|e| e.into_inner()).protocol {
            Protocol::Reply => Completion::Reply { outcome, timing },
            Protocol::Subscription => Completion::Subscription { outcome, timing },
            Protocol::DurableOperation => Completion::DurableOperation { outcome, timing },
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
    /// A background/tool round or retained module request. Its authority
    /// survives UI retirement, but is process-local: no crash recovery or
    /// blind retry is added by carry (LLP 1172.019 §3 inventory).
    DurableOperation {
        /// The one outcome of this round; a successor gets fresh authority.
        outcome: Outcome,
        /// Execution and delivery wait, apart from the seekable agent clock.
        timing: Option<crate::CompletionTiming>,
    },
}

impl<D: DataSource> Runner<D> {
    fn completion_record(&mut self, ticket: u64) -> Option<(Owner, &mut Option<CompletionReply>)> {
        if self.is_background(ticket) {
            return Some((Owner::Background, &mut self.background.completion));
        }
        if self.is_tool(ticket) {
            return Some((Owner::Tool, self.tool_completion(ticket)?));
        }
        if self.is_module_work(ticket) {
            return Some((Owner::ModuleWork, self.module_work.completion(ticket)?));
        }
        if let Some((owner, slot)) = self.mapper_turns.completion(ticket) {
            return Some((owner, slot));
        }
        let p = self.pending.iter_mut().find(|p| p.ticket == ticket)?;
        Some((Owner::Ui(p.target), &mut p.completion))
    }

    pub(super) fn request_completion(&mut self, ticket: u64) -> Option<CompletionReply> {
        self.completion_record(ticket)?.1.clone()
    }

    pub(super) fn issue_completions(&mut self, requests: &mut [RequestOut]) {
        for request in requests {
            let subscription = self
                .pending
                .iter()
                .any(|p| p.ticket == request.ticket && p.stream.is_some());
            let identity = self
                .completion_identity
                .get_or_init(Identity::default)
                .clone();
            let Some((owner, slot)) = self.completion_record(request.ticket) else {
                continue;
            };
            let reply = slot.get_or_insert_with(|| {
                CompletionReply(Arc::new(Mutex::new(Binding {
                    identity,
                    ticket: request.ticket,
                    owner,
                    class: match owner {
                        Owner::Ui(_) | Owner::Mapper { .. } => Class::UiOwned,
                        _ => Class::DurableProcessLocal,
                    },
                    protocol: match owner {
                        Owner::ModuleWork | Owner::Background | Owner::Tool => {
                            Protocol::DurableOperation
                        }
                        _ if subscription => Protocol::Subscription,
                        _ => Protocol::Reply,
                    },
                    taken: false,
                })))
            });
            request.completion = Some(reply.clone());
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
        let capability = capability.into();
        let binding = capability
            .binding
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let ticket = binding.ticket;
        drop(binding);
        self.deliver_reply(ticket, completion)
    }
}

#[cfg(test)]
mod tests;
