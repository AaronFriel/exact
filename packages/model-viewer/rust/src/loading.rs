use crate::{camera::Camera, pick::Clip, Model, ModelViewer, Parsed};
use exact_gpu::AssetError;
use exact_model_gltf::glb;
use std::sync::Arc;

pub(super) struct Load {
    pub name: String,
    pub sequence: u64,
    pub keep_camera: bool,
}

#[derive(Default)]
pub(super) enum Source {
    #[default]
    None,
    Pending(Load),
    Parsing {
        load: Load,
        job: u64,
    },
    Ready {
        name: String,
        sequence: u64,
        scene: Option<Box<Model>>,
    },
}
impl Source {
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::None => None,
            Self::Pending(load) | Self::Parsing { load, .. } => Some(&load.name),
            Self::Ready { name, .. } => Some(name),
        }
    }
    pub fn load(&self) -> Option<&Load> {
        match self {
            Self::Pending(load) | Self::Parsing { load, .. } => Some(load),
            _ => None,
        }
    }
}

pub(super) struct Job {
    pub sequence: u64,
    pub bytes: Option<Arc<[u8]>>,
}

impl ModelViewer {
    pub(super) fn source(src: &str) -> Result<String, String> {
        let name = if let Some(name) = src.strip_prefix("assets/") {
            name
        } else if ["app:/data/", "app:/cache/", "app:/tmp/"]
            .iter()
            .any(|root| src.starts_with(root))
        {
            src
        } else {
            return Err("use assets/ or app:/data, app:/cache, app:/tmp; download URLs to app:/cache (model-viewer recipe)".into());
        };
        if !exact_gpu::asset_name(name) {
            return Err("invalid asset name".into());
        }
        if !name.ends_with(".glb") {
            return Err("expected a binary glTF .glb file".into());
        }
        Ok(name.into())
    }

    pub(super) fn fail(&mut self, error: String) {
        self.source = match self.source.name() {
            Some(name) => Source::Ready {
                name: name.into(),
                sequence: self.generation,
                scene: None,
            },
            None => Source::None,
        };
        self.previous = None;
        self.loaded = false;
        self.error = format!("{}: {error}", self.arguments.src);
    }

    pub(super) fn request(&mut self) {
        if let Some(name) = self.source.name() {
            self.assets.retired.push(name.into());
        }
        if let Source::Ready { scene, .. } = std::mem::take(&mut self.source) {
            self.previous = scene;
        }
        self.generation += 1;
        self.loaded = false;
        self.error.clear();
        self.controls.clear();
        if self.arguments.src.is_empty() {
            self.previous = None;
            return;
        }
        let name = match Self::source(&self.arguments.src) {
            Ok(n) => n,
            Err(e) => {
                self.fail(e);
                return;
            }
        };
        // Subscription lifetime is independent of a parse that may still be running.
        self.assets.requests.push(name.clone());
        let load = Load {
            name,
            sequence: self.generation,
            keep_camera: false,
        };
        self.source = match self.jobs.get(&load.name) {
            Some(job) => Source::Parsing {
                job: job.sequence,
                load,
            },
            None => Source::Pending(load),
        };
    }

    pub(super) fn deliver(&mut self, name: &str, bytes: Result<&[u8], AssetError>) {
        if self.source.name() != Some(name) {
            return;
        }
        let keep_camera = self.source.load().is_none_or(|load| load.keep_camera);
        if let Source::Ready { scene, .. } = std::mem::take(&mut self.source) {
            self.previous = scene;
        }
        // A delivery supersedes even a parse started by the current bind.
        self.generation += 1;
        self.loaded = false;
        self.error.clear();
        self.source = Source::Pending(Load {
            name: name.into(),
            sequence: self.generation,
            keep_camera,
        });
        if let Some(job) = self.jobs.get_mut(name) {
            job.bytes = None;
        }
        let bytes = match bytes {
            Ok(bytes) if bytes.len() <= 64 * 1024 * 1024 => Arc::<[u8]>::from(bytes),
            Ok(_) => {
                self.fail("GLB exceeds 64 MiB".into());
                return;
            }
            Err(error) => {
                self.fail(match error {
                    AssetError::Missing => "file not found".into(),
                    AssetError::Failed(e) => e,
                });
                return;
            }
        };
        if let Some(job) = self.jobs.get_mut(name) {
            job.bytes = Some(bytes);
            let Source::Pending(load) = std::mem::take(&mut self.source) else {
                unreachable!()
            };
            self.source = Source::Parsing {
                load,
                job: job.sequence,
            };
        } else {
            self.parse(bytes);
        }
    }

    fn parse(&mut self, bytes: Arc<[u8]>) {
        let Source::Pending(load) = std::mem::take(&mut self.source) else {
            unreachable!()
        };
        let sequence = load.sequence;
        let name = load.name.clone();
        self.source = Source::Parsing {
            load,
            job: sequence,
        };
        self.jobs.insert(
            name.clone(),
            Job {
                sequence,
                bytes: Some(bytes.clone()),
            },
        );
        let limit = self.max_buffer_size;
        if self.seekable || cfg!(target_arch = "wasm32") {
            self.finish(Parsed {
                sequence,
                name,
                scene: glb::parse_with_limit(&bytes, limit),
            });
        } else {
            #[cfg(not(target_arch = "wasm32"))]
            {
                let sender = self.sender.clone();
                let parsed_name = name.clone();
                match std::thread::Builder::new()
                    .name("model-viewer parse".into())
                    .spawn(move || {
                        let scene = glb::parse_with_limit(&bytes, limit);
                        let _ = sender.send(Parsed {
                            sequence,
                            name: parsed_name,
                            scene,
                        });
                    }) {
                    Ok(handle) => self.parsers.push(handle),
                    Err(e) => {
                        self.jobs.remove(&name);
                        self.fail(format!("could not start parser: {e}"));
                    }
                }
            }
        }
    }

    pub(super) fn finish(&mut self, result: Parsed) {
        if self
            .jobs
            .get(&result.name)
            .is_none_or(|job| job.sequence != result.sequence)
        {
            return;
        }
        let job = self.jobs.remove(&result.name).unwrap();
        let current = matches!(&self.source, Source::Parsing { load, job }
            if load.name == result.name && *job == result.sequence);
        if !current {
            return;
        }
        let Source::Parsing { load, .. } = std::mem::take(&mut self.source) else {
            unreachable!()
        };
        if load.sequence != result.sequence {
            self.source = Source::Pending(load);
            if let Some(bytes) = job.bytes {
                self.parse(bytes);
            }
            return;
        }
        let name = load.name;
        let sequence = load.sequence;
        match result.scene {
            Ok(scene) => {
                let mut camera = Camera::new(&scene, &self.arguments);
                if load.keep_camera {
                    if let Some(old) = &self.previous {
                        camera.pose = old.camera.pose;
                        camera.goal = old.camera.goal;
                        camera.last_ms = old.camera.last_ms;
                        camera.framing = exact_model_gltf::framing::Framing::new(
                            &scene,
                            camera.pose.target,
                            camera.pose.fov,
                        );
                    }
                }
                let mut model = Box::new(Model {
                    scene,
                    camera,
                    effective: vec![],
                    clip: Clip::default(),
                    renderer: None,
                });
                model.style(&self.arguments);
                self.source = Source::Ready {
                    name,
                    sequence,
                    scene: Some(model),
                };
                self.previous = None;
            }
            Err(error) => {
                self.source = Source::Ready {
                    name,
                    sequence,
                    scene: None,
                };
                self.fail(error);
            }
        }
    }

    pub(super) fn poll(&mut self) {
        while let Ok(result) = self.receiver.try_recv() {
            self.finish(result);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut i = 0;
            while i < self.parsers.len() {
                if self.parsers[i].is_finished() {
                    let _ = self.parsers.swap_remove(i).join();
                } else {
                    i += 1;
                }
            }
        }
    }
}

impl Drop for ModelViewer {
    fn drop(&mut self) {
        #[cfg(all(test, not(target_arch = "wasm32")))]
        if let Some(joins) = &self.parser_joins {
            let _ = joins.send(None);
        }
        #[cfg(not(target_arch = "wasm32"))]
        for parser in self.parsers.drain(..) {
            // Native modules may be unloaded as soon as surface destruction returns.
            let _result = parser.join();
            #[cfg(test)]
            if let Some(joins) = &self.parser_joins {
                let _ = joins.send(Some(_result));
            }
        }
    }
}
