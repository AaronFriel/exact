use exact_game_render::hooks::Pipelines;
use exact_game_render::{FrameView, FrameWork, HookGpu, Hooks, Needs, RenderError, RenderWorld};
use exact_gpu::wgpu::{self, util::DeviceExt};
use terrain_fixture_logic::{height, sections, SECTION_COUNT, SIDE};

mod mesh;

pub mod shaders {
    include!(concat!(env!("OUT_DIR"), "/shaders.rs"));
}

const SECTIONS_PER_PREPARE: usize = 64;

pub struct Passes {
    remaining: std::vec::IntoIter<[i32; 3]>,
    pending_reason: String,
    meshes: Vec<Section>,
    pipeline: Pipelines<wgpu::RenderPipeline>,
    frame: Option<wgpu::BindGroup>,
    work: FrameWork,
}

struct Section {
    origin: [i32; 3],
    buffer: wgpu::Buffer,
    index_offset: u64,
    indices: u32,
}

impl Default for Passes {
    fn default() -> Self {
        Self {
            remaining: sections().collect::<Vec<_>>().into_iter(),
            pending_reason: format!("{SECTION_COUNT} sections pending"),
            meshes: Vec::new(),
            pipeline: Pipelines::default(),
            frame: None,
            work: FrameWork::default(),
        }
    }
}

impl Hooks for Passes {
    fn prepare(
        &mut self,
        gpu: &HookGpu<'_>,
        view: &FrameView<'_>,
        _: &RenderWorld<'_>,
    ) -> Result<(), RenderError> {
        self.pipeline
            .update(gpu.device, view.time.shader_generation, || {
                pipeline(gpu, view)
            });
        self.frame = Some(gpu.frame_binding.clone());

        for origin in self.remaining.by_ref().take(SECTIONS_PER_PREPARE) {
            let mesh = mesh::section(origin, height);
            if mesh.indices.is_empty() {
                continue;
            }

            let mut bytes = mesh.vertices;
            let index_offset = bytes.len() as u64;
            let indices = mesh.indices.len() as u32;
            bytes.extend(mesh.indices.into_iter().flat_map(u32::to_le_bytes));
            let buffer = gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("terrain section"),
                    contents: &bytes,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::INDEX,
                });
            self.work.upload_bytes += bytes.len() as u64;
            self.meshes.push(Section {
                origin,
                buffer,
                index_offset,
                indices,
            });
        }
        let remaining = self.remaining.len();
        if remaining > 0 {
            self.pending_reason = format!("{remaining} sections pending");
        } else if self.pipeline.pending() {
            self.pending_reason = "0 sections pending, terrain pipeline validating".into();
        }
        Ok(())
    }

    fn needs(&self) -> Needs {
        if self.remaining.len() > 0 || self.pipeline.pending() {
            Needs::PENDING
        } else {
            Needs::NONE
        }
    }

    fn pending_reason(&self) -> &str {
        &self.pending_reason
    }

    fn error(&self) -> Option<&str> {
        self.pipeline.error()
    }

    fn frame_work(&self) -> Option<FrameWork> {
        Some(self.work)
    }

    fn item_name(&self) -> &'static str {
        "sections"
    }

    fn opaque(
        &mut self,
        pass: &mut wgpu::RenderPass<'_>,
        view: &FrameView<'_>,
    ) -> Result<(), RenderError> {
        let (Some(pipeline), Some(frame)) = (self.pipeline.get(), &self.frame) else {
            return Ok(());
        };
        let rows = (view.frame.proj * view.frame.view).transpose();
        let (x, y, z, w) = (rows.x_axis, rows.y_axis, rows.z_axis, rows.w_axis);
        // WebGPU clips depth to 0 <= z <= w.
        let planes = [w + x, w - x, w + y, w - y, z, w - z].map(|p| p.to_array());

        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, frame, &[]);
        for section in &self.meshes {
            if !in_frustum(section.origin, &planes) {
                continue;
            }
            pass.set_vertex_buffer(0, section.buffer.slice(..section.index_offset));
            pass.set_index_buffer(
                section.buffer.slice(section.index_offset..),
                wgpu::IndexFormat::Uint32,
            );
            pass.draw_indexed(0..section.indices, 0, 0..1);
            self.work.draws += 1;
            self.work.triangles += u64::from(section.indices / 3);
            self.work.items += 1;
        }
        Ok(())
    }
}

fn in_frustum(origin: [i32; 3], planes: &[[f32; 4]; 6]) -> bool {
    planes.iter().all(|&[x, y, z, w]| {
        // The box corner furthest inside this plane suffices to reject the box.
        let distance = |start, normal: f32| {
            let far_corner = if normal >= 0. { start + SIDE } else { start };
            far_corner as f32 * normal
        };
        distance(origin[0], x) + distance(origin[1], y) + distance(origin[2], z) + w >= 0.
    })
}

fn pipeline(gpu: &HookGpu<'_>, view: &FrameView<'_>) -> wgpu::RenderPipeline {
    use shaders::terrain;
    let device = gpu.device;
    let module = device.create_shader_module(terrain::module());
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("terrain"),
        bind_group_layouts: &[Some(gpu.frame_layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("terrain"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some(terrain::entry::TERRAIN_VS),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x3],
            })],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some(terrain::entry::TERRAIN_FS),
            targets: &[Some(view.color_format.into())],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState {
            cull_mode: Some(wgpu::Face::Back),
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: view.depth_format,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: view.sample_count,
            ..Default::default()
        },
        multiview_mask: None,
        cache: None,
    })
}
