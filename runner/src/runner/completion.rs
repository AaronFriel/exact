//! Runner-issued one-shot replies (LLP 1172.019 §2 item 1, Carry; LLP 1172.005 E11).

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

/// Authority for one issued reply. Only the runner can mint it, and delivery
/// consumes it. Carry records identity without adding any refusal policy.
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
}

impl fmt::Debug for CompletionCapability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CompletionCapability")
            .field("session", &Arc::as_ptr(&self.identity.session))
            .field("generation", &Arc::as_ptr(&self.identity.generation))
            .field("ticket", &self.ticket)
            .field("owner", &self.owner)
            .field("class", &self.class)
            .finish()
    }
}

/// The one-shot authority shared by an outgoing request and its pending record.
/// Clones share one take: an integer-ticket host and a typed host cannot both
/// extract the capability. This sharing ends with the integer entry's migration.
#[derive(Clone, Debug)]
pub struct CompletionReply(Arc<Mutex<Option<CompletionCapability>>>);

impl CompletionReply {
    /// Take the runner's authority once, for [`Runner::deliver`].
    pub fn take(&self) -> Option<CompletionCapability> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Completion families admitted by the runner's typed delivery entry.
/// Subscription protocols and other host callbacks retain their current entries
/// until their carry slices land (LLP 1172.019 §2 item 1).
#[derive(Debug)]
pub enum Completion {
    /// A one-shot request outcome, with optional executor clock measurements.
    Reply {
        /// HTTP, storage, surface, module or failure outcome of the issued work.
        outcome: Outcome,
        /// Execution and delivery wait, apart from the seekable agent clock.
        timing: Option<crate::CompletionTiming>,
    },
}

impl<D: DataSource> Runner<D> {
    pub(super) fn issue_completions(&mut self, requests: &mut [RequestOut]) {
        for request in requests {
            if request.request.stream {
                continue;
            }
            let Some(pending) = self.pending.iter_mut().find(|p| p.ticket == request.ticket) else {
                continue;
            };
            let reply = CompletionReply(Arc::new(Mutex::new(Some(CompletionCapability {
                identity: self
                    .completion_identity
                    .get_or_init(Identity::default)
                    .clone(),
                ticket: pending.ticket,
                owner: pending.target,
                class: Class::UiOwned,
            }))));
            pending.completion = Some(reply.clone());
            request.completion = Some(reply);
        }
    }

    /// Deliver one issued completion. Carry preserves today's ticket semantics:
    /// identity is carried but not yet checked, and existing host guards stay.
    pub fn deliver(
        &mut self,
        capability: CompletionCapability,
        completion: Completion,
    ) -> Result<Option<CommitReceipt>, RunnerError> {
        self.deliver_reply(capability.ticket, completion)
    }
}

#[cfg(test)]
mod tests;
