//! What the core composes from the runner's optional parts (LLP 1047.001
//! D11): the native modules, tool calls and presence secrets each answer
//! their own part, and the core joins them, so that a part can be absent.
//!
//! Each part is a seam: a trait whose methods take the runner, implemented
//! by a unit struct of the part (`LinkedTools`), which only an entry's
//! [`ModuleLinks`] names, so a binary that does not link the part holds
//! none of its code. A seam's provided methods are what the core does
//! without the part, which is what an empty table did before: the boot
//! uses them whenever the plan has none of the part's rows.

use super::calls::{CallHow, LinkedTools};
use super::{CommitReceipt, DataSource, Runner, RunnerError};
use serde_json::{json, Value as Json};

/// What a runner links of its optional parts, chosen by an entry's
/// composition (LLP 1047.001 D11): every part for the plain boots
/// ([`ModuleLinks::ALL`]).
pub struct ModuleLinks<D: DataSource> {
    /// Tool calls (LLP 1111), for a plan with tools.
    pub tools: &'static dyn Tools<D>,
}

impl<D: DataSource> Clone for ModuleLinks<D> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<D: DataSource> Copy for ModuleLinks<D> {}

impl<D: DataSource> ModuleLinks<D> {
    /// Every part.
    pub const ALL: ModuleLinks<D> = ModuleLinks {
        tools: &LinkedTools,
    };

    /// No part: the core alone.
    pub const NONE: ModuleLinks<D> = ModuleLinks { tools: &NoTools };

    /// The parts `plan` uses of these: a part whose rows the plan lacks is
    /// left out, so the core answers as for an empty table.
    pub(in crate::runner) fn for_plan(self, plan: &exact_plan::Plan) -> Self {
        ModuleLinks {
            tools: match plan.tools.is_empty() {
                true => &NoTools,
                false => self.tools,
            },
        }
    }
}

/// The tool seam (LLP 1047.001 D11 item 3): the calls a door hands the
/// runner (`calls.rs`). Each provided method is the answer with no tool.
pub trait Tools<D: DataSource> {
    /// A door's call of `tool`: [`Runner::call_tool`].
    fn call_tool(&self, r: &mut Runner<D>, tool: &str, _: &str, _: CallHow) -> Result<u64, String> {
        let _ = r;
        Err(format!("no tool `{tool}`: this app declares none"))
    }
    /// Whether a call is between dispatch and its end.
    fn call_running(&self, _: &Runner<D>) -> bool {
        false
    }
    /// Run what is due of the calls.
    fn step_calls(&self, _: &mut Runner<D>) -> (Vec<CommitReceipt>, Option<RunnerError>) {
        (Vec::new(), None)
    }
    /// Invocation `id`'s work was let go of by a commit that stood.
    fn call_superseded(&self, _: &mut Runner<D>, _: u64, _: bool) {}
    /// A name that needs a person was called by the running call's work.
    fn call_person_required(&self, _: &mut Runner<D>) {}
    /// Take off this commit's commands from `first` that a call does not run.
    fn skip_in_call(&self, _: &mut Runner<D>, _: usize) {}
    /// Whether a running call is in a session no one sees.
    fn call_stops_timers(&self, _: &Runner<D>) -> bool {
        false
    }
    /// When the host should next advance for the calls.
    fn call_due(&self, _: &Runner<D>) -> Option<f64> {
        None
    }
    /// Call `id`'s caller cancelled it.
    fn cancel_call(&self, _: &mut Runner<D>, id: u64) -> Result<String, String> {
        Err(format!("no call {id}"))
    }
    /// Call `id` as its door polls it.
    fn call_answer(&self, _: &Runner<D>, id: u64) -> Result<String, String> {
        Err(format!("no call {id}"))
    }
    /// `state.intents`.
    fn intents_state(&self, _: &Runner<D>) -> Option<Json> {
        None
    }
}

/// The tool seam, not linked.
struct NoTools;

impl<D: DataSource> Tools<D> for NoTools {}

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

    /// A door's call of `tool` with `args`, a JSON object: queued, and its
    /// invocation id answered. `Err` for a tool the plan does not name.
    pub fn call_tool(&mut self, tool: &str, args: &str, how: CallHow) -> Result<u64, String> {
        let t = self.links_tools();
        t.call_tool(self, tool, args, how)
    }

    pub(in crate::runner) fn call_running(&self) -> bool {
        self.links_tools().call_running(self)
    }

    pub(in crate::runner) fn step_calls(&mut self) -> (Vec<CommitReceipt>, Option<RunnerError>) {
        let t = self.links_tools();
        t.step_calls(self)
    }

    pub(in crate::runner) fn call_superseded(&mut self, id: u64, send: bool) {
        let t = self.links_tools();
        t.call_superseded(self, id, send)
    }

    pub(in crate::runner) fn call_person_required(&mut self) {
        let t = self.links_tools();
        t.call_person_required(self)
    }

    pub(in crate::runner) fn skip_in_call(&mut self, first: usize) {
        let t = self.links_tools();
        t.skip_in_call(self, first)
    }

    pub(in crate::runner) fn call_stops_timers(&self) -> bool {
        self.links_tools().call_stops_timers(self)
    }

    pub(in crate::runner) fn call_due(&self) -> Option<f64> {
        self.links_tools().call_due(self)
    }

    fn cancel_call(&mut self, id: u64) -> Result<String, String> {
        let t = self.links_tools();
        t.cancel_call(self, id)
    }

    fn call_answer(&self, id: u64) -> Result<String, String> {
        self.links_tools().call_answer(self, id)
    }

    /// `state.intents`: each tool with its word, modifiers, availability
    /// and face, and the calls running, waiting and ended, never their
    /// arguments (LLP 1133.023 §10).
    pub fn intents_state(&self) -> Option<Json> {
        self.links_tools().intents_state(self)
    }

    fn links_tools(&self) -> &'static dyn Tools<D> {
        self.seams.tools
    }

    /// The agent's `call` (`{"op":"call","tool","args","door"}`, queued
    /// as the door would hand it), a launch's `--call '<tool> <json>'`
    /// (`{"op":"launchEntry","launch":"call","entry"}`: a cold call in a
    /// session no one sees, as a system's call boots one), a door's poll of
    /// its call (`{"op":"called","id"}`), its caller's cancellation
    /// (`{"op":"cancel","id"}`). `None` for any other op.
    pub fn call_agent(&mut self, op: &str, request: &str) -> Option<Result<String, String>> {
        let v: Json = serde_json::from_str(request).ok()?;
        match op {
            "launchEntry" if v["launch"] == "call" => {
                let entry = v["entry"].as_str().unwrap_or_default().trim();
                let (tool, args) = entry
                    .split_once(char::is_whitespace)
                    .unwrap_or((entry, "{}"));
                let how = CallHow {
                    door: v["door"].as_str().unwrap_or("agent").to_owned(),
                    cold: true,
                    hidden: true,
                    digest: None,
                };
                self.log(format!("launch --call ({tool})"));
                let id = self.call_tool(tool, args.trim(), how);
                Some(id.map(|id| json!({ "call": id, "tool": tool, "cold": true }).to_string()))
            }
            "call" => {
                let tool = v["tool"].as_str().unwrap_or_default().to_owned();
                let args = match &v["args"] {
                    Json::String(text) => text.clone(),
                    args => args.to_string(),
                };
                let how = CallHow {
                    door: v["door"].as_str().unwrap_or("agent").to_owned(),
                    cold: v["cold"] == true,
                    hidden: v["hidden"] == true,
                    digest: v["digest"].as_str().map(str::to_owned),
                };
                let id = self.call_tool(&tool, &args, how);
                Some(
                    id.map(|id| {
                        json!({ "call": id, "tool": tool, "state": "waiting" }).to_string()
                    }),
                )
            }
            "called" => Some(match v["id"].as_u64() {
                Some(id) => self.call_answer(id),
                None => Err("called needs the call's id".into()),
            }),
            "cancel" => Some(match v["id"].as_u64() {
                Some(id) => self.cancel_call(id),
                None => Err("cancel needs the call's id".into()),
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{CallHow, DataError, DataSource, Runner, Value};
    use exact_kernel::Kernel;

    struct Empty;

    impl DataSource for Empty {
        fn query(&mut self, source: &str, _: &[Value]) -> Result<Value, DataError> {
            Err(DataError::UnknownSource(source.into()))
        }
    }

    #[test]
    fn a_plan_with_no_tools_answers_a_door_and_the_agent_without_the_tool_seam() {
        let source = "component App\n  view\n    text \"hello\"\n";
        let plan = contract::compile(source).unwrap();
        let mut r = Runner::boot(
            plan,
            Empty,
            Kernel::with_monospace(),
            Default::default(),
            "/",
        )
        .unwrap();
        assert_eq!(
            r.call_tool("save", "{}", CallHow::default()),
            Err("no tool `save`: this app declares none".into())
        );
        let call = r#"{"tool":"save","args":{}}"#;
        assert_eq!(
            r.call_agent("call", call),
            Some(Err("no tool `save`: this app declares none".into()))
        );
        assert_eq!(
            r.call_agent("called", r#"{"id":3}"#),
            Some(Err("no call 3".into()))
        );
        assert_eq!(
            r.call_agent("cancel", r#"{"id":3}"#),
            Some(Err("no call 3".into()))
        );
        assert_eq!(r.intents_state(), None);
        assert!(r.declared_state().is_empty());
        assert!(!r.call_running() && r.call_due().is_none() && !r.call_stops_timers());
    }
}
