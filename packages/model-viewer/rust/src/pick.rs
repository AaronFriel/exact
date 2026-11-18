use crate::styles::{Effective, Occlusion};
use exact_model_gltf::{math::*, scene::Scene};

#[derive(Clone, Copy, Default)]
pub struct Clip {
    pub position: V3,
    pub normal: V3,
}
impl Clip {
    pub fn keeps(self, point: V3) -> bool {
        dot(sub(point, self.position), self.normal) >= 0.
    }
}

pub fn triangle(origin: V3, direction: V3, a: V3, b: V3, c: V3) -> Option<f32> {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let h = cross(direction, ac);
    let det = dot(ab, h);
    if det.abs() < 1e-12 {
        return None;
    }
    let q = sub(origin, a);
    let u = dot(q, h) / det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let r = cross(q, ab);
    let v = dot(direction, r) / det;
    if v < 0. || u + v > 1. {
        return None;
    }
    let t = dot(ac, r) / det;
    (t > 0.).then_some(t)
}

fn hits(
    scene: &Scene,
    effective: &[Effective],
    clip: Clip,
    origin: V3,
    direction: V3,
    depth: [f32; 2],
    occluders: bool,
    mut visit: impl FnMut(f32, usize, bool),
) {
    for (i, p) in scene.primitives.iter().enumerate() {
        let style = effective[i];
        if !style.visible || (style.occlusion == Occlusion::Occluder) != occluders {
            continue;
        }
        for tri in scene.indices[p.indices.start as usize..p.indices.end as usize].chunks_exact(3) {
            let [a, b, c] = std::array::from_fn(|k| scene.vertices[tri[k] as usize].p);
            if let Some(t) = triangle(origin, direction, a, b, c) {
                if (depth[0]..=depth[1]).contains(&t) && clip.keeps(add(origin, mul(direction, t)))
                {
                    let front = dot(cross(sub(b, a), sub(c, a)), direction) < 0.;
                    visit(t, i, front);
                }
            }
        }
    }
}

pub fn pick(
    scene: &Scene,
    effective: &[Effective],
    clip: Clip,
    origin: V3,
    direction: V3,
    depth: [f32; 2],
) -> String {
    let nearer = |hit: &mut Option<(f32, usize)>, t, i| {
        if hit.is_none_or(|(nearest, _)| t < nearest) {
            *hit = Some((t, i));
        }
    };
    let mut occluder = None;
    hits(
        scene,
        effective,
        clip,
        origin,
        direction,
        depth,
        true,
        |t, i, _| {
            nearer(&mut occluder, t, i);
        },
    );
    let occluder_depth = occluder.map_or(f32::INFINITY, |(t, _)| t);
    let (mut opaque, mut revealed, mut translucent) = (None, None, None);
    hits(
        scene,
        effective,
        clip,
        origin,
        direction,
        depth,
        false,
        |t, i, front| {
            let style = effective[i];
            if style.opaque() && t < occluder_depth {
                nearer(&mut opaque, t, i);
            }
            // A primitive can cross the occluder: its nearer hit must not hide its faded hit.
            if style.occlusion == Occlusion::Revealed
                && t > occluder_depth
                && style.occluded_opacity > 0.
            {
                nearer(&mut revealed, t, i);
            }
            if !style.opaque() && front {
                nearer(&mut translucent, t, i);
            }
        },
    );
    opaque
        .or(revealed)
        .or(occluder)
        .or(translucent)
        .map(|(_, i)| scene.nodes[scene.primitives[i].node].name.clone())
        .unwrap_or_default()
}
