//! Conditional arms are mount functions. Identical functions in the same lexical
//! scope share code. Each call still creates its own elements and effects.

use super::Em;
use crate::code::{self, Scope};
use std::{collections::HashMap, fmt::Write as _, rc::Rc};

#[derive(Hash, Eq, PartialEq)]
enum Part {
    Js(Box<str>),
    Site(u32),
    Arm(usize, Option<u32>),
}

impl Part {
    fn site(&mut self) -> Option<&mut u32> {
        match self {
            Self::Site(n) | Self::Arm(_, Some(n)) => Some(n),
            _ => None,
        }
    }
}

#[derive(Default)]
pub(super) struct Templates {
    bodies: Vec<Rc<[Part]>>,
    index: HashMap<Rc<[Part]>, usize>,
}

// Intermediate operands live only in the emitter's buffer. The JavaScript
// writer quotes strings, so even an authored NUL reaches the buffer escaped.
fn parts(source: &str) -> Vec<Part> {
    let mut result = Vec::new();
    let mut slices = source.split('\0');
    while let Some(js) = slices.next() {
        if !js.is_empty() {
            result.push(Part::Js(js.into()));
        }
        if let Some(operand) = slices.next() {
            result.push(if let Some(site) = operand.strip_prefix('s') {
                Part::Site(site.parse().expect("site"))
            } else {
                let (id, base) = operand
                    .split_once(':')
                    .map_or((operand, None), |(id, base)| {
                        (id, Some(base.parse().expect("arm site")))
                    });
                Part::Arm(id.parse().expect("arm"), base)
            });
        }
    }
    result
}

/// A plan site at the call, or an offset from the shared function's parameter.
#[derive(Clone, Copy)]
enum Base {
    Absolute(u32),
    Relative(u32),
}

impl Base {
    fn plus(self, n: u32) -> Base {
        match self {
            Self::Absolute(base) => Self::Absolute(base + n),
            Self::Relative(base) => Self::Relative(base + n),
        }
    }

    fn write(self, out: &mut String) {
        match self {
            Self::Absolute(n) => write!(out, "{n}").unwrap(),
            Self::Relative(0) => out.push_str("$site"),
            Self::Relative(n) => write!(out, "$site+{n}").unwrap(),
        }
    }
}

impl Templates {
    pub fn arm(&mut self, source: String) -> String {
        let mut body = parts(&source);
        let base = body.iter_mut().filter_map(Part::site).map(|n| *n).min();
        if let Some(base) = base {
            for site in body.iter_mut().filter_map(Part::site) {
                *site -= base;
            }
        }
        let id = match self.index.get(body.as_slice()) {
            Some(&id) => id,
            None => {
                let id = self.bodies.len();
                let body = Rc::<[Part]>::from(body);
                self.bodies.push(body.clone());
                self.index.insert(body, id);
                id
            }
        };
        match base {
            Some(base) => format!("\0{id}:{base}\0"),
            None => format!("\0{id}\0"),
        }
    }

    pub fn write(self, view: &str, out: &mut String) {
        if self.bodies.is_empty() && !view.contains('\0') {
            out.push_str(view);
            return;
        }
        let view = parts(view);
        let mut uses = vec![0usize; self.bodies.len()];
        for part in self.bodies.iter().flat_map(|body| body.iter()).chain(&view) {
            if let Part::Arm(id, _) = part {
                uses[*id] += 1;
            }
        }
        // Count edges in the shared graph. A child of one shared parent can
        // stay inline there, however often that parent is called.
        let names: Vec<_> = uses
            .iter()
            .enumerate()
            .map(|(id, &n)| {
                let name = format!("$v{id}");
                let len: usize = self.bodies[id]
                    .iter()
                    .map(|p| match p {
                        Part::Js(js) => js.len(),
                        _ => 1,
                    })
                    .sum();
                (n > 1 && (n - 1) * len > 8 + (n + 1) * name.len()).then_some(name)
            })
            .collect();
        let scoped = names.iter().any(Option::is_some);
        if scoped {
            out.push('{');
        }
        for (i, name) in names.iter().enumerate() {
            if let Some(name) = name {
                write!(out, "const {name}=").unwrap();
                if self.bodies[i]
                    .iter()
                    .any(|p| matches!(p, Part::Site(_) | Part::Arm(_, Some(_))))
                {
                    out.push_str("$site=>");
                }
                self.expand(&self.bodies[i], Base::Relative(0), &names, out);
                out.push(';');
            }
        }
        self.expand(&view, Base::Absolute(0), &names, out);
        if scoped {
            out.push('}');
        }
    }

    fn expand(&self, body: &[Part], base: Base, names: &[Option<String>], out: &mut String) {
        for part in body {
            match part {
                Part::Js(js) => out.push_str(js),
                Part::Site(n) => base.plus(*n).write(out),
                Part::Arm(id, site) => {
                    if let Some(name) = &names[*id] {
                        out.push_str(name);
                        if let Some(site) = site {
                            out.push('(');
                            base.plus(*site).write(out);
                            out.push(')');
                        }
                    } else {
                        self.expand(&self.bodies[*id], base.plus(site.unwrap_or(0)), names, out);
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
        let saved = std::mem::take(&mut self.out);
        render(self)?;
        let built = std::mem::replace(&mut self.out, saved);
        std::mem::replace(&mut self.arm_templates, outer).write(&built, &mut self.out);
        Ok(())
    }
}
