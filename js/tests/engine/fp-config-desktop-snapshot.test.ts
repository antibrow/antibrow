import { describe, it, expect } from 'vitest'
import { personaToFpConfig, type Persona } from '../../src/engine/persona'

/** A frozen desktop persona: every field pinned so the config is deterministic. */
const DESKTOP: Persona = {
  seed: '0123456789abcdef',
  canvasSeed: 'aaaaaaaaaaaaaaaa',
  audioSeed: 'bbbbbbbbbbbbbbbb',
  domrectSeed: 'cccccccccccccccc',
  chromeMajor: 150,
  kernelVersion: '150.0.0.0',
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  screenW: 1536,
  screenH: 864,
  devicePixelRatio: 1.25,
  gpuVendor: 'Google Inc. (Intel)',
  gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9316)',
  languages: ['en-US', 'en'],
  timezone: 'America/Los_Angeles',
}

describe('desktop fp-config is frozen', () => {
  // Pinned to a Windows host: the font aliases only go out when the host is not
  // the OS the persona claims, and without this the snapshot would say
  // something different on every CI runner.
  const config = personaToFpConfig(DESKTOP, { label: 'demo', timezone: 'America/New_York', hostPlatform: 'win32' })

  it('never grows a device block', () => {
    expect('device' in config).toBe(false)
  })

  it('keeps the Windows navigator surface', () => {
    expect(config.navigator).toEqual({
      userAgent: DESKTOP.ua,
      platform: 'Win32',
      vendor: 'Google Inc.',
      language: 'en-US',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
      deviceMemory: 16,
      maxTouchPoints: 0,
      uaData: {
        platform: 'Windows',
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        wow64: false,
        model: '',
      },
    })
  })

  it('keeps the taskbar-adjusted screen', () => {
    expect(config.screen).toEqual({
      width: 1536,
      height: 864,
      availWidth: 1536,
      availHeight: 816,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 1.25,
    })
  })

  it('keeps the Windows font surface', () => {
    const fonts = config.fonts as { uiFont: string; keepCjk: number; allow: string[]; generic: Record<string, string> }
    expect(fonts.uiFont).toBe('Segoe UI')
    expect(fonts.keepCjk).toBe(0)
    expect(fonts.allow).toEqual([
      'Arial',
      'Arial Black',
      'Bahnschrift',
      'Calibri',
      'Cambria',
      'Cambria Math',
      'Candara',
      'Comic Sans MS',
      'Consolas',
      'Constantia',
      'Corbel',
      'Courier New',
      'Ebrima',
      'Franklin Gothic Medium',
      'Gabriola',
      'Gadugi',
      'Georgia',
      'Impact',
      'Ink Free',
      'Javanese Text',
      'Leelawadee UI',
      'Lucida Console',
      'Lucida Sans Unicode',
      'MV Boli',
      'Marlett',
      'Microsoft Sans Serif',
      'Palatino Linotype',
      'Segoe Print',
      'Segoe Script',
      'Segoe UI',
      'Segoe UI Emoji',
      'Segoe UI Symbol',
      'Sitka',
      'Sylfaen',
      'Symbol',
      'Tahoma',
      'Times New Roman',
      'Trebuchet MS',
      'Verdana',
      'Webdings',
      'Wingdings',
    ])
    expect(fonts.generic).toEqual({
      standard: 'Times New Roman,Georgia',
      serif: 'Times New Roman,Georgia',
      sansSerif: 'Arial,Verdana',
      cursive: 'Comic Sans MS,Trebuchet MS',
      fantasy: 'Impact,Arial Black',
      monospace: 'Consolas,Courier New',
      math: 'Cambria Math,Times New Roman,Georgia',
    })
  })

  it('keeps the top-level key set exactly', () => {
    expect(Object.keys(config).sort()).toEqual([
      'apilog', 'audio', 'canvas', 'connection', 'domrect', 'fonts', 'label',
      'navigator', 'prefersColorScheme', 'screen', 'seed', 'timezone',
      'version', 'webgl', 'webgpu', 'webrtc',
    ])
  })

  // The net: catches any field, including ones added later, without anyone
  // remembering to extend a named assertion for it. The named assertions
  // above are the documentation of what a reader should expect to find here.
  it('matches the whole config byte for byte', () => {
    expect(config).toMatchInlineSnapshot(`
      {
        "apilog": {
          "enabled": false,
          "mode": "off",
          "path": "",
        },
        "audio": {
          "seed": "bbbbbbbbbbbbbbbb",
        },
        "canvas": {
          "seed": "aaaaaaaaaaaaaaaa",
        },
        "connection": {
          "downlink": 1.975,
          "effectiveType": "4g",
          "rtt": 200,
        },
        "domrect": {
          "seed": "cccccccccccccccc",
        },
        "fonts": {
          "allow": [
            "Arial",
            "Arial Black",
            "Bahnschrift",
            "Calibri",
            "Cambria",
            "Cambria Math",
            "Candara",
            "Comic Sans MS",
            "Consolas",
            "Constantia",
            "Corbel",
            "Courier New",
            "Ebrima",
            "Franklin Gothic Medium",
            "Gabriola",
            "Gadugi",
            "Georgia",
            "Impact",
            "Ink Free",
            "Javanese Text",
            "Leelawadee UI",
            "Lucida Console",
            "Lucida Sans Unicode",
            "MV Boli",
            "Marlett",
            "Microsoft Sans Serif",
            "Palatino Linotype",
            "Segoe Print",
            "Segoe Script",
            "Segoe UI",
            "Segoe UI Emoji",
            "Segoe UI Symbol",
            "Sitka",
            "Sylfaen",
            "Symbol",
            "Tahoma",
            "Times New Roman",
            "Trebuchet MS",
            "Verdana",
            "Webdings",
            "Wingdings",
          ],
          "block": [],
          "generic": {
            "cursive": "Comic Sans MS,Trebuchet MS",
            "fantasy": "Impact,Arial Black",
            "math": "Cambria Math,Times New Roman,Georgia",
            "monospace": "Consolas,Courier New",
            "sansSerif": "Arial,Verdana",
            "serif": "Times New Roman,Georgia",
            "standard": "Times New Roman,Georgia",
          },
          "keepCjk": 0,
          "uiFont": "Segoe UI",
        },
        "label": "demo",
        "navigator": {
          "deviceMemory": 16,
          "hardwareConcurrency": 8,
          "language": "en-US",
          "languages": [
            "en-US",
            "en",
          ],
          "maxTouchPoints": 0,
          "platform": "Win32",
          "uaData": {
            "architecture": "x86",
            "bitness": "64",
            "model": "",
            "platform": "Windows",
            "platformVersion": "15.0.0",
            "wow64": false,
          },
          "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
          "vendor": "Google Inc.",
        },
        "prefersColorScheme": "light",
        "screen": {
          "availHeight": 816,
          "availWidth": 1536,
          "colorDepth": 24,
          "devicePixelRatio": 1.25,
          "height": 864,
          "pixelDepth": 24,
          "width": 1536,
        },
        "seed": "0123456789abcdef",
        "timezone": "America/New_York",
        "version": 1,
        "webgl": {
          "extensions": {
            "allow": [
              "ANGLE_instanced_arrays",
              "EXT_blend_minmax",
              "EXT_clip_control",
              "EXT_color_buffer_half_float",
              "EXT_depth_clamp",
              "EXT_disjoint_timer_query",
              "EXT_float_blend",
              "EXT_frag_depth",
              "EXT_polygon_offset_clamp",
              "EXT_sRGB",
              "EXT_shader_texture_lod",
              "EXT_texture_compression_bptc",
              "EXT_texture_compression_rgtc",
              "EXT_texture_filter_anisotropic",
              "EXT_texture_mirror_clamp_to_edge",
              "KHR_parallel_shader_compile",
              "OES_element_index_uint",
              "OES_fbo_render_mipmap",
              "OES_standard_derivatives",
              "OES_texture_float",
              "OES_texture_float_linear",
              "OES_texture_half_float",
              "OES_texture_half_float_linear",
              "OES_vertex_array_object",
              "WEBGL_blend_func_extended",
              "WEBGL_color_buffer_float",
              "WEBGL_compressed_texture_s3tc",
              "WEBGL_compressed_texture_s3tc_srgb",
              "WEBGL_debug_renderer_info",
              "WEBGL_debug_shaders",
              "WEBGL_depth_texture",
              "WEBGL_draw_buffers",
              "WEBGL_lose_context",
              "WEBGL_multi_draw",
              "WEBGL_polygon_mode",
            ],
          },
          "params": {
            "3379": 16384,
            "34024": 16384,
            "34047": 16,
            "34076": 16384,
            "3408": 4,
            "3410": 8,
            "3411": 8,
            "3412": 8,
            "3413": 8,
            "3414": 24,
            "3415": 0,
            "34921": 16,
            "34930": 16,
            "35660": 16,
            "35661": 32,
            "36347": 4096,
            "36348": 30,
            "36349": 1024,
          },
          "shaderPrecision": {
            "35632-36336": "127,127,23",
            "35632-36337": "127,127,23",
            "35632-36338": "127,127,23",
            "35632-36339": "31,30,0",
            "35632-36340": "31,30,0",
            "35632-36341": "31,30,0",
            "35633-36336": "127,127,23",
            "35633-36337": "127,127,23",
            "35633-36338": "127,127,23",
            "35633-36339": "31,30,0",
            "35633-36340": "31,30,0",
            "35633-36341": "31,30,0",
          },
          "shadingLanguageVersion": "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
          "shadingLanguageVersion2": "OpenGL ES GLSL ES 3.0 Chromium",
          "unmaskedRenderer": "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9316)",
          "unmaskedVendor": "Google Inc. (Intel)",
          "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
          "version2": "OpenGL ES 3.0 Chromium",
        },
        "webgpu": {
          "architecture": "gen-9",
          "vendor": "intel",
        },
        "webrtc": {
          "mode": "disable",
        },
      }
    `)
  })
})
