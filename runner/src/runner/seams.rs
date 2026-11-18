//! What the core composes from the runner's optional parts (LLP 1047.001
//! D11): the native modules, tool calls and presence secrets each answer
//! their own part, and the core joins them, so that a part can be absent.

use super::{DataSource, Runner};
use serde_json::Value as Json;

impl<D: DataSource> Runner<D> {
    /// Whether nothing outside the collections waits to be output: no
    /// package view, fed canvas or held module call, no process work on the
    /// agent's clock, and no wake, tool call or presence secret due.
    pub(in crate::runner) fn collection_output_quiet(&self) -> bool {
        self.modules_quiet()
            && !self.has_work_clock()
            && self.wake_due().is_none()
            && self.call_due().is_none()
            && self.presence_due_ms().is_none()
    }

    /// Each list and value the plan's modules declare, by its state name,
    /// as the agent's state shows it (`"notifications": [{…, "ref": 7,
    /// "delivered": true}]`, `"badge": 3`), and the app's tools with the
    /// system's calls of them as `intents` (LLP 1133.023 §10). Empty for a
    /// plan that declares none.
    pub fn declared_state(&self) -> Vec<(String, Json)> {
        let mut out = self.module_declared_state();
        if let Some(intents) = self.intents_state() {
            out.insert("intents".into(), intents);
        }
        out.into_iter().collect()
    }

    /// [`Self::declared_state`] as the agent's state writes it: `,"name":value` each.
    pub fn declared_state_json(&self, s: &mut String) {
        for (name, value) in self.declared_state() {
            s.push(',');
            s.push_str(&Json::String(name).to_string());
            s.push(':');
            s.push_str(&value.to_string());
        }
    }
}
