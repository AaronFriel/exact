//! Shared JavaScript expressions and mount functions. A call supplies the
//! operands that differ between uses of the same body in one lexical scope.
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
    parent: Option<Box<str>>,
}

#[derive(Clone, Hash, Eq, PartialEq)]
enum Part {
    Js(Box<str>),
    Site(u32),
    Value(Value),
    Call(Call),
}

impl Part {
    fn site(&mut self) -> Option<&mut u32> {
        match self {
            Self::Site(n) | Self::Call(Call { base: Some(n), .. }) => Some(n),
            _ => None,
        }
    }
    fn values(&mut self) -> &mut [Value] {
        match self {
            Self::Value(value) => std::slice::from_mut(value),
            Self::Call(call) => &mut call.args,
            _ => &mut [],
        }
    }
}

struct Template {
    body: Rc<[Part]>,
    /// Mounts also take DOM parameters. An expression factory takes only its captures.
    params: Option<Rc<str>>,
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
    pub(super) depth: usize,
    bodies: Vec<Template>,
    index: HashMap<Option<Rc<str>>, HashMap<Rc<[Part]>, usize>>,
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
                    let i: usize = op.parse().expect("template call");
                    Part::Call(self.calls[i].clone())
                });
            }
        }
        result
    }

    pub fn mount(
        &mut self,
        params: &str,
        source: String,
        parent: Option<&str>,
        parent_site: Option<u32>,
    ) -> String {
        self.intern(Some(params), source, parent, parent_site)
    }

    pub fn expression(&mut self, source: String) -> String {
        self.intern(None, source, None, None)
    }

    fn intern(
        &mut self,
        params: Option<&str>,
        source: String,
        parent: Option<&str>,
        parent_site: Option<u32>,
    ) -> String {
        let mut body = self.parts(&source);
        // A region subject can report its enclosing element. Two uses under
        // the same element move their descendants while keeping that site.
        if let Some(parent) = parent_site {
            for part in &mut body {
                if matches!(part, Part::Site(n) if *n == parent) {
                    *part = Part::Value(Value::Js(parent.to_string().into()));
                }
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
        let params: Option<Rc<str>> = params.map(Into::into);
        let index = self.index.entry(params.clone()).or_default();
        let id = match index.get(body.as_slice()) {
            Some(&id) => id,
            None => {
                let id = self.bodies.len();
                let body: Rc<[Part]> = body.into();
                index.insert(body.clone(), id);
                self.bodies.push(Template {
                    body,
                    params,
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
            parent: parent.map(Into::into),
        });
        format!("\0{call}\0")
    }

    pub fn render(self, view: String, enclosing: bool, prefix: &str) -> (String, String) {
        if self.bodies.is_empty() && !view.contains('\0') {
            return (String::new(), view);
        }
        let view = self.parts(&view);
        let mut uses = vec![0usize; self.bodies.len()];
        for part in &view {
            if let Part::Call(call) = part {
                uses[call.id] += 1;
            }
        }
        // Children are interned first. An inlined parent copies its children
        // to every use. A shared parent emits them once.
        let mut names = vec![None; self.bodies.len()];
        for (i, t) in self.bodies.iter().enumerate().rev() {
            let n = uses[i];
            let name = format!("{prefix}{i}");
            let len: usize = t
                .body
                .iter()
                .map(|p| if let Part::Js(js) = p { js.len() } else { 1 })
                .sum();
            let share = n > 1 && (n - 1).saturating_mul(len) > 8 + (n + 1) * name.len();
            if share {
                names[i] = Some(name);
            }
            for part in t.body.iter() {
                if let Part::Call(call) = part {
                    uses[call.id] += if share { 1 } else { n };
                }
            }
        }
        let render = Render {
            templates: &self,
            names: &names,
            enclosing,
        };
        let mut declarations = String::new();
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
                params.extend(t.params.iter().map(ToString::to_string));
                write!(declarations, "const {name}=({})=>", params.join(",")).unwrap();
                if t.params.is_some() {
                    declarations.push('{');
                }
                render.expand(&t.body, Base::Relative(0), &values, &mut declarations);
                if t.params.is_some() {
                    declarations.push('}');
                }
                declarations.push(';');
            }
        }
        let base = if enclosing {
            Base::Enclosing(0)
        } else {
            Base::Absolute(0)
        };
        let mut expanded = String::new();
        render.expand(&view, base, &[], &mut expanded);
        (declarations, expanded)
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
                Part::Call(call) => {
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
                        if let Some(parent) = &call.parent {
                            inputs.push(parent.to_string());
                            write!(out, "({});", inputs.join(",")).unwrap();
                        } else if t.params.is_none() {
                            write!(out, "({})", inputs.join(",")).unwrap();
                        } else if !inputs.is_empty() {
                            write!(out, ".bind(null,{})", inputs.join(",")).unwrap();
                        }
                    } else {
                        let values: Vec<_> =
                            call.args.iter().map(|v| self.value(v, args)).collect();
                        let base = base.plus(call.base.unwrap_or(0));
                        let Some(params) = &t.params else {
                            self.expand(&t.body, base, &values, out);
                            continue;
                        };
                        match call.parent.as_deref() {
                            Some("p") => out.push('{'),
                            // The parent can have the same local name as a child.
                            Some(parent) => write!(out, "{{const p={parent};{{").unwrap(),
                            None => write!(out, "({params})=>{{").unwrap(),
                        }
                        self.expand(&t.body, base, &values, out);
                        out.push('}');
                        if call.parent.as_deref().is_some_and(|p| p != "p") {
                            out.push('}');
                        }
                    }
                }
            }
        }
    }
}
