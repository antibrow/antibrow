"""Self-consistent browser identities ("personas") and their fp-config form.

A persona is generated once, the first time a profile directory is used, and
then frozen in ``<profile>/persona.json``. It never drifts: the same profile
always reports the same UA, GPU, screen, seeds and language. On every launch the
persona is serialized to ``<profile>/fp-config.json`` and handed to the kernel
via ``--fp-config``; the kernel passes that file into every child process and
Blink reads the values from there.

The JSON on disk uses the same camelCase keys as the Node SDK, so a profile
written by either SDK - or by the desktop app - is readable by the others.
"""

from __future__ import annotations

import json
import math
import random
import re
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Literal, Optional, Sequence, Tuple

from .android_devices import ANDROID_FALLBACK_DEVICES
from .kernel import normalize_kernel_version

PERSONA_FILE = "persona.json"
FP_CONFIG_FILE = "fp-config.json"
#: Where the kernel writes the per-profile API log when one is enabled.
API_LOG_FILE = "fp-api-log.jsonl"

DeviceType = Literal["desktop", "android"]

#: Android majors the bundled devices vary across; the corpus rows themselves
#: sit at 15-16.
ANDROID_OS_MAJORS: Sequence[int] = (13, 14, 15, 16)

#: (unmaskedVendor, unmaskedRenderer) pairs. Mainstream Windows GPUs; the vendor
#: string always agrees with the renderer string, which is what CreepJS-style
#: consistency checks look at.
GPUS: Sequence[Tuple[str, str]] = (
    (
        "Google Inc. (Intel)",
        "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9316)",
    ),
    (
        "Google Inc. (Intel)",
        "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.4577)",
    ),
    (
        "Google Inc. (NVIDIA)",
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3699)",
    ),
    (
        "Google Inc. (NVIDIA)",
        "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3179)",
    ),
    (
        "Google Inc. (AMD)",
        "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.12027.9001)",
    ),
)

#: (cssWidth, cssHeight, devicePixelRatio) for mainstream Windows laptops.
#: devicePixelRatio is deliberately never 1.0 — a scaled display is both the
#: common case and what gates the kernel's DOMRect noise.
SCREENS: Sequence[Tuple[int, int, float]] = (
    (1536, 864, 1.25),   # 1920x1080 @125% - the most common Windows fingerprint
    (1280, 720, 1.5),    # 1920x1080 @150%
    (1707, 960, 1.5),    # 2560x1440 @150%
    (1280, 800, 1.5),    # 1920x1200 @150%
    (1440, 900, 1.25),   # 1800x1125
)

HARDWARE_CONCURRENCY: Sequence[int] = (4, 8, 12, 16)
DEVICE_MEMORY: Sequence[int] = (8, 16)

#: Taskbar height subtracted from screen height to get ``screen.availHeight``.
_TASKBAR_HEIGHT = 48

_JSON_KEYS = (
    ("seed", "seed"),
    ("canvas_seed", "canvasSeed"),
    ("audio_seed", "audioSeed"),
    ("domrect_seed", "domrectSeed"),
    ("chrome_major", "chromeMajor"),
    ("kernel_version", "kernelVersion"),
    ("ua", "ua"),
    ("hardware_concurrency", "hardwareConcurrency"),
    ("device_memory", "deviceMemory"),
    ("screen_w", "screenW"),
    ("screen_h", "screenH"),
    ("device_pixel_ratio", "devicePixelRatio"),
    ("gpu_vendor", "gpuVendor"),
    ("gpu_renderer", "gpuRenderer"),
    ("languages", "languages"),
    ("timezone", "timezone"),
)


def _rand_hex16(rng: Optional[random.Random] = None) -> str:
    """16 lowercase hex chars (8 bytes), the seed width the kernel expects."""
    if rng is None:
        return secrets.token_hex(8)
    return "".join(rng.choice("0123456789abcdef") for _ in range(16))


_CAPTURED_JSON_KEYS = (
    ("platform", "platform"),
    ("vendor", "vendor"),
    ("max_touch_points", "maxTouchPoints"),
    ("color_depth", "colorDepth"),
    ("avail_w", "availW"),
    ("avail_h", "availH"),
    ("prefers_color_scheme", "prefersColorScheme"),
    ("connection_effective_type", "connectionEffectiveType"),
    ("connection_rtt", "connectionRtt"),
    ("connection_downlink", "connectionDownlink"),
    ("connection_type", "connectionType"),
    ("connection_downlink_max", "connectionDownlinkMax"),
    ("ua_platform", "uaPlatform"),
    ("ua_platform_version", "uaPlatformVersion"),
    ("ua_architecture", "uaArchitecture"),
    ("ua_bitness", "uaBitness"),
    ("ua_model", "uaModel"),
    ("ua_mobile", "uaMobile"),
    ("audio_sample_rate", "audioSampleRate"),
    ("audio_max_channel_count", "audioMaxChannelCount"),
    ("fonts", "fonts"),
    ("webgl_extensions", "webglExtensions"),
)


@dataclass
class CapturedFacts:
    """Facts lifted verbatim from one real device.

    Every field maps to an existing fp-config channel, so this block swaps
    invented values for one machine's real ones without needing kernel
    changes. An absent field falls back to the generated value - which is why
    ``ua_architecture``, ``ua_bitness``, ``ua_model`` and ``ua_mobile`` are
    optional rather than defaulted: ``""`` and ``False`` are real values on
    mobile, distinct from "not captured". Check ``is not None``, never
    truthiness.
    """

    platform: Optional[str] = None
    vendor: Optional[str] = None
    max_touch_points: Optional[int] = None
    color_depth: Optional[int] = None
    avail_w: Optional[int] = None
    avail_h: Optional[int] = None
    prefers_color_scheme: Optional[str] = None
    connection_effective_type: Optional[str] = None
    connection_rtt: Optional[float] = None
    connection_downlink: Optional[float] = None
    connection_type: Optional[str] = None
    #: ``<= 0`` is the wire encoding for Infinity, which JSON cannot express.
    connection_downlink_max: Optional[float] = None
    ua_platform: Optional[str] = None
    ua_platform_version: Optional[str] = None
    ua_architecture: Optional[str] = None
    ua_bitness: Optional[str] = None
    ua_model: Optional[str] = None
    ua_mobile: Optional[bool] = None
    audio_sample_rate: Optional[int] = None
    audio_max_channel_count: Optional[int] = None
    fonts: Optional[List[str]] = None
    webgl_extensions: Optional[List[str]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for attr, json_key in _CAPTURED_JSON_KEYS:
            value = getattr(self, attr)
            if value is not None:
                out[json_key] = value
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CapturedFacts":
        kwargs = {}
        for attr, json_key in _CAPTURED_JSON_KEYS:
            if json_key in data:
                kwargs[attr] = data[json_key]
        return cls(**kwargs)


@dataclass
class Persona:
    """A frozen, self-consistent browser identity."""

    seed: str
    canvas_seed: str
    audio_seed: str
    domrect_seed: str
    chrome_major: int
    kernel_version: str
    ua: str
    hardware_concurrency: int
    device_memory: int
    screen_w: int
    screen_h: int
    device_pixel_ratio: float
    gpu_vendor: str
    gpu_renderer: str
    languages: List[str] = field(default_factory=lambda: ["en-US", "en"])
    #: Fallback timezone; overridden at launch from the proxy's exit-IP geo.
    timezone: str = "America/Los_Angeles"
    #: A real device's WebGL report, replayed verbatim so the GL facts stay
    #: anchored to one machine. Absent for personas generated here.
    captured_webgl: Optional[Dict[str, Any]] = None
    #: Absent means desktop, so existing profiles keep their current behaviour.
    device_type: Optional[DeviceType] = None
    android_model: Optional[str] = None
    android_os_major: Optional[int] = None
    captured: Optional[CapturedFacts] = None

    def to_dict(self) -> Dict[str, Any]:
        """camelCase dict, byte-compatible with the Node SDK's persona.json."""
        out = {json_key: getattr(self, attr) for attr, json_key in _JSON_KEYS}
        if self.captured_webgl:
            out["capturedWebgl"] = self.captured_webgl
        if self.device_type is not None:
            out["deviceType"] = self.device_type
        if self.android_model is not None:
            out["androidModel"] = self.android_model
        if self.android_os_major is not None:
            out["androidOsMajor"] = self.android_os_major
        if self.captured is not None:
            out["captured"] = self.captured.to_dict()
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Persona":
        kwargs = {}
        for attr, json_key in _JSON_KEYS:
            if json_key in data:
                kwargs[attr] = data[json_key]
        captured_webgl = data.get("capturedWebgl")
        if isinstance(captured_webgl, dict):
            kwargs["captured_webgl"] = captured_webgl
        if "deviceType" in data:
            kwargs["device_type"] = data["deviceType"]
        if "androidModel" in data:
            kwargs["android_model"] = data["androidModel"]
        if "androidOsMajor" in data:
            kwargs["android_os_major"] = data["androidOsMajor"]
        captured = data.get("captured")
        if isinstance(captured, dict):
            kwargs["captured"] = CapturedFacts.from_dict(captured)
        # Older profiles predate kernelVersion: load them with an empty
        # version so the caller can backfill it without touching the seeds.
        kwargs.setdefault("kernel_version", "")
        return cls(**kwargs)


def _generate_desktop_persona(
    chrome_major: int, kernel_version: str, rng: Optional[random.Random] = None
) -> Persona:
    chooser = rng or random
    screen_w, screen_h, dpr = chooser.choice(list(SCREENS))
    gpu_vendor, gpu_renderer = chooser.choice(list(GPUS))
    return Persona(
        seed=_rand_hex16(rng),
        canvas_seed=_rand_hex16(rng),
        audio_seed=_rand_hex16(rng),
        domrect_seed=_rand_hex16(rng),
        chrome_major=chrome_major,
        kernel_version=kernel_version,
        ua=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36".format(major=chrome_major)
        ),
        hardware_concurrency=chooser.choice(list(HARDWARE_CONCURRENCY)),
        device_memory=chooser.choice(list(DEVICE_MEMORY)),
        screen_w=screen_w,
        screen_h=screen_h,
        device_pixel_ratio=dpr,
        gpu_vendor=gpu_vendor,
        gpu_renderer=gpu_renderer,
        languages=["en-US", "en"],
        timezone="America/Los_Angeles",
    )


def _parse_leading_int(value: Optional[str]) -> Optional[int]:
    """``"15.0.0"`` -> ``15``. Mirrors JS ``parseInt(value, 10) || undefined``."""
    if not value:
        return None
    match = re.match(r"\d+", value)
    return int(match.group()) if match else None


def device_to_persona_parts(
    device: Dict[str, Any],
    chrome_major: int,
    os_major: Optional[int] = None,
) -> Dict[str, Any]:
    """Flatten one device row into the persona fields that replay it.

    The corpus spells its WebGL keys in camelCase while the replay channel
    expects the capture tool's uppercase names, so this is also where that
    translation lives. The returned dict's keys are :class:`Persona` attribute
    names, meant to be applied with ``setattr`` - only present keys should
    overwrite the base persona.
    """
    webgl_in = device.get("webgl") or {}
    webgl: Dict[str, Any] = {}
    if webgl_in.get("version"):
        webgl["VERSION"] = webgl_in["version"]
    if webgl_in.get("shadingLanguageVersion"):
        webgl["SHADING_LANGUAGE_VERSION"] = webgl_in["shadingLanguageVersion"]
    if webgl_in.get("version2"):
        webgl["VERSION2"] = webgl_in["version2"]
    if webgl_in.get("shadingLanguageVersion2"):
        webgl["SHADING_LANGUAGE_VERSION2"] = webgl_in["shadingLanguageVersion2"]
    # JS truthiness on an object checks presence, not emptiness (`{}` is
    # truthy) - `is not None` is the Python equivalent, not `if webgl_in...`.
    if webgl_in.get("params") is not None:
        webgl["params"] = webgl_in["params"]
    if webgl_in.get("shaderPrecision") is not None:
        webgl["shaderPrecision"] = webgl_in["shaderPrecision"]

    android = device.get("os") == "android"
    navigator = device.get("navigator") or {}
    ua_data = navigator.get("uaData") or {}
    # A caller-supplied os_major (the bundled rows' override) always wins.
    # Otherwise the version travels only in uaData.platformVersion - NOT
    # device["osMajor"], which UA reduction froze at 10 for every modern
    # Android UA string.
    if os_major is not None:
        platform_version = "{0}.0.0".format(os_major)
        major: Optional[int] = os_major
    else:
        platform_version = ua_data.get("platformVersion")
        major = _parse_leading_int(platform_version)

    connection = device.get("connection") or {}
    audio = device.get("audio") or {}
    screen = device.get("screen") or {}
    captured = CapturedFacts(
        platform=navigator.get("platform"),
        vendor=navigator.get("vendor"),
        max_touch_points=navigator.get("maxTouchPoints"),
        color_depth=screen.get("colorDepth"),
        avail_w=screen.get("availWidth"),
        avail_h=screen.get("availHeight"),
        # The trio travels together or not at all - see derive_connection.
        connection_effective_type=connection.get("effectiveType"),
        connection_rtt=connection.get("rtt"),
        connection_downlink=connection.get("downlink"),
        connection_type=connection.get("type"),
        # The corpus carries `None` for "no cap reported", which is already
        # CapturedFacts' own "not captured" - nothing to collapse here.
        connection_downlink_max=connection.get("downlinkMax"),
        ua_platform=ua_data.get("platform"),
        ua_platform_version=platform_version,
        ua_architecture=ua_data.get("architecture"),
        ua_bitness=ua_data.get("bitness"),
        ua_model=ua_data.get("model"),
        ua_mobile=ua_data.get("mobile"),
        audio_sample_rate=audio.get("sampleRate"),
        audio_max_channel_count=audio.get("maxChannelCount"),
        fonts=device.get("fonts"),
        webgl_extensions=webgl_in.get("extensions"),
    )
    # rtt and downlink stay generated: they follow the proxy we measure at
    # launch, not the machine the corpus came off.

    return {
        "device_type": "android" if android else "desktop",
        "android_model": device.get("model") if android else None,
        "android_os_major": major if android else None,
        "ua": device["ua"].replace("{major}", str(chrome_major)),
        "hardware_concurrency": navigator.get("hardwareConcurrency"),
        "device_memory": navigator.get("deviceMemory"),
        "screen_w": screen.get("width"),
        "screen_h": screen.get("height"),
        "device_pixel_ratio": screen.get("devicePixelRatio"),
        "gpu_vendor": webgl_in.get("unmaskedVendor"),
        "gpu_renderer": webgl_in.get("unmaskedRenderer"),
        "captured": captured,
        "captured_webgl": webgl if webgl else None,
    }


def generate_persona(
    chrome_major: int,
    kernel_version: str,
    rng: Optional[random.Random] = None,
    device_type: Optional[DeviceType] = None,
    device: Optional[Dict[str, Any]] = None,
) -> Persona:
    """Roll a new self-consistent persona, desktop or Android.

    ``device`` replays one real device's facts verbatim (a row from the device
    library, or a bundled fallback); passing only ``device_type="android"``
    with no ``device`` picks one of the three bundled devices at random.
    ``rng`` makes generation reproducible in tests; production calls use
    :mod:`secrets` for the seeds and :mod:`random` for the picks.
    """
    chooser = rng or random
    wants_android = device_type == "android" or (device is not None and device.get("os") == "android")
    picked_device = device
    if picked_device is None and wants_android:
        picked_device = chooser.choice(list(ANDROID_FALLBACK_DEVICES))
    if picked_device is None:
        return _generate_desktop_persona(chrome_major, kernel_version, rng)

    persona = _generate_desktop_persona(chrome_major, kernel_version, rng)
    # The bundled rows are fixed, so vary the Android major to keep free-tier
    # profiles from all reporting one system version. A caller-supplied
    # device keeps its own captured version.
    os_major_override = None if device is not None else chooser.choice(list(ANDROID_OS_MAJORS))
    parts = device_to_persona_parts(picked_device, chrome_major, os_major_override)
    for key, value in parts.items():
        if value is not None:
            setattr(persona, key, value)
    return persona


def chrome_major_of(kernel_version: str) -> int:
    """``"150"`` -> ``150``. Keeps the UA in step with the binary."""
    head = kernel_version.split(".")[0] if kernel_version else ""
    try:
        return int(head)
    except ValueError:
        raise ValueError("Malformed kernel version: {0!r}".format(kernel_version))


# The capability surface a Windows Chrome answers with over D3D11. Without it
# only the two unmasked strings are spoofed and getParameter, the shader
# precision ranges and the extension list keep reporting the host GPU, so a
# persona claiming D3D11 replies with Metal or Mesa numbers - one API
# contradicting itself, which is harder evidence than any single odd value.
#
# Taken from 133 real Windows captures: every entry below was unanimous across
# Intel, NVIDIA and AMD. Keys are the decimal GLenum the kernel looks up.
_D3D11_PARAMS: Dict[str, int] = {
    "3379": 16384, "3408": 4, "3410": 8, "3411": 8, "3412": 8, "3413": 8,
    "3414": 24, "3415": 0, "34024": 16384, "34047": 16, "34076": 16384,
    "34921": 16, "34930": 16, "35660": 16, "35661": 32, "36348": 30,
    "36349": 1024,
}

# highp/mediump/lowp, vertex and fragment; "min,max,precision" per the kernel.
_D3D11_SHADER_PRECISION: Dict[str, str] = {
    "35632-36336": "127,127,23", "35632-36337": "127,127,23", "35632-36338": "127,127,23",
    "35632-36339": "31,30,0", "35632-36340": "31,30,0", "35632-36341": "31,30,0",
    "35633-36336": "127,127,23", "35633-36337": "127,127,23", "35633-36338": "127,127,23",
    "35633-36339": "31,30,0", "35633-36340": "31,30,0", "35633-36341": "31,30,0",
}

_D3D11_EXTENSIONS = [
    "ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_clip_control",
    "EXT_color_buffer_half_float", "EXT_depth_clamp", "EXT_disjoint_timer_query",
    "EXT_float_blend", "EXT_frag_depth", "EXT_polygon_offset_clamp", "EXT_sRGB",
    "EXT_shader_texture_lod", "EXT_texture_compression_bptc",
    "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic",
    "EXT_texture_mirror_clamp_to_edge", "KHR_parallel_shader_compile",
    "OES_element_index_uint", "OES_fbo_render_mipmap", "OES_standard_derivatives",
    "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float",
    "OES_texture_half_float_linear", "OES_vertex_array_object",
    "WEBGL_blend_func_extended", "WEBGL_color_buffer_float",
    "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb",
    "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_depth_texture",
    "WEBGL_draw_buffers", "WEBGL_lose_context", "WEBGL_multi_draw",
    "WEBGL_polygon_mode",
]


def windows_webgl_config(gpu_vendor: str) -> Dict[str, Any]:
    """The Windows GL report for a persona with no real-device capture behind it.

    A capture overrides this field by field, so a replayed machine is unaffected.
    """
    # MAX_VERTEX_UNIFORM_VECTORS is the one value that splits by vendor: NVIDIA
    # reports one fewer than Intel and AMD. Pairing an NVIDIA renderer string
    # with 4096 is a mismatch a GL-aware scanner can name.
    params = dict(_D3D11_PARAMS)
    params["36347"] = 4095 if "NVIDIA" in gpu_vendor else 4096
    return {
        "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
        "shadingLanguageVersion": "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
        # The webgl2 pair is the inner string only - see _inner_gl_string.
        "version2": "OpenGL ES 3.0 Chromium",
        "shadingLanguageVersion2": "OpenGL ES GLSL ES 3.0 Chromium",
        "params": params,
        "shaderPrecision": dict(_D3D11_SHADER_PRECISION),
        "extensions": {"allow": list(_D3D11_EXTENSIONS)},
    }


def _inner_gl_string(reported: str) -> str:
    """Strip the outer "WebGL 2.0 (...)" wrapper off a reported GL version.

    The two webgl2 keys are asymmetric with their webgl1 counterparts: the
    kernel returns ``version``/``shadingLanguageVersion`` verbatim but wraps the
    ``2`` pair in its own prefix. A capture records what the browser reported,
    which is the wrapped form, so passing it straight through produced
    "WebGL 2.0 (WebGL 2.0 (OpenGL ES 3.0 Chromium))" - a string no browser emits.
    """
    open_paren = reported.find("(")
    if open_paren > 0 and reported.endswith(")"):
        return reported[open_paren + 1 : -1]
    return reported


def captured_webgl_config(captured: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Translate a captured ``webgl`` blob into the fields the kernel replays.

    Each ``shaderPrecision`` triple becomes a ``"min,max,precision"`` string;
    anything malformed is dropped rather than passed on to the kernel.
    """
    if not captured:
        return {}
    out: Dict[str, Any] = {}
    version = captured.get("VERSION")
    if isinstance(version, str):
        out["version"] = version
    shading = captured.get("SHADING_LANGUAGE_VERSION")
    if isinstance(shading, str):
        out["shadingLanguageVersion"] = shading
    # The webgl2 context reports its own version pair. Replaying only the
    # webgl1 half leaves GL1 telling the truth while GL2 keeps the
    # synthesized strings.
    version2 = captured.get("VERSION2")
    if isinstance(version2, str):
        out["version2"] = _inner_gl_string(version2)
    shading2 = captured.get("SHADING_LANGUAGE_VERSION2")
    if isinstance(shading2, str):
        out["shadingLanguageVersion2"] = _inner_gl_string(shading2)
    params = captured.get("params")
    if isinstance(params, dict):
        out["params"] = params
    precision_in = captured.get("shaderPrecision")
    if isinstance(precision_in, dict):
        precision = {
            key: ",".join(str(n) for n in value)
            for key, value in precision_in.items()
            if isinstance(value, list)
            and len(value) == 3
            and all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in value)
        }
        if precision:
            out["shaderPrecision"] = precision
    # Whitelist, not a replacement: the kernel intersects it with what the host
    # GPU really supports. Leaving it out kept the extension list host-shaped
    # while every other GL fact came from the captured machine.
    extensions = captured.get("extensions")
    if isinstance(extensions, list) and extensions:
        out["extensions"] = {"allow": extensions}
    return out


def webgpu_identity(renderer: str) -> Tuple[str, str]:
    """``(vendor, architecture)`` for ``navigator.gpu``, derived from the WebGL renderer.

    The kernel rewrites ``adapter.info`` with these so WebGPU names the same GPU
    the WebGL unmasked strings do; without it WebGL reports the spoofed card
    while WebGPU leaks the real one, and that disagreement is exactly what
    cross-API fingerprint checks look for.

    ``architecture`` is Dawn's ``gpu_info::GetArchitectureName``: NVIDIA on D3D
    reports an empty string, modern AMD reports ``rdna-N``, Intel reports
    ``gen-N`` / ``xe-lpg``. An empty vendor means "don't spoof" — the kernel then
    keeps the real values.
    """
    r = renderer.lower()
    if "nvidia" in r:
        return ("nvidia", "")
    if "amd" in r or "radeon" in r:
        return ("amd", "rdna-3")
    if "intel" in r:
        if "iris" in r and "xe" in r:
            return ("intel", "gen-12lp")  # Iris Xe = Tiger Lake, Gen12
        if "arc" in r:
            return ("intel", "xe-lpg")  # Arc = Xe-HPG/LPG
        if "uhd" in r or "hd graphics" in r:
            return ("intel", "gen-9")  # UHD/HD 6xx = Skylake..Coffee Lake
        return ("intel", "gen-12lp")  # modern Intel fallback
    return ("", "")


#: Chromium's http-RTT cut-offs for navigator.connection.effectiveType, copied
#: from net/nqe/network_quality_estimator_params.h's
#: kHttpRttEffectiveConnectionTypeThresholds (SLOW_2G 2010, 2G 1420, 3G 272 -
#: enum order is UNKNOWN, OFFLINE, SLOW_2G, 2G, 3G, 4G) and treated as
#: approximate: what matters is that the trio is internally consistent.
ECT_RTT_THRESHOLDS: Dict[str, int] = {"four_g": 272, "three_g": 1420, "two_g": 2010}


def derive_connection(
    seed: str,
    rtt_ms: Optional[float] = None,
    captured: Optional["CapturedFacts"] = None,
) -> Dict[str, Any]:
    """Build a self-consistent navigator.connection.

    Chrome rounds rtt to 25ms and downlink to 25kbps (0.025Mbps) and derives
    effectiveType from rtt, so a mismatched trio ('4g' with rtt 800, '3g' with 10Mbps) is a
    contradiction rather than camouflage. rtt comes from the proxy probe when
    there is one, so a site measuring latency itself agrees with what we report.

    The formula is identical to the JS SDK's deriveConnection on purpose: the two
    must produce byte-identical fp-config for one persona. Python's round() is
    banker's rounding (round(0.5) == 0) while JS Math.round() rounds half up, so
    the grid-snaps below use floor(x + 0.5) instead of round() to match exactly.
    """
    seed_sum = sum(ord(c) for c in seed)
    # math.isfinite matters here: an unguarded +inf reaches math.floor(inf) below
    # and raises OverflowError, where JS's Number.isFinite degrades it to the
    # seed-derived fallback like any other non-measurement.
    measured = rtt_ms is not None and math.isfinite(rtt_ms) and rtt_ms > 0
    # A captured trio is one real Chrome's own output, so it already agrees with
    # itself - replayed whole rather than re-derived, because Chrome weighs
    # downlink as well as rtt and our rtt-only approximation would "correct" a
    # true reading into a false one. Only with nothing measured: once the proxy
    # probe knows the real latency, a site can measure it too, and that latency
    # is this connection's, not the corpus machine's.
    if (
        not measured
        and captured is not None
        and captured.connection_effective_type
        and captured.connection_rtt is not None
        and captured.connection_downlink is not None
    ):
        return {
            "effectiveType": captured.connection_effective_type,
            "rtt": captured.connection_rtt,
            "downlink": captured.connection_downlink,
        }
    # Unmeasured: stay under the 4g threshold so the trio holds, but vary per
    # persona - this used to be one global constant.
    raw = float(rtt_ms) if measured else 50 + (seed_sum % 9) * 25
    rtt = min(3000, max(25, int(math.floor(raw / 25 + 0.5)) * 25))
    if rtt < ECT_RTT_THRESHOLDS["four_g"]:
        effective_type = "4g"
    elif rtt < ECT_RTT_THRESHOLDS["three_g"]:
        effective_type = "3g"
    elif rtt < ECT_RTT_THRESHOLDS["two_g"]:
        effective_type = "2g"
    else:
        effective_type = "slow-2g"
    min_dl, max_dl = (1.0, 10.0) if effective_type == "4g" else (0.4, 1.5)
    steps = int(math.floor((max_dl - min_dl) / 0.025 + 0.5))
    downlink = math.floor((min_dl + (seed_sum % (steps + 1)) * 0.025) * 1000 + 0.5) / 1000
    # Python's `/ 100` always yields a float, so a whole value like 6.0 would
    # serialize as "6.0" where JS's untyped Number serializes the same value as
    # "6" - fp-config must be byte-identical, so collapse it back to int here.
    if downlink == int(downlink):
        downlink = int(downlink)
    return {"effectiveType": effective_type, "rtt": rtt, "downlink": downlink}


# ``allow`` is a whitelist over the kernel's probeable font set - left empty
# it hides nothing, and every host font (macOS/Linux system fonts on a
# non-Windows host, or the AOSP set on Android) stays enumerable.
_WINDOWS_ALLOW_FONTS: Sequence[str] = (
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
)

# The stock AOSP family names. Known gap: no desktop host ships Roboto or
# Noto, and an allow-list only subtracts - it cannot conjure a font. What it
# does buy is keeping host-only families (Segoe UI, Helvetica Neue, Menlo)
# out of the enumerable set. A replayed device adds the names that phone really
# resolved, which on Android is the alias set (Arial, ...) - see _merge_fonts.
_ANDROID_ALLOW_FONTS: Sequence[str] = (
    "Roboto", "Roboto Condensed", "Roboto Mono", "Noto Sans", "Noto Serif",
    "Noto Sans Mono", "Noto Color Emoji", "Droid Sans Mono",
    "Carrois Gothic SC", "Coming Soon", "Cutive Mono", "Dancing Script",
)

# Families the host OS ships under the same name, lowercased. ``fonts.allow``
# is default-deny once non-empty, so anything listed but absent from the host
# enumerates as installed while measuring like a family nobody has - the same
# contradiction the allowlist exists to prevent. Membership is a property of the
# host OS, not of this machine: a font the user installed themselves is
# deliberately not counted, since dropping one family is a weak signal and
# claiming one that cannot be drawn is a hard tell.
#
# darwin is /System/Library/Fonts/Supplemental, which every macOS ships. linux
# has no equivalent - the MS core fonts are a separate package there, so a
# Windows persona on Linux keeps only what the kernel bundles a stand-in for.
_HOST_FONTS: Dict[str, FrozenSet[str]] = {
    "darwin": frozenset(
        {
            "andale mono", "arial", "arial black", "arial narrow",
            "arial unicode ms", "brush script mt", "comic sans ms",
            "courier new", "georgia", "impact", "microsoft sans serif",
            "tahoma", "times new roman", "trebuchet ms", "verdana", "webdings",
            "wingdings", "wingdings 2", "wingdings 3",
        }
    ),
}

# Metric-compatible stand-ins the kernel ships and matches behind the original
# family name. Windows-only families do not exist on another host, so
# ``measureText`` returns one shared fallback width for all of them - the same
# width a family nobody ever installed gets, which on a real Windows machine
# never happens. The stand-ins stay out of ``allow``, so none of them
# enumerates. Keys must be lowercase and trimmed: that is what the kernel
# looks up.
_WINDOWS_FONT_ALIAS: Dict[str, str] = {
    "segoe ui": "Selawia",
    "segoe ui semibold": "Selawia",
    "segoe ui symbol": "Selawia",
    "calibri": "Carlina",
    "cambria": "Caladria",
    "cambria math": "Caladria",
    "consolas": "Consolita",
    "sylfaen": "Sylfano",
    "franklin gothic medium": "Franklito",
    "ebrima": "Ebrisa",
    "courier new": "Courina",
    "georgia": "Georgina",
    # The only two whose open-source stand-in is metric-exact as published; the
    # rest above carry advances copied from the real family, so pointing these
    # at a same-looking substitute would be a downgrade.
    "times new roman": "Liberation Serif",
    "arial": "Liberation Sans",
    # Deliberately absent: MS Gothic. An English Windows does not ship it either
    # (it arrives with the Japanese language pack), so measuring as absent is
    # what a real machine does.
}


def _drop_unrenderable(fonts: Sequence[str], host: str) -> List[str]:
    """Keep only what this host can actually draw; a bundled stand-in exempts a
    family. Phrased as a whitelist because a replayed real device brings
    whatever fonts that machine had - an open set no hand-written exclusion list
    covers. An empty result would switch ``fonts.allow`` back to hiding nothing.
    """
    host_fonts = _HOST_FONTS.get(host, frozenset())
    kept = _renderable(fonts, host_fonts)
    return kept or _renderable(_WINDOWS_ALLOW_FONTS, host_fonts)


def _renderable(fonts: Sequence[str], host_fonts: FrozenSet[str]) -> List[str]:
    return [
        f
        for f in fonts
        if f.strip().lower() in _WINDOWS_FONT_ALIAS or f.strip().lower() in host_fonts
    ]


def _merge_fonts(base: Sequence[str], extra: Sequence[str]) -> List[str]:
    """Case-insensitive union, first spelling wins."""
    out = list(base)
    seen = {font.lower() for font in base}
    for font in extra:
        key = font.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(font)
    return out


def persona_to_fp_config(
    persona: Persona,
    *,
    label: str,
    timezone: str,
    public_ip: Optional[str] = None,
    rtt_ms: Optional[float] = None,
    canvas_noise: Optional[bool] = None,
    api_log: Optional[str] = None,
    api_log_path: Optional[str] = None,
    host_platform: Optional[str] = None,
) -> Dict[str, Any]:
    """Serialize a persona into the kernel's ``fp-config.json`` schema (version 1).

    ``timezone`` is passed separately because it follows the proxy exit node at
    launch time and must not be baked into the frozen persona. The three
    per-profile switches behave the same way: they are launch settings, not
    identity, and leaving them unset produces exactly the config this function
    produced before they existed.
    """
    android = persona.device_type == "android"
    # Android has no taskbar; the real avail size arrives via `captured` anyway.
    avail_h = persona.screen_h if android else persona.screen_h - _TASKBAR_HEIGHT
    if public_ip:
        # The kernel hands this IP to WebRTC so the ICE candidates match the
        # proxy exit instead of leaking the real local address.
        webrtc: Dict[str, Any] = {"mode": "passthrough", "publicIp": public_ip}
    else:
        webrtc = {"mode": "disable"}

    # Deterministic light/dark preference derived from the seed (~70% light).
    seed_sum = sum(ord(c) for c in persona.seed)
    color_scheme = "light" if seed_sum % 10 < 7 else "dark"

    # ``{}`` means unknown vendor: leave navigator.gpu alone.
    gpu_vendor, gpu_arch = webgpu_identity(persona.gpu_renderer)
    webgpu: Dict[str, Any] = (
        {"vendor": gpu_vendor, "architecture": gpu_arch} if gpu_vendor else {}
    )

    webgl: Dict[str, Any] = {
        "unmaskedVendor": persona.gpu_vendor,
        "unmaskedRenderer": persona.gpu_renderer,
    }
    # Android personas always arrive with a capture, so there is no synthesized
    # OpenGL ES surface to fall back on and none is invented here.
    if not android:
        webgl.update(windows_webgl_config(persona.gpu_vendor))
    webgl.update(captured_webgl_config(persona.captured_webgl))
    canvas: Dict[str, Any] = {"seed": persona.canvas_seed}
    # Written only when noise is explicitly off - the kernel already defaults it
    # on, so emitting "on" would make an unchanged profile look changed.
    if canvas_noise is False:
        webgl["mode"] = "off"
        canvas["mode"] = "off"
    mode = api_log or "off"

    nav_platform = "Linux armv81" if android else "Win32"
    max_touch_points = 5 if android else 0
    # Every UA-CH key must be listed: an omitted one falls back to the real
    # host, which is how a Windows persona used to leak the host OS. Two
    # naming traps: `platform` is "Windows" (not navigator.platform's "Win32")
    # and `architecture` is "x86" even on x64 - `bitness` carries the 64.
    if android:
        ua_data: Dict[str, Any] = {
            "platform": "Android",
            "platformVersion": "{0}.0.0".format(
                persona.android_os_major if persona.android_os_major is not None else 15
            ),
            # Empty is the real value here, not "unconfigured": mobile Chrome
            # sends empty Arch and Bitness hints. Kernels that treat empty as
            # unset fall back to the host and leak x86/64.
            "architecture": "",
            "bitness": "",
            "wow64": False,
            "model": persona.android_model or "",
            # Low entropy, sent on every navigation. A UA string that says
            # Android beside a false mobile bit is a one-line contradiction.
            "mobile": True,
        }
    else:
        ua_data = {
            "platform": "Windows",
            "platformVersion": "15.0.0",
            "architecture": "x86",
            "bitness": "64",
            "wow64": False,
            "model": "",
        }
    ui_font = "Roboto" if android else "Segoe UI"
    if android:
        generic_fonts: Dict[str, str] = {
            "standard": "Roboto",
            "serif": "Noto Serif",
            "sansSerif": "Roboto",
            "cursive": "Dancing Script",
            "fantasy": "Roboto",
            "monospace": "Droid Sans Mono,Noto Sans Mono",
            "math": "Noto Serif",
        }
    else:
        # Every family names a second, more widely installed choice. The
        # first wins wherever it exists; without the fallback a host missing it
        # drops the whole generic onto the fallback font, where it measures
        # exactly like a family nobody has - the contradiction being avoided.
        generic_fonts = {
            "standard": "Times New Roman,Georgia",
            "serif": "Times New Roman,Georgia",
            "sansSerif": "Arial,Verdana",
            "cursive": "Comic Sans MS,Trebuchet MS",
            "fantasy": "Impact,Arial Black",
            "monospace": "Consolas,Courier New",
            "math": "Cambria Math,Times New Roman,Georgia",
        }
    # Only when the host is not the OS the persona claims: on Windows those
    # families are the real thing, aliasing them would substitute a stand-in for
    # a font that is present, and nothing needs dropping.
    host = host_platform or sys.platform
    foreign_host = not android and host != "win32"
    if android:
        allow_fonts = list(_ANDROID_ALLOW_FONTS)
    elif foreign_host:
        allow_fonts = _drop_unrenderable(_WINDOWS_ALLOW_FONTS, host)
    else:
        allow_fonts = list(_WINDOWS_ALLOW_FONTS)
    fonts: Dict[str, Any] = {
        "uiFont": ui_font,
        "keepCjk": 0,
        "block": [],
        "allow": allow_fonts,
        "generic": generic_fonts,
    }
    if foreign_host:
        fonts["alias"] = dict(_WINDOWS_FONT_ALIAS)

    config: Dict[str, Any] = {
        "version": 1,
        "seed": persona.seed,
        "label": label,
        "timezone": timezone,
        "navigator": {
            "userAgent": persona.ua,
            "platform": nav_platform,
            "vendor": "Google Inc.",
            "language": persona.languages[0] if persona.languages else "en-US",
            "languages": list(persona.languages),
            "hardwareConcurrency": persona.hardware_concurrency,
            "deviceMemory": persona.device_memory,
            "maxTouchPoints": max_touch_points,
            "uaData": ua_data,
        },
        "screen": {
            "width": persona.screen_w,
            "height": persona.screen_h,
            "availWidth": persona.screen_w,
            "availHeight": avail_h,
            "colorDepth": 24,
            "pixelDepth": 24,
            "devicePixelRatio": persona.device_pixel_ratio,
        },
        "webgl": webgl,
        "webgpu": webgpu,
        "canvas": canvas,
        "audio": {"seed": persona.audio_seed},
        "domrect": {"seed": persona.domrect_seed},
        "webrtc": webrtc,
        "connection": derive_connection(persona.seed, rtt_ms, persona.captured),
        "prefersColorScheme": color_scheme,
        # ``generic`` maps the five CSS generic families plus 'standard' so
        # they resolve to a platform font instead of the host's own generic
        # settings. monospace and math list comma-separated fallbacks so a
        # host missing the first still lands on a non-host font.
        "fonts": fonts,
        "apilog": {"enabled": mode != "off", "mode": mode, "path": api_log_path or ""},
    }

    if android:
        # Only Android writes this key. A desktop profile that suddenly grew
        # one would read as changed to the full-sync diff.
        config["device"] = {
            "type": "android",
            "pointer": "coarse",
            "hover": "none",
            "viewport": "mobile",
            "orientation": "portrait-primary",
            "outerWidth": persona.screen_w,
            "outerHeight": persona.screen_h,
        }

    cap = persona.captured
    if cap is not None:
        nav = config["navigator"]
        cap_ua_data = nav["uaData"]
        screen = config["screen"]
        if cap.platform:
            nav["platform"] = cap.platform
        if cap.vendor:
            nav["vendor"] = cap.vendor
        if cap.max_touch_points is not None:
            nav["maxTouchPoints"] = cap.max_touch_points
        if cap.ua_platform:
            cap_ua_data["platform"] = cap.ua_platform
        if cap.ua_platform_version:
            cap_ua_data["platformVersion"] = cap.ua_platform_version
        # Presence, not truthiness: "" is what mobile Chrome actually sends.
        if cap.ua_architecture is not None:
            cap_ua_data["architecture"] = cap.ua_architecture
        if cap.ua_bitness is not None:
            cap_ua_data["bitness"] = cap.ua_bitness
        if cap.ua_model is not None:
            cap_ua_data["model"] = cap.ua_model
        if cap.ua_mobile is not None:
            cap_ua_data["mobile"] = cap.ua_mobile
        if cap.avail_w:
            screen["availWidth"] = cap.avail_w
        if cap.avail_h:
            screen["availHeight"] = cap.avail_h
        if cap.color_depth:
            screen["colorDepth"] = cap.color_depth
            screen["pixelDepth"] = cap.color_depth
        if cap.prefers_color_scheme:
            config["prefersColorScheme"] = cap.prefers_color_scheme
        connection = config["connection"]
        # effectiveType/rtt/downlink are deliberately absent here: overriding one
        # third of the trio is what produced '4g' beside rtt 400.
        # derive_connection owns all three.
        if cap.connection_type:
            connection["type"] = cap.connection_type
        if cap.connection_downlink_max is not None:
            connection["downlinkMax"] = cap.connection_downlink_max
        audio = config["audio"]
        if cap.audio_sample_rate:
            audio["sampleRate"] = cap.audio_sample_rate
        if cap.audio_max_channel_count:
            audio["maxChannelCount"] = cap.audio_max_channel_count
        if cap.fonts:
            # A phone reports the names its font config aliases (Arial,
            # Helvetica, Georgia), not the families behind them, so replaying
            # the capture alone drops Roboto and the Notos - and with them
            # sans-serif, serif and monospace, which then all collapse onto one
            # fallback width. A desktop capture names real files, so it
            # replaces outright.
            if android:
                config["fonts"]["allow"] = _merge_fonts(_ANDROID_ALLOW_FONTS, cap.fonts)
            elif foreign_host:
                config["fonts"]["allow"] = _drop_unrenderable(cap.fonts, host)
            else:
                config["fonts"]["allow"] = list(cap.fonts)
        if cap.webgl_extensions:
            config["webgl"]["extensions"] = {"allow": cap.webgl_extensions}

    return config


def read_persona(profile_dir: Path | str) -> Optional[Persona]:
    """The persisted persona, or None when this profile has no identity yet.

    Never writes: callers that must not decide the identity use this.
    """
    try:
        persona = Persona.from_dict(
            json.loads((Path(profile_dir) / PERSONA_FILE).read_text(encoding="utf-8"))
        )
    except (ValueError, TypeError, OSError):
        return None
    # Profiles created before kernels went major-only carry a full version
    # string. Normalizing in memory only: the file rides the cloud archive, and
    # an older client on another machine still needs to resolve what it wrote.
    if persona.kernel_version:
        persona.kernel_version = normalize_kernel_version(persona.kernel_version)
    return persona


def load_or_generate_persona(
    profile_dir: Path | str,
    default_kernel_version: str,
    rng: Optional[random.Random] = None,
    device_type: Optional[DeviceType] = None,
    device: Optional[Dict[str, Any]] = None,
) -> Persona:
    """Read ``persona.json`` from a profile, or create and persist a new one.

    An existing profile always keeps its own ``kernelVersion``; the default only
    applies to profiles created right now. A corrupted file is regenerated
    rather than raising, matching the Node SDK. ``device_type``/``device`` only
    matter for a brand-new profile - an existing one keeps whatever it froze.
    """
    directory = Path(profile_dir)
    path = directory / PERSONA_FILE
    fallback = normalize_kernel_version(default_kernel_version) or "149"
    if path.exists():
        try:
            persona = Persona.from_dict(json.loads(path.read_text(encoding="utf-8")))
            if not persona.kernel_version:
                # Backfill for profiles written before kernelVersion existed.
                persona.kernel_version = fallback
                write_persona(directory, persona)
            else:
                # In memory only -- see read_persona.
                persona.kernel_version = normalize_kernel_version(persona.kernel_version)
            return persona
        except (ValueError, TypeError, OSError):
            pass  # corrupted -> regenerate below

    persona = generate_persona(
        chrome_major_of(fallback),
        fallback,
        rng=rng,
        device_type=device_type,
        device=device,
    )
    write_persona(directory, persona)
    return persona


def with_kernel_version(persona: Persona, version: str) -> Persona:
    """The same identity on another Chrome major.

    Only these three fields follow the kernel version - every seed, the GPU, the
    screen and the captured facts are version-independent, and re-rolling them
    would hand the site a brand new device behind the same cookies.
    """
    kernel_version = normalize_kernel_version(version)
    chrome_major = chrome_major_of(kernel_version)
    moved = Persona.from_dict(persona.to_dict())
    moved.kernel_version = kernel_version
    moved.chrome_major = chrome_major
    moved.ua = re.sub(r"Chrome/\d+", "Chrome/{0}".format(chrome_major), moved.ua, count=1)
    return moved


def write_persona(profile_dir: Path | str, persona: Persona) -> Path:
    """Persist a persona to ``<profile>/persona.json``."""
    directory = Path(profile_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / PERSONA_FILE
    path.write_text(json.dumps(persona.to_dict(), indent=2), encoding="utf-8")
    return path


def write_fp_config(
    profile_dir: Path | str,
    persona: Persona,
    *,
    label: str,
    timezone: str,
    public_ip: Optional[str] = None,
    rtt_ms: Optional[float] = None,
    canvas_noise: Optional[bool] = None,
    api_log: Optional[str] = None,
) -> Path:
    """Write ``<profile>/fp-config.json`` and return its path."""
    directory = Path(profile_dir)
    directory.mkdir(parents=True, exist_ok=True)
    config = persona_to_fp_config(
        persona,
        label=label,
        timezone=timezone,
        public_ip=public_ip,
        rtt_ms=rtt_ms,
        canvas_noise=canvas_noise,
        api_log=api_log,
        # The kernel writes the log itself, so the path has to be one it can
        # reach - beside the profile, like the passkey store.
        api_log_path=str(directory / API_LOG_FILE) if api_log and api_log != "off" else None,
    )
    path = directory / FP_CONFIG_FILE
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return path
