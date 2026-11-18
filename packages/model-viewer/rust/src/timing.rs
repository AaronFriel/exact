//! D11's wall-clock costs, collected only for an active performance resource.
//!
//! `exactCanvasPerformance("modelViewer")` with the optional `triangles` field
//! enables collection. Detailed phases are in `take_performance`'s JSON and the
//! surface agent's `{"op":"state","performance":true}` reply while enabled;
//! Contract's metrics schema admits only its standard fields. Values describe
//! the latest operation. Occlusion totals count updates since asset delivery.
//! Disabling collection drops every sample, including worker results still in flight.
//! `parseWaitMs` includes delivery copying, worker dispatch and the wait until a
//! frame consumes the result. `uploadMs` includes CPU packing, buffers, pipelines
//! and attachments. `loadToSubmitMs` ends at submission, before presentation.
//!
//! D11 and section 3's cost measurements, 2026-11-18
//!
//! Apple M5 Ultra, 36 logical CPUs, Xcode 27.2. Native: host-dev (release
//! optimizations), iPhone 17 Pro simulator, iOS 27.0, Metal, real clock. Web:
//! pinned full Chromium, WebGPU, web profile. Canvas: 320 x 320 points, 4x MSAA.
//! The generated GLB has two concentric UV spheres, radii 1 and 0.7, each with
//! 500 x 250 quads: 500,000 triangles, 251,502 vertices. Housing is an occluder;
//! Impeller is revealed. Twenty hotspot anchors form a 5 x 4 grid on Impeller,
//! 0.18 m apart, centred on x=y=0 at z=0.5 m. A centre pick returns Impeller.
//! glTF-Transform CLI 4.2.1 (SDK 4.5.1), meshoptimizer 0.25.0: optimize with
//! meshopt/medium and quantization; flatten, instance, join, palette, prune,
//! simplify, weld and texture-compress disabled. The model is generated in the
//! worktree's target directory, not committed: 1,228,000 bytes, SHA-256
//! 8796ffb6716bcbf599400cf690190f25fddf91f4e41eedbd2053dd3f0f68d2c1.
//!
//! Each batch starts a fresh process, then replaces the source seven times with
//! identical bytes under alternating asset names. The drive checks 500,000
//! triangles and the Impeller pick. Load is the machine's 1/5/15-minute average
//! sampled before each trial. All durations below are milliseconds.
//!
//! Native presentation is bracketed: submission is a lower bound; the elapsed
//! time read immediately after the host reports presented=true is an upper
//! bound, including observer polling and dispatch. An upper bound above 200
//! does not establish a miss. The initial shader-cache trial did miss: submit
//! 1433.48, observed presented by 1523.51, parse 21.28, preparation 3.09, GPU
//! setup 307.20, one occlusion update 40.31, at load 30.37/42.66/50.40. GPU setup
//! alone exceeded 200; the remaining cold scheduling delay was not attributed.
//! Later fresh processes reuse Metal's shader cache:
//!
//! | Trial | Load 1/5/15 | Parse | Wait | GPU setup | Present bounds | Pick | 20 hotspots |
//! |---|---|---:|---:|---:|---|---:|---:|
//! | A first | 81.33/62.10/55.67 | 25.34 | 16.05 | 31.03 | 120.07–188.76 | — | 40.03 |
//! | A1 | 81.33/62.10/55.67 | 25.23 | 2.82 | 27.24 | 100.93–157.36 | 7.50 | 40.00 |
//! | A2 | 81.33/62.10/55.67 | 23.06 | 44.35 | 27.42 | 140.50–196.84 | 7.56 | 39.93 |
//! | A3 | 81.33/62.10/55.67 | 20.82 | 0.86 | 28.06 | 95.68–151.77 | 7.62 | 40.07 |
//! | A4 | 81.33/62.10/55.67 | 26.22 | 44.32 | 28.32 | 145.74–202.71 | 7.45 | 40.33 |
//! | A5 | 81.33/62.10/55.67 | 26.97 | 34.63 | 28.29 | 135.77–192.00 | 7.57 | 40.03 |
//! | A6 | 81.33/62.10/55.67 | 23.31 | 3.72 | 27.91 | 100.60–155.56 | 7.46 | 39.92 |
//! | A7 | 81.33/62.10/55.67 | 24.38 | 46.64 | 27.32 | 143.66–203.78 | 7.37 | 39.88 |
//! | B first | 61.09/60.57/55.65 | 26.90 | 16.13 | 31.85 | 123.54–191.15 | — | 40.41 |
//! | B1 | 61.09/60.57/55.65 | 22.56 | 49.04 | 26.98 | 144.78–200.77 | 7.49 | 40.29 |
//! | B2 | 61.09/60.57/55.65 | 21.03 | 45.86 | 27.33 | 140.95–198.21 | 7.52 | 40.28 |
//! | B3 | 61.09/60.57/55.65 | 20.72 | 48.85 | 29.56 | 145.67–202.14 | 7.55 | 40.46 |
//! | B4 | 61.09/60.57/55.65 | 27.16 | 42.09 | 34.22 | 151.33–209.28 | 7.49 | 40.78 |
//! | B5 | 61.09/60.57/55.65 | 28.23 | 27.15 | 30.18 | 132.83–191.41 | 7.44 | 40.16 |
//! | B6 | 61.09/60.57/55.65 | 25.61 | 40.03 | 30.17 | 143.06–201.84 | 7.51 | 40.54 |
//! | B7 | 61.09/60.57/55.65 | 20.96 | 1.49 | 28.74 | 97.33–153.34 | 7.42 | 40.26 |
//! | C first | 69.83/74.51/69.11 | 22.35 | 2.13 | 31.39 | 105.70–323.57 | — | 40.49 |
//! | C1 | 69.83/74.51/69.11 | 30.18 | 26.11 | 28.42 | 132.94–189.38 | 7.66 | 40.78 |
//! | C2 | 69.83/74.51/69.11 | 21.67 | 42.16 | 28.99 | 139.22–195.10 | 7.61 | 40.41 |
//! | C3 | 69.83/74.51/69.11 | 23.04 | 28.24 | 28.52 | 126.56–182.37 | 7.79 | 40.52 |
//! | C4 | 69.83/74.51/69.11 | 21.79 | 30.45 | 28.37 | 127.70–183.81 | 7.55 | 40.58 |
//! | C5 | 69.83/74.51/69.11 | 22.66 | 29.01 | 27.87 | 125.82–182.04 | 7.64 | 40.52 |
//! | C6 | 69.83/74.51/69.11 | 23.34 | 29.49 | 29.16 | 127.98–183.58 | 8.64 | 40.26 |
//! | C7 | 69.83/74.51/69.11 | 23.76 | 27.93 | 28.05 | 126.29–181.27 | 7.64 | 40.60 |
//!
//! The 2 ms pick and 4 ms occlusion budgets both miss consistently across these
//! loads. Both scan CPU triangles without an acceleration structure. Some
//! replacements update occlusion on the retained picture while parsing and
//! again on the new picture: two updates total about 80 ms, contributing to
//! result-consumption waits. These measurements do not qualify the 200 ms cold
//! first-frame budget. No budget has been raised.
//!
//! Web parsing blocks the page once; camera preparation blocks it afterwards.
//! The first trial includes cold Wasm/JIT paths; the seven replacements warm
//! those paths. GPU setup and hotspot work also block, outside these parse rows.
//!
//! | Trial | Load 1/5/15 | GLB parse | Camera preparation |
//! |---|---|---:|---:|
//! | first | 60.18/77.66/69.40 | 82.00 | 28.00 |
//! | 1 | 60.18/77.66/69.40 | 44.90 | 9.80 |
//! | 2 | 60.18/77.66/69.40 | 45.20 | 10.00 |
//! | 3 | 60.18/77.66/69.40 | 43.70 | 9.70 |
//! | 4 | 60.18/77.66/69.40 | 44.00 | 9.90 |
//! | 5 | 60.18/77.66/69.40 | 43.90 | 9.70 |
//! | 6 | 60.18/77.66/69.40 | 43.50 | 9.90 |
//! | 7 | 60.18/77.66/69.40 | 43.80 | 10.30 |
//!
//! Package module bytes (shared host code and model assets excluded):
//!
//! | Artifact | Raw | Gzip-9 | Brotli-11 |
//! |---|---:|---:|---:|
//! | Web Wasm | 468173 | 211325 | 177306 |
//! | Generated web bindings | 90977 | 16532 | 13804 |
//! | macOS dylib, host-dev | 5661672 | — | — |
//! | iOS simulator packaged dylib, host-dev | 5536832 | — | — |
//!
//! Native counts are development artifacts, not production-size claims. Current
//! iOS packaging places the GPU dylib in the app's Frameworks directory. Web
//! counts are the web build's on-demand package artifacts; metrics.mjs
//! --web-bytes enumerates its fixed app list, not package GPU modules. Nothing
//! here enters the eager page closure or an app without this package.
//!
//! Unqualified: macOS live presentation (no model frame arrived on the desktop),
//! physical devices and the reporter's model. Unit GPU readback and both Apple
//! builds passed. Presentation latency needs the same drive on an unlocked Mac.
#[derive(Default)]
pub struct Timing {
    pub arrival: Option<Stamp>,
    pub parse_ms: Option<f64>,
    pub parse_wait_ms: Option<f64>,
    pub prepare_ms: Option<f64>,
    pub upload_ms: Option<f64>,
    pub pick_ms: Option<f64>,
    pub load_to_submit_ms: Option<f64>,
}
impl Timing {
    pub fn snapshot(&self, hotspots: &crate::hotspots::Hotspots) -> serde_json::Value {
        let mut fields = serde_json::Map::new();
        for (name, ms) in [
            ("parseMs", self.parse_ms),
            ("parseWaitMs", self.parse_wait_ms),
            ("prepareMs", self.prepare_ms),
            ("uploadMs", self.upload_ms),
            ("pickMs", self.pick_ms),
            ("occlusionMs", hotspots.occlusion_ms),
            // Submission is observable by a surface; presentation belongs to the host.
            ("loadToSubmitMs", self.load_to_submit_ms),
        ] {
            if let Some(ms) = ms {
                fields.insert(name.into(), ms.into());
            }
        }
        if hotspots.occlusion_ms.is_some() {
            fields.insert(
                "occlusionTotalMs".into(),
                hotspots.occlusion_total_ms.into(),
            );
            fields.insert("occlusionUpdates".into(), hotspots.occlusion_updates.into());
        }
        serde_json::Value::Object(fields)
    }
}

pub struct Stamp {
    #[cfg(not(target_arch = "wasm32"))]
    start: std::time::Instant,
    #[cfg(target_arch = "wasm32")]
    start: f64,
}
impl Stamp {
    pub fn now() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            start: std::time::Instant::now(),
            #[cfg(target_arch = "wasm32")]
            start: now_ms(),
        }
    }
    pub fn elapsed(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed().as_secs_f64() * 1000.
        }
        #[cfg(target_arch = "wasm32")]
        {
            now_ms() - self.start
        }
    }
}
#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    web_sys::window()
        .and_then(|w| w.performance())
        .expect("modelViewer requires window.performance")
        .now()
}
