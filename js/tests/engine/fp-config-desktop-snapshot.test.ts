import { describe, it, expect } from 'vitest'
import { personaToFpConfig, type Persona } from '../../src/engine/persona'

/** A frozen desktop persona: every field pinned so the config is deterministic. */
const DESKTOP: Persona = {
  seed: '0123456789abcdef',
  canvasSeed: 'aaaaaaaaaaaaaaaa',
  audioSeed: 'bbbbbbbbbbbbbbbb',
  domrectSeed: 'cccccccccccccccc',
  chromeMajor: 150,
  kernelVersion: '150.0.7871.182',
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
  const config = personaToFpConfig(DESKTOP, { label: 'demo', timezone: 'America/New_York' })

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
      standard: 'Times New Roman',
      serif: 'Times New Roman',
      sansSerif: 'Arial',
      cursive: 'Comic Sans MS',
      fantasy: 'Impact',
      monospace: 'Consolas,Courier New',
      math: 'Cambria Math,Times New Roman',
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
            "cursive": "Comic Sans MS",
            "fantasy": "Impact",
            "math": "Cambria Math,Times New Roman",
            "monospace": "Consolas,Courier New",
            "sansSerif": "Arial",
            "serif": "Times New Roman",
            "standard": "Times New Roman",
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
          "unmaskedRenderer": "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9316)",
          "unmaskedVendor": "Google Inc. (Intel)",
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
