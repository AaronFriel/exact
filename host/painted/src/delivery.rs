//! Optional app-supplied delivery composition (LLP 1030 D4).
//! The host owns sessions and assets; the higher adapter owns store policy.
use crate::image::AssetResolver;
use exact_runner::Delivery;
use std::sync::Arc;

/// A pinned plan with its complete asset resolver.
pub struct Selection {
    /// The selected entry, absent for the embedded plan.
    pub entry: Option<String>,
    /// The sequence belonging to this exact entry.
    pub seq: u64,
    /// Validated plan bytes.
    pub plan: Arc<[u8]>,
    /// Complete selected assets; missing names never fall through to embedded files.
    pub assets: AssetResolver,
    /// Every name the signed asset index lists.
    pub names: Vec<String>,
}

/// Operations the presenter needs from a linked delivery adapter.
/// A binary-only app supplies none and creates no store or check thread.
pub trait Store {
    /// Pin a candidate and its asset resolver for this boot.
    fn prepare_selected(&mut self) -> Option<Selection>;
    /// Count a selected boot.
    fn boot_started(&mut self);
    /// Refuse the selected plan.
    fn entry_refused(&mut self, entry: &str, why: &str);
    /// Refuse assets belonging to the last prepared selection.
    fn selection_corrupt(&mut self, why: &str);
    /// Mark the selected boot successful.
    fn boot_succeeded(&mut self);
    /// Take a boot diagnostic.
    fn take_note(&mut self) -> Option<String>;
    /// The completion wake in the display's poll set.
    #[cfg(unix)]
    fn fd(&self) -> std::os::unix::io::RawFd;
    /// Start a check, returning whether one started.
    fn check(&self) -> bool;
    /// Take the latest asynchronous outcome.
    fn take_line(&mut self) -> Option<String>;
    /// Prepare a complete staged generation without changing live state.
    fn prepare_activation(&self) -> Result<Option<Selection>, String>;
    /// Commit the exact entry and sequence accepted by the host.
    fn commit_activation(&mut self, entry: Option<String>, seq: u64) -> Result<(), String>;
    /// Candidate stream facts, before the live store changes.
    fn staged_stream_into(&self, delivery: &mut Delivery);
    /// Copy the latest delivery facts into the runner.
    fn status_into(&self, delivery: &mut Delivery);
}

/// The files a Rust pair's receipt may name.
const RUST_FILES: [&str; 5] = [
    "app.module.wasm",
    "app.module.dylib",
    "app.module.so",
    "app.module.dll",
    "app.module.bin",
];

/// One inseparable module replacement, already authenticated by the asset
/// resolver: a Rust pair or a TypeScript pair.
#[derive(Clone, Debug)]
pub struct Module {
    /// UTF-8 pairing receipt.
    pub receipt: String,
    /// Opaque wasm, native library or Hermes bytecode bytes; never executed
    /// during preparation.
    pub bytes: Vec<u8>,
}

impl Module {
    /// The generation's module pair, both halves read before either is
    /// admitted into a data source (LLP 1030.006 D4, the Apple loader's
    /// checks): a `rust/` pair or a `typescript/` pair, never both, each
    /// exactly its receipt and one module. A TypeScript pair needs a binary
    /// that runs Hermes, a Rust pair one whose Rust policy replaces its
    /// module (`compat`'s `executors` and `rustMode`).
    pub fn resolve(
        assets: &AssetResolver,
        names: &[String],
        compat: &str,
    ) -> Result<Option<Self>, String> {
        let in_dir = |dir: &str| names.iter().filter(|n| n.starts_with(dir)).count();
        let (rust, typescript) = (in_dir("rust/"), in_dir("typescript/"));
        let dir = match (rust, typescript) {
            (0, 0) => return Ok(None),
            (_, 0) => "rust",
            (0, _) => "typescript",
            _ => return Err("a generation carries one module pair, not two".into()),
        };
        let compat: serde_json::Value =
            serde_json::from_str(compat).map_err(|e| format!("the binary's compat.json: {e}"))?;
        let inputs = &compat["inputs"];
        if dir == "typescript"
            && !inputs["executors"]
                .as_array()
                .is_some_and(|e| e.iter().any(|e| e == "hermes"))
        {
            return Err("this binary runs no TypeScript module".into());
        }
        if dir == "rust"
            && !matches!(
                inputs["rustMode"].as_str(),
                Some("wasm" | "native" | "tiered")
            )
        {
            return Err("Rust replacement is disabled in this binary".into());
        }
        let receipt =
            assets(&format!("{dir}/app.module.json"))?.ok_or("missing module pairing receipt")?;
        if receipt.len() > 1 << 20 {
            return Err("module receipt exceeds 1 MiB".into());
        }
        let receipt = String::from_utf8(receipt.to_vec()).map_err(|e| e.to_string())?;
        let file = if dir == "typescript" {
            "app.hbc".to_string()
        } else {
            let json: serde_json::Value =
                serde_json::from_str(&receipt).map_err(|e| e.to_string())?;
            json["module"]["file"].as_str().unwrap_or("").to_string()
        };
        if rust + typescript != 2 || (dir == "rust" && !RUST_FILES.contains(&file.as_str())) {
            return Err(format!("invalid signed {dir} module pair"));
        }
        let bytes = assets(&format!("{dir}/{file}"))?.ok_or("missing module bytes")?;
        if bytes.len() > 32 << 20 {
            return Err("module exceeds 32 MiB".into());
        }
        Ok(Some(Self {
            receipt,
            bytes: bytes.to_vec(),
        }))
    }

    /// Read the producer's selected local development executor directory.
    pub fn local(plan: &std::path::Path, compat: &str) -> Result<Option<Self>, String> {
        let root = plan.parent().unwrap_or_else(|| std::path::Path::new("."));
        let rust = root.join("rust");
        if !rust.exists() {
            return Ok(None);
        }
        let json: serde_json::Value = serde_json::from_str(compat).map_err(|e| e.to_string())?;
        let mode = json["inputs"]["rustMode"].as_str().unwrap_or("off");
        let prefix = match mode {
            "wasm" => "rust/wasm".to_string(),
            "native" | "tiered" => format!("rust/{mode}/{}", json["target"].as_str().unwrap_or("")),
            _ => return Err("Rust replacement is disabled in this binary".into()),
        };
        let root = root.to_path_buf();
        let read: AssetResolver = Arc::new(move |name| {
            let path = root.join(name);
            match std::fs::metadata(&path) {
                Ok(metadata) if metadata.len() > 32 << 20 => {
                    return Err("Rust replacement exceeds 32 MiB".into())
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.to_string()),
                _ => {}
            }
            match std::fs::read(path) {
                Ok(bytes) if bytes.len() <= 32 << 20 => Ok(Some(bytes.into())),
                Ok(_) => Err("Rust replacement exceeds 32 MiB".into()),
                Err(e) => Err(e.to_string()),
            }
        });
        Self::resolve_at(&read, &prefix)?.map_or_else(
            || Err("no Rust replacement matching this binary's executor and target".into()),
            |module| Ok(Some(module)),
        )
    }

    fn resolve_at(assets: &AssetResolver, prefix: &str) -> Result<Option<Self>, String> {
        let Some(receipt) = assets(&format!("{prefix}/app.module.json"))? else {
            for file in RUST_FILES {
                if assets(&format!("{prefix}/{file}"))?.is_some() {
                    return Err("Rust replacement is missing its pairing receipt".into());
                }
            }
            return Ok(None);
        };
        if receipt.len() > 1 << 20 {
            return Err("Rust receipt exceeds 1 MiB".into());
        }
        let receipt = String::from_utf8(receipt.to_vec()).map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(&receipt).map_err(|e| e.to_string())?;
        let file = json["module"]["file"].as_str().unwrap_or("");
        if !RUST_FILES.contains(&file) {
            return Err("invalid Rust module filename".into());
        }
        let bytes =
            assets(&format!("{prefix}/{file}"))?.ok_or("Rust replacement is missing its module")?;
        if bytes.len() > 32 << 20 {
            return Err("Rust replacement exceeds 32 MiB".into());
        }
        Ok(Some(Self {
            receipt,
            bytes: bytes.to_vec(),
        }))
    }

    /// Pair against the candidate plan and this binary's baked authority.
    pub fn replacement<D: exact_runner::DataSource>(
        &self,
        plan: &[u8],
        admitted: &D,
    ) -> Result<D, String> {
        admitted
            .replacement(plan, &self.receipt, self.bytes.clone())
            .map_err(|e| format!("module replacement: {e:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TYPESCRIPT: &str = r#"{"inputs":{"executors":["hermes","native"],"rustMode":"off"}}"#;
    const RUST: &str = r#"{"inputs":{"executors":["native","wasmi"],"rustMode":"wasm"}}"#;

    fn roster(files: &[(&str, &[u8])]) -> (AssetResolver, Vec<String>) {
        let files: std::collections::BTreeMap<String, Arc<[u8]>> = files
            .iter()
            .map(|(name, bytes)| (name.to_string(), Arc::from(*bytes)))
            .collect();
        let names = files.keys().cloned().collect();
        (Arc::new(move |name| Ok(files.get(name).cloned())), names)
    }

    fn resolve(files: &[(&str, &[u8])], compat: &str) -> Result<Option<Module>, String> {
        let (assets, names) = roster(files);
        Module::resolve(&assets, &names, compat)
    }

    #[test]
    fn either_pair_resolves_whole_and_none_is_no_module() {
        let typescript = resolve(
            &[
                ("typescript/app.module.json", b"{\"appId\":\"a\"}"),
                ("typescript/app.hbc", b"bytecode"),
                ("assets/mark.png", b"png"),
            ],
            TYPESCRIPT,
        )
        .unwrap()
        .unwrap();
        assert_eq!(typescript.receipt, "{\"appId\":\"a\"}");
        assert_eq!(typescript.bytes, b"bytecode");
        let rust = resolve(
            &[
                (
                    "rust/app.module.json",
                    br#"{"module":{"file":"app.module.wasm"}}"#,
                ),
                ("rust/app.module.wasm", b"wasm"),
            ],
            RUST,
        )
        .unwrap()
        .unwrap();
        assert_eq!(rust.bytes, b"wasm");
        assert!(resolve(&[("assets/mark.png", b"png")], "")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_pair_is_refused_beside_another_beyond_its_two_names_or_missing_a_half() {
        let both = resolve(
            &[
                ("typescript/app.module.json", b"{}"),
                ("typescript/app.hbc", b"bytecode"),
                (
                    "rust/app.module.json",
                    br#"{"module":{"file":"app.module.wasm"}}"#,
                ),
                ("rust/app.module.wasm", b"wasm"),
            ],
            r#"{"inputs":{"executors":["hermes","native"],"rustMode":"wasm"}}"#,
        );
        assert_eq!(
            both.unwrap_err(),
            "a generation carries one module pair, not two"
        );
        let third = resolve(
            &[
                ("typescript/app.module.json", b"{}"),
                ("typescript/app.hbc", b"bytecode"),
                ("typescript/app.js", b"source"),
            ],
            TYPESCRIPT,
        );
        assert_eq!(third.unwrap_err(), "invalid signed typescript module pair");
        let receipt_only = resolve(&[("typescript/app.module.json", b"{}")], TYPESCRIPT);
        assert_eq!(
            receipt_only.unwrap_err(),
            "invalid signed typescript module pair"
        );
        let module_only = resolve(&[("typescript/app.hbc", b"bytecode")], TYPESCRIPT);
        assert_eq!(module_only.unwrap_err(), "missing module pairing receipt");
        let renamed = resolve(
            &[
                ("rust/app.module.json", br#"{"module":{"file":"../x.so"}}"#),
                ("rust/app.module.wasm", b"wasm"),
            ],
            RUST,
        );
        assert_eq!(renamed.unwrap_err(), "invalid signed rust module pair");
    }

    #[test]
    fn sizes_are_bounded() {
        let big_receipt = vec![b' '; (1 << 20) + 1];
        let refused = resolve(
            &[
                ("typescript/app.module.json", &big_receipt),
                ("typescript/app.hbc", b"bytecode"),
            ],
            TYPESCRIPT,
        );
        assert_eq!(refused.unwrap_err(), "module receipt exceeds 1 MiB");
        let big_module = vec![0u8; (32 << 20) + 1];
        let refused = resolve(
            &[
                ("typescript/app.module.json", b"{}"),
                ("typescript/app.hbc", &big_module),
            ],
            TYPESCRIPT,
        );
        assert_eq!(refused.unwrap_err(), "module exceeds 32 MiB");
    }

    /// A Rust binary refuses a TypeScript pair, and a binary that replaces no
    /// Rust refuses a Rust pair, before reading either.
    #[test]
    fn a_pair_needs_its_executor_in_the_binary() {
        let typescript = [
            ("typescript/app.module.json", b"{}".as_slice()),
            ("typescript/app.hbc", b"bytecode".as_slice()),
        ];
        assert_eq!(
            resolve(&typescript, RUST).unwrap_err(),
            "this binary runs no TypeScript module"
        );
        let rust = [
            (
                "rust/app.module.json",
                br#"{"module":{"file":"app.module.wasm"}}"#.as_slice(),
            ),
            ("rust/app.module.wasm", b"wasm".as_slice()),
        ];
        assert_eq!(
            resolve(&rust, TYPESCRIPT).unwrap_err(),
            "Rust replacement is disabled in this binary"
        );
    }
}
