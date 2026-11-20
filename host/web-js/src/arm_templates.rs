//! Conditional arms share a mount function within their lexical scope. Root
//! getters, handlers and literal props may differ at each call. The function
//! takes those differences as arguments and creates fresh elements and effects.

use super::Em;
use crate::code::{self, Scope};
use std::{collections::HashMap, fmt::Write as _, rc::Rc};

#[derive(Clone, Hash, Eq, PartialEq)]
enum Value {
    Js(Rc<str>),
    Param(usize),
}

#[derive(Clone, Hash, Eq, PartialEq)]
struct Call {
    id: usize,
    base: Option<u32>,
    args: Vec<Value>,
}

#[derive(Clone, Hash, Eq, PartialEq)]
enum Part {
    Js(Box<str>),
    Site(u32),
    Value(Value),
    Arm(Call),
}

impl Part {
    fn site(&mut self) -> Option<&mut u32> {
        match self {
            Self::Site(n) | Self::Arm(Call { base: Some(n), .. }) => Some(n),
            _ => None,
        }
    }
    fn values(&mut self) -> &mut [Value] {
        match self {
            Self::Value(value) => std::slice::from_mut(value),
            Self::Arm(call) => &mut call.args,
            _ => &mut [],
        }
    }
}

struct Template {
    body: Rc<[Part]>,
    site: bool,
    columns: Vec<Column>,
}

struct Column {
    fixed: Option<Rc<str>>,
    /// First occurrence with the same argument at every call seen so far.
    first: usize,
}

impl Template {
    fn observe(&mut self, args: &[Rc<str>]) {
        let mut firsts = HashMap::new();
        for (i, (column, arg)) in self.columns.iter_mut().zip(args).enumerate() {
            if column.fixed.as_ref() != Some(arg) {
                column.fixed = None;
            }
            column.first = *firsts.entry((column.first, arg)).or_insert(i);
        }
    }
}

#[derive(Default)]
pub(super) struct Templates {
    depth: usize,
    bodies: Vec<Template>,
    index: HashMap<Rc<[Part]>, usize>,
    calls: Vec<Call>,
}

#[derive(Clone, Copy)]
enum Base {
    Absolute(u32),
    Enclosing(u32),
    Relative(u32),
}

impl Base {
    fn plus(self, n: u32) -> Base {
        match self {
            Self::Absolute(base) => Self::Absolute(base + n),
            Self::Enclosing(base) => Self::Enclosing(base + n),
            Self::Relative(base) => Self::Relative(base + n),
        }
    }

    fn js(self) -> String {
        match self {
            Self::Absolute(n) => n.to_string(),
            Self::Enclosing(n) => format!("\0s{n}\0"),
            Self::Relative(0) => "$site".into(),
            Self::Relative(n) => format!("$site+{n}"),
        }
    }
}

impl Templates {
    // The JS writer quotes authored strings, so source NULs arrive escaped.
    fn parts(&self, source: &str) -> Vec<Part> {
        let mut result = Vec::new();
        let mut slices = source.split('\0');
        while let Some(js) = slices.next() {
            if !js.is_empty() {
                result.push(Part::Js(js.into()));
            }
            if let Some(op) = slices.next() {
                result.push(if let Some(site) = op.strip_prefix('s') {
                    Part::Site(site.parse().expect("site"))
                } else if let Some(js) = op.strip_prefix("v:") {
                    Part::Value(Value::Js(js.into()))
                } else {
                    let i: usize = op.parse().expect("arm call");
                    Part::Arm(self.calls[i].clone())
                });
            }
        }
        result
    }

    pub fn arm(&mut self, source: String, parent_site: u32) -> String {
        let mut body = self.parts(&source);
        // A region subject can report its enclosing element. Two uses under
        // the same element move their descendants while keeping that site.
        for part in &mut body {
            if matches!(part, Part::Site(n) if *n == parent_site) {
                *part = Part::Value(Value::Js(parent_site.to_string().into()));
            }
        }
        let base = body.iter_mut().filter_map(Part::site).map(|n| *n).min();
        if let Some(base) = base {
            for site in body.iter_mut().filter_map(Part::site) {
                *site -= base;
            }
        }

        let mut args = Vec::new();
        for value in body.iter_mut().flat_map(Part::values) {
            let i = args.len();
            let Value::Js(js) = std::mem::replace(value, Value::Param(i)) else {
                unreachable!()
            };
            args.push(js);
        }
        let id = match self.index.get(body.as_slice()) {
            Some(&id) => id,
            None => {
                let id = self.bodies.len();
                let body: Rc<[Part]> = body.into();
                self.index.insert(body.clone(), id);
                self.bodies.push(Template {
                    body,
                    site: base.is_some(),
                    columns: args
                        .iter()
                        .map(|js| Column {
                            fixed: Some(js.clone()),
                            first: 0,
                        })
                        .collect(),
                });
                id
            }
        };
        self.bodies[id].observe(&args);
        let call = self.calls.len();
        self.calls.push(Call {
            id,
            base,
            args: args.into_iter().map(Value::Js).collect(),
        });
        format!("\0{call}\0")
    }

    pub fn write(self, view: &str, enclosing: bool, out: &mut String) {
        if self.bodies.is_empty() && !view.contains('\0') {
            out.push_str(view);
            return;
        }
        let view = self.parts(view);
        let mut uses = vec![0usize; self.bodies.len()];
        for part in self.bodies.iter().flat_map(|t| t.body.iter()).chain(&view) {
            if let Part::Arm(call) = part {
                uses[call.id] += 1;
            }
        }
        // Count edges in the shared graph. A child of one shared parent can
        // stay inline there, however often that parent is called.
        let names: Vec<_> = self
            .bodies
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let name = format!("$v{i}");
                let len: usize = t
                    .body
                    .iter()
                    .map(|p| if let Part::Js(js) = p { js.len() } else { 1 })
                    .sum();
                let n = uses[i];
                (n > 1 && (n - 1) * len > 8 + (n + 1) * name.len()).then_some(name)
            })
            .collect();
        let render = Render {
            templates: &self,
            names: &names,
            enclosing,
        };
        let scoped = names.iter().any(Option::is_some);
        if scoped {
            out.push('{');
        }
        for (i, name) in names.iter().enumerate() {
            if let Some(name) = name {
                let t = &self.bodies[i];
                let mut params = Vec::new();
                if t.site {
                    params.push("$site".to_string());
                }
                let mut captures = HashMap::new();
                let env = format!("$c{}", self.depth);
                let values: Vec<_> = t
                    .columns
                    .iter()
                    .map(|column| {
                        if let Some(js) = &column.fixed {
                            render.operand(js)
                        } else {
                            let next = captures.len();
                            let index = captures.entry(column.first).or_insert(next);
                            Rc::from(format!("{env}[{index}]"))
                        }
                    })
                    .collect();
                if !captures.is_empty() {
                    params.push(env);
                }
                write!(out, "const {name}=").unwrap();
                if !params.is_empty() {
                    write!(out, "({})=>", params.join(",")).unwrap();
                }
                render.expand(&t.body, Base::Relative(0), &values, out);
                out.push(';');
            }
        }
        let base = if enclosing {
            Base::Enclosing(0)
        } else {
            Base::Absolute(0)
        };
        render.expand(&view, base, &[], out);
        if scoped {
            out.push('}');
        }
    }
}

struct Render<'a> {
    templates: &'a Templates,
    names: &'a [Option<String>],
    enclosing: bool,
}

impl Render<'_> {
    fn operand(&self, js: &Rc<str>) -> Rc<str> {
        if self.enclosing {
            Rc::from(format!("\0v:{js}\0"))
        } else {
            js.clone()
        }
    }

    fn value(&self, value: &Value, args: &[Rc<str>]) -> Rc<str> {
        match value {
            Value::Js(js) => self.operand(js),
            Value::Param(i) => args[*i].clone(),
        }
    }

    fn expand(&self, body: &[Part], base: Base, args: &[Rc<str>], out: &mut String) {
        for part in body {
            match part {
                Part::Js(js) => out.push_str(js),
                Part::Site(n) => out.push_str(&base.plus(*n).js()),
                Part::Value(value) => out.push_str(&self.value(value, args)),
                Part::Arm(call) => {
                    let t = &self.templates.bodies[call.id];
                    if let Some(name) = &self.names[call.id] {
                        out.push_str(name);
                        let mut inputs: Vec<_> =
                            call.base.map(|n| base.plus(n).js()).into_iter().collect();
                        let captures: Vec<_> = t
                            .columns
                            .iter()
                            .enumerate()
                            .filter(|(i, column)| column.fixed.is_none() && column.first == *i)
                            .map(|(i, _)| self.value(&call.args[i], args))
                            .collect();
                        if !captures.is_empty() {
                            inputs.push(format!("[{}]", captures.join(",")));
                        }
                        if !inputs.is_empty() {
                            write!(out, "({})", inputs.join(",")).unwrap();
                        }
                    } else {
                        let values: Vec<_> =
                            call.args.iter().map(|v| self.value(v, args)).collect();
                        self.expand(&t.body, base.plus(call.base.unwrap_or(0)), &values, out);
                    }
                }
            }
        }
    }
}

impl Em<'_> {
    pub(super) fn site_number(&self, n: u32) -> String {
        if self.arm_element.is_some() {
            format!("\0s{n}\0")
        } else {
            n.to_string()
        }
    }

    pub(super) fn site_evaluation(
        &self,
        scope: &Scope,
        n: u32,
        what: String,
        instance: bool,
    ) -> Scope {
        if self.arm_element.is_none() {
            return code::evaluation(scope, format!("site {n} {what}"), instance);
        }
        let suffix = serde_json::to_string(&format!(" {what}")).unwrap();
        let label = format!(r#""site "+({})+{suffix}"#, self.site_number(n));
        Scope {
            evaluation: Some((label, instance)),
            ..scope.clone()
        }
    }

    /// Descendant arms may close over bindings introduced here, including a
    /// keyed row's getters or the DOM element that owns a navigation status.
    pub(super) fn template_scope(
        &mut self,
        new_scope: bool,
        render: impl FnOnce(&mut Self) -> Result<(), String>,
    ) -> Result<(), String> {
        if !new_scope {
            return render(self);
        }
        let outer = std::mem::take(&mut self.arm_templates);
        self.arm_templates.depth = outer.depth + 1;
        let saved = std::mem::take(&mut self.out);
        render(self)?;
        let built = std::mem::replace(&mut self.out, saved);
        std::mem::replace(&mut self.arm_templates, outer).write(
            &built,
            self.arm_element.is_some(),
            &mut self.out,
        );
        Ok(())
    }
}
