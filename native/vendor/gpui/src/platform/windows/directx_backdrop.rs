//! CSS `backdrop-filter: blur() saturate()` for the DirectX 11 renderer.
//!
//! For every `BackdropBlur` primitive the already-rendered back buffer region behind the
//! element is copied out, optionally downsampled (so large sigmas stay cheap), blurred with a
//! separable Gaussian (sigma = CSS blur radius), and composited back into the swap chain
//! clipped to the element's rounded / chamfered rect with a saturation matrix applied.
//! The element's translucent fill is painted afterwards by the regular quad pipeline.

use anyhow::{Context, Result};
use windows::{
    Win32::Graphics::{
        Direct3D::{
            D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP,
            Fxc::{D3DCOMPILE_OPTIMIZATION_LEVEL3, D3DCompile},
            ID3DBlob,
        },
        Direct3D11::*,
        Dxgi::Common::*,
    },
    core::{Interface, PCSTR, s},
};

use crate::{BackdropBlur, ScaledPixels};

const MAX_LEVEL: usize = 4;
/// Sigma (in pixels of the working level) above which we downsample by another 2x.
const MAX_LEVEL_SIGMA: f32 = 8.0;

const HLSL: &str = r#"
cbuffer P : register(b0) {
    float4 c_rect;    // quad to draw: x, y, w, h in current render target pixels
    float4 c_vp;      // xy: render target size, zw: allocated size of the source texture
    float4 c_src;     // xy: valid size of the source texture, zw: blur direction
    float4 c_blur;    // x: sigma (level px), y: opacity, z: saturate, w: chamfer
    float4 c_bounds;  // element bounds x, y, w, h (main target px)
    float4 c_radii;   // corner radii tl, tr, br, bl
    float4 c_mask;    // content mask x, y, w, h
    float4 c_region;  // xy: region origin in main target px, z: 1 / 2^level
};

Texture2D<float4> t0 : register(t0);
Texture2D<float4> t1 : register(t1);
SamplerState lin : register(s0);

float4 vs_main(uint id : SV_VertexID) : SV_Position {
    float2 u = float2(id & 1, (id >> 1) & 1);
    float2 p = c_rect.xy + u * c_rect.zw;
    return float4(p / c_vp.xy * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

float4 ps_down(float4 pos : SV_Position) : SV_Target {
    float2 src = pos.xy * 2.0;
    src = clamp(src, float2(0.5, 0.5), c_src.xy - 0.5);
    return t0.SampleLevel(lin, src / c_vp.zw, 0);
}

float4 ps_blur(float4 pos : SV_Position) : SV_Target {
    int2 ip = int2(pos.xy);
    int2 dir = int2(c_src.zw);
    int2 hi = int2(c_src.xy) - 1;
    float sigma = max(c_blur.x, 0.3);
    int r = (int)ceil(3.0 * sigma);
    float4 sum = 0;
    float wsum = 0;
    for (int i = -r; i <= r; i++) {
        float w = exp(-0.5 * (float)(i * i) / (sigma * sigma));
        int2 q = clamp(ip + dir * i, int2(0, 0), hi);
        sum += t0.Load(int3(q, 0)) * w;
        wsum += w;
    }
    return sum / wsum;
}

float pick_radius(float2 c2p) {
    if (c2p.x < 0.0) { return c2p.y < 0.0 ? c_radii.x : c_radii.w; }
    return c2p.y < 0.0 ? c_radii.y : c_radii.z;
}

float4 ps_comp(float4 pos : SV_Position) : SV_Target {
    float2 p = pos.xy;
    int2 ip = int2(p);
    int2 oc = ip - int2(c_region.xy);
    float4 orig = t1.Load(int3(oc, 0));

    float2 half_size = c_bounds.zw * 0.5;
    float2 c2p = p - (c_bounds.xy + half_size);
    float r = pick_radius(c2p);
    float2 q = abs(c2p) - half_size + r;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    if (c_blur.w > 0.0) {
        d = max(d, (abs(c2p.x) + abs(c2p.y) - (half_size.x + half_size.y - c_blur.w)) * 0.70710678);
    }
    float a = saturate(0.5 - d) * c_blur.y;
    if (p.x < c_mask.x || p.y < c_mask.y || p.x > c_mask.x + c_mask.z || p.y > c_mask.y + c_mask.w) {
        a = 0.0;
    }

    float2 lp = (p - c_region.xy) * c_region.z;
    lp = clamp(lp, float2(0.5, 0.5), c_src.xy - 0.5);
    float4 bl = t0.SampleLevel(lin, lp / c_vp.zw, 0);

    float s = c_blur.z;
    float3 rgb = bl.rgb;
    float3 sat = float3(
        dot(rgb, float3(0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s)),
        dot(rgb, float3(0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s)),
        dot(rgb, float3(0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s)));
    bl.rgb = clamp(sat, 0.0, bl.a);
    return lerp(orig, bl, a);
}
"#;

struct Target {
    texture: ID3D11Texture2D,
    srv: ID3D11ShaderResourceView,
    rtv: ID3D11RenderTargetView,
    width: u32,
    height: u32,
}

impl Target {
    fn new(device: &ID3D11Device, width: u32, height: u32, format: DXGI_FORMAT) -> Result<Self> {
        let width = width.max(1);
        let height = height.max(1);
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture))? };
        let texture = texture.context("backdrop texture")?;
        let mut srv = None;
        unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut srv))? };
        let mut rtv = None;
        unsafe { device.CreateRenderTargetView(&texture, None, Some(&mut rtv))? };
        Ok(Self {
            texture,
            srv: srv.context("backdrop srv")?,
            rtv: rtv.context("backdrop rtv")?,
            width,
            height,
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Params {
    rect: [f32; 4],
    vp: [f32; 4],
    src: [f32; 4],
    blur: [f32; 4],
    bounds: [f32; 4],
    radii: [f32; 4],
    mask: [f32; 4],
    region: [f32; 4],
}

pub(crate) struct BackdropRenderer {
    vs: ID3D11VertexShader,
    ps_down: ID3D11PixelShader,
    ps_blur: ID3D11PixelShader,
    ps_comp: ID3D11PixelShader,
    cbuffer: ID3D11Buffer,
    sampler: ID3D11SamplerState,
    blend_off: ID3D11BlendState,
    size: (u32, u32),
    orig: Option<Target>,
    a: Vec<Target>,
    b: Vec<Target>,
}

fn compile(entry: PCSTR, target: PCSTR) -> Result<Vec<u8>> {
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let result = unsafe {
        D3DCompile(
            HLSL.as_ptr() as *const _,
            HLSL.len(),
            s!("backdrop.hlsl"),
            None,
            None,
            entry,
            target,
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if let Err(e) = result {
        let msg = errors
            .map(|blob| unsafe {
                String::from_utf8_lossy(std::slice::from_raw_parts(
                    blob.GetBufferPointer() as *const u8,
                    blob.GetBufferSize(),
                ))
                .into_owned()
            })
            .unwrap_or_default();
        anyhow::bail!("backdrop shader compile failed: {e:?} {msg}");
    }
    let code = code.context("backdrop shader blob")?;
    Ok(unsafe {
        std::slice::from_raw_parts(code.GetBufferPointer() as *const u8, code.GetBufferSize())
            .to_vec()
    })
}

impl BackdropRenderer {
    pub(crate) fn new(device: &ID3D11Device) -> Result<Self> {
        let vs_bytes = compile(s!("vs_main"), s!("vs_5_0"))?;
        let mut vs = None;
        unsafe { device.CreateVertexShader(&vs_bytes, None, Some(&mut vs))? };
        let mut make_ps = |entry: PCSTR| -> Result<ID3D11PixelShader> {
            let bytes = compile(entry, s!("ps_5_0"))?;
            let mut ps = None;
            unsafe { device.CreatePixelShader(&bytes, None, Some(&mut ps))? };
            ps.context("backdrop pixel shader")
        };
        let ps_down = make_ps(s!("ps_down"))?;
        let ps_blur = make_ps(s!("ps_blur"))?;
        let ps_comp = make_ps(s!("ps_comp"))?;

        let mut cbuffer = None;
        unsafe {
            device.CreateBuffer(
                &D3D11_BUFFER_DESC {
                    ByteWidth: std::mem::size_of::<Params>() as u32,
                    Usage: D3D11_USAGE_DYNAMIC,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut cbuffer),
            )?
        };

        let mut sampler = None;
        unsafe {
            device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    MaxAnisotropy: 1,
                    ComparisonFunc: D3D11_COMPARISON_ALWAYS,
                    MaxLOD: D3D11_FLOAT32_MAX,
                    ..Default::default()
                },
                Some(&mut sampler),
            )?
        };

        let mut blend_desc = D3D11_BLEND_DESC::default();
        blend_desc.RenderTarget[0].BlendEnable = false.into();
        blend_desc.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8;
        let mut blend_off = None;
        unsafe { device.CreateBlendState(&blend_desc, Some(&mut blend_off))? };

        Ok(Self {
            vs: vs.context("backdrop vs")?,
            ps_down,
            ps_blur,
            ps_comp,
            cbuffer: cbuffer.context("backdrop cbuffer")?,
            sampler: sampler.context("backdrop sampler")?,
            blend_off: blend_off.context("backdrop blend")?,
            size: (0, 0),
            orig: None,
            a: Vec::new(),
            b: Vec::new(),
        })
    }

    fn ensure_targets(&mut self, device: &ID3D11Device, width: u32, height: u32) -> Result<()> {
        if self.size == (width, height) && self.orig.is_some() {
            return Ok(());
        }
        self.orig = Some(Target::new(
            device,
            width,
            height,
            DXGI_FORMAT_B8G8R8A8_UNORM,
        )?);
        self.a.clear();
        self.b.clear();
        for level in 0..=MAX_LEVEL {
            let w = width.div_ceil(1 << level);
            let h = height.div_ceil(1 << level);
            self.a.push(Target::new(
                device,
                w,
                h,
                DXGI_FORMAT_R16G16B16A16_FLOAT,
            )?);
            self.b.push(Target::new(
                device,
                w,
                h,
                DXGI_FORMAT_R16G16B16A16_FLOAT,
            )?);
        }
        self.size = (width, height);
        Ok(())
    }

    fn set_params(&self, ctx: &ID3D11DeviceContext, params: &Params) -> Result<()> {
        unsafe {
            let mut mapped = std::mem::zeroed();
            ctx.Map(
                &self.cbuffer,
                0,
                D3D11_MAP_WRITE_DISCARD,
                0,
                Some(&mut mapped),
            )?;
            std::ptr::copy_nonoverlapping(params, mapped.pData as *mut Params, 1);
            ctx.Unmap(&self.cbuffer, 0);
        }
        Ok(())
    }

    /// Draw a full-target-sized-quad pass: `src` -> `dst` using `ps`.
    #[allow(clippy::too_many_arguments)]
    fn pass(
        &self,
        ctx: &ID3D11DeviceContext,
        ps: &ID3D11PixelShader,
        srcs: &[Option<ID3D11ShaderResourceView>],
        dst: &ID3D11RenderTargetView,
        dst_size: (f32, f32),
        rect: [f32; 4],
        mut params: Params,
    ) -> Result<()> {
        params.rect = rect;
        params.vp[0] = dst_size.0;
        params.vp[1] = dst_size.1;
        self.set_params(ctx, &params)?;
        unsafe {
            ctx.OMSetRenderTargets(Some(&[Some(dst.clone())]), None);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: dst_size.0,
                Height: dst_size.1,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
            ctx.VSSetShader(&self.vs, None);
            ctx.PSSetShader(ps, None);
            ctx.VSSetConstantBuffers(0, Some(&[Some(self.cbuffer.clone())]));
            ctx.PSSetConstantBuffers(0, Some(&[Some(self.cbuffer.clone())]));
            ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            ctx.PSSetShaderResources(0, Some(srcs));
            ctx.OMSetBlendState(&self.blend_off, None, 0xFFFFFFFF);
            ctx.Draw(4, 0);
            ctx.PSSetShaderResources(0, Some(&[None, None]));
        }
        Ok(())
    }

    pub(crate) fn draw(
        &mut self,
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        render_target: &ID3D11Texture2D,
        render_target_view: &[Option<ID3D11RenderTargetView>; 1],
        viewport: &[D3D11_VIEWPORT; 1],
        blurs: &[BackdropBlur],
    ) -> Result<()> {
        let target_w = viewport[0].Width as u32;
        let target_h = viewport[0].Height as u32;
        self.ensure_targets(device, target_w, target_h)?;

        for blur in blurs {
            let bounds = blur.bounds;
            let bx = f(bounds.origin.x);
            let by = f(bounds.origin.y);
            let bw = f(bounds.size.width);
            let bh = f(bounds.size.height);
            let sigma = blur.sigma.max(0.0);

            let pad = (3.0 * sigma).ceil() + 2.0;
            let x0 = ((bx - pad).floor().max(0.0)) as u32;
            let y0 = ((by - pad).floor().max(0.0)) as u32;
            let x1 = (((bx + bw + pad).ceil()).min(target_w as f32)) as u32;
            let y1 = (((by + bh + pad).ceil()).min(target_h as f32)) as u32;
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            let (w, h) = (x1 - x0, y1 - y0);

            let mut level = 0usize;
            while level < MAX_LEVEL && sigma / (1 << level) as f32 > MAX_LEVEL_SIGMA {
                level += 1;
            }
            let level_sigma = sigma / (1 << level) as f32;

            let orig = self.orig.as_ref().unwrap();
            unsafe {
                ctx.OMSetRenderTargets(None, None);
                ctx.CopySubresourceRegion(
                    &orig.texture,
                    0,
                    0,
                    0,
                    0,
                    render_target,
                    0,
                    Some(&D3D11_BOX {
                        left: x0,
                        top: y0,
                        front: 0,
                        right: x1,
                        bottom: y1,
                        back: 1,
                    }),
                );
            }

            let dim = |l: usize| -> (u32, u32) { (w.div_ceil(1 << l), h.div_ceil(1 << l)) };
            let mut base = Params::default();

            // Downsample chain: orig -> a[1] -> a[2] ... a[level]
            for l in 1..=level {
                let (src_valid, src_alloc, src_srv) = if l == 1 {
                    (
                        (w as f32, h as f32),
                        (orig.width as f32, orig.height as f32),
                        orig.srv.clone(),
                    )
                } else {
                    let sv = dim(l - 1);
                    (
                        (sv.0 as f32, sv.1 as f32),
                        (self.a[l - 1].width as f32, self.a[l - 1].height as f32),
                        self.a[l - 1].srv.clone(),
                    )
                };
                let dv = dim(l);
                base.vp = [0.0, 0.0, src_alloc.0, src_alloc.1];
                base.src = [src_valid.0, src_valid.1, 0.0, 0.0];
                self.pass(
                    ctx,
                    &self.ps_down,
                    &[Some(src_srv), None],
                    &self.a[l].rtv,
                    (self.a[l].width as f32, self.a[l].height as f32),
                    [0.0, 0.0, dv.0 as f32, dv.1 as f32],
                    base,
                )?;
            }

            // Gaussian blur at working level.
            let dv = dim(level);
            let (first_src, first_alloc) = if level == 0 {
                (orig.srv.clone(), (orig.width as f32, orig.height as f32))
            } else {
                (
                    self.a[level].srv.clone(),
                    (self.a[level].width as f32, self.a[level].height as f32),
                )
            };
            let b = &self.b[level];
            let a = &self.a[level];
            let mut blur_params = Params::default();
            blur_params.vp = [0.0, 0.0, first_alloc.0, first_alloc.1];
            blur_params.blur[0] = level_sigma;
            blur_params.src = [dv.0 as f32, dv.1 as f32, 1.0, 0.0];
            self.pass(
                ctx,
                &self.ps_blur,
                &[Some(first_src), None],
                &b.rtv,
                (b.width as f32, b.height as f32),
                [0.0, 0.0, dv.0 as f32, dv.1 as f32],
                blur_params,
            )?;
            blur_params.vp = [0.0, 0.0, b.width as f32, b.height as f32];
            blur_params.src = [dv.0 as f32, dv.1 as f32, 0.0, 1.0];
            self.pass(
                ctx,
                &self.ps_blur,
                &[Some(b.srv.clone()), None],
                &a.rtv,
                (a.width as f32, a.height as f32),
                [0.0, 0.0, dv.0 as f32, dv.1 as f32],
                blur_params,
            )?;

            // Composite back into the swap chain.
            let cm = blur.content_mask.bounds;
            let mut comp = Params::default();
            comp.vp = [0.0, 0.0, a.width as f32, a.height as f32];
            comp.src = [dv.0 as f32, dv.1 as f32, 0.0, 0.0];
            comp.blur = [0.0, blur.opacity, blur.saturate, blur.chamfer];
            comp.bounds = [bx, by, bw, bh];
            comp.radii = [
                f(blur.corner_radii.top_left),
                f(blur.corner_radii.top_right),
                f(blur.corner_radii.bottom_right),
                f(blur.corner_radii.bottom_left),
            ];
            comp.mask = [
                f(cm.origin.x),
                f(cm.origin.y),
                f(cm.size.width),
                f(cm.size.height),
            ];
            comp.region = [x0 as f32, y0 as f32, 1.0 / (1 << level) as f32, 0.0];
            // Quad covers the element bounds (plus a pixel for antialiasing), inside the region.
            let qx0 = (bx - 1.0).max(x0 as f32);
            let qy0 = (by - 1.0).max(y0 as f32);
            let qx1 = (bx + bw + 1.0).min(x1 as f32);
            let qy1 = (by + bh + 1.0).min(y1 as f32);
            self.pass(
                ctx,
                &self.ps_comp,
                &[Some(a.srv.clone()), Some(orig.srv.clone())],
                render_target_view[0].as_ref().unwrap(),
                (target_w as f32, target_h as f32),
                [qx0, qy0, (qx1 - qx0).max(0.0), (qy1 - qy0).max(0.0)],
                comp,
            )?;
        }

        unsafe {
            ctx.OMSetRenderTargets(Some(render_target_view), None);
            ctx.RSSetViewports(Some(viewport));
        }
        Ok(())
    }
}

#[inline]
fn f(v: ScaledPixels) -> f32 {
    v.0
}

// Keep `Interface` imported for `.cast()` users of this module's textures.
#[allow(dead_code)]
fn _assert_interface<T: Interface>() {}
