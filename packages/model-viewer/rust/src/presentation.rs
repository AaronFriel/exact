use exact_gpu::wgpu;

/// Blend in linear light, then premultiply encoded sRGB for the host's compositor.
pub struct Presentation {
    pub color: wgpu::TextureView,
    group: wgpu::BindGroup,
    pipeline: wgpu::RenderPipeline,
}
impl Presentation {
    pub const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;

    pub fn new(device: &wgpu::Device, size: (u32, u32), format: wgpu::TextureFormat) -> Self {
        let color = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("model resolved color"),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: Self::FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&Default::default());
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("model presentation"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("model presentation"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&color),
            }],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("model presentation"),
            source: wgpu::ShaderSource::Wgsl(include_str!("presentation.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("model presentation"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("model presentation"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some(if format.is_srgb() { "srgb" } else { "encoded" }),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        Self {
            color,
            group,
            pipeline,
        }
    }

    pub fn draw(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("model presentation"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.draw(0..3, 0..1);
    }
}
