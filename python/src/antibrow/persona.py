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
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

PERSONA_FILE = "persona.json"
FP_CONFIG_FILE = "fp-config.json"

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

    def to_dict(self) -> Dict[str, Any]:
        """camelCase dict, byte-compatible with the Node SDK's persona.json."""
        out = {json_key: getattr(self, attr) for attr, json_key in _JSON_KEYS}
        if self.captured_webgl:
            out["capturedWebgl"] = self.captured_webgl
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Persona":
        kwargs = {}
        for attr, json_key in _JSON_KEYS:
            if json_key in data:
                kwargs[attr] = data[json_key]
        captured = data.get("capturedWebgl")
        if isinstance(captured, dict):
            kwargs["captured_webgl"] = captured
        # Older profiles predate kernelVersion: load them with an empty
        # version so the caller can backfill it without touching the seeds.
        kwargs.setdefault("kernel_version", "")
        return cls(**kwargs)


def generate_persona(
    chrome_major: int,
    kernel_version: str,
    rng: Optional[random.Random] = None,
) -> Persona:
    """Roll a new self-consistent Win11 / Chrome persona.

    ``rng`` makes generation reproducible in tests; production calls use
    :mod:`secrets` for the seeds and :mod:`random` for the picks.
    """
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


def chrome_major_of(kernel_version: str) -> int:
    """``"150.0.7871.182"`` -> ``150``. Keeps the UA in step with the binary."""
    head = kernel_version.split(".")[0] if kernel_version else ""
    try:
        return int(head)
    except ValueError:
        raise ValueError("Malformed kernel version: {0!r}".format(kernel_version))


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


def derive_connection(seed: str, rtt_ms: Optional[float] = None) -> Dict[str, Any]:
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


def persona_to_fp_config(
    persona: Persona,
    *,
    label: str,
    timezone: str,
    public_ip: Optional[str] = None,
    rtt_ms: Optional[float] = None,
) -> Dict[str, Any]:
    """Serialize a persona into the kernel's ``fp-config.json`` schema (version 1).

    ``timezone`` is passed separately because it follows the proxy exit node at
    launch time and must not be baked into the frozen persona.
    """
    avail_h = persona.screen_h - _TASKBAR_HEIGHT
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

    return {
        "version": 1,
        "seed": persona.seed,
        "label": label,
        "timezone": timezone,
        "navigator": {
            "userAgent": persona.ua,
            "platform": "Win32",
            "vendor": "Google Inc.",
            "language": persona.languages[0] if persona.languages else "en-US",
            "languages": list(persona.languages),
            "hardwareConcurrency": persona.hardware_concurrency,
            "deviceMemory": persona.device_memory,
            "maxTouchPoints": 0,
            # Every UA-CH key must be listed: an omitted one falls back to the
            # real host, which is how a Windows persona used to leak the host OS.
            # Two naming traps: `platform` is "Windows" (not navigator.platform's
            # "Win32") and `architecture` is "x86" even on x64 - `bitness` has it.
            "uaData": {
                "platform": "Windows",
                "platformVersion": "15.0.0",
                "architecture": "x86",
                "bitness": "64",
                "wow64": False,
                "model": "",
            },
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
        "webgl": dict(
            {
                "unmaskedVendor": persona.gpu_vendor,
                "unmaskedRenderer": persona.gpu_renderer,
            },
            **captured_webgl_config(persona.captured_webgl),
        ),
        "webgpu": webgpu,
        "canvas": {"seed": persona.canvas_seed},
        "audio": {"seed": persona.audio_seed},
        "domrect": {"seed": persona.domrect_seed},
        "webrtc": webrtc,
        "connection": derive_connection(persona.seed, rtt_ms),
        "prefersColorScheme": color_scheme,
        # ``allow`` whitelists the probeable font set: left empty, every host font
        # stays enumerable. ``generic`` pins the CSS generic families to Windows
        # fonts, with comma-separated fallbacks so a host missing the first still
        # lands on a non-host font.
        "fonts": {
            "uiFont": "Segoe UI",
            "keepCjk": 0,
            "block": [],
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
            "generic": {
                "standard": "Times New Roman",
                "serif": "Times New Roman",
                "sansSerif": "Arial",
                "cursive": "Comic Sans MS",
                "fantasy": "Impact",
                "monospace": "Consolas,Courier New",
                "math": "Cambria Math,Times New Roman",
            },
        },
        "apilog": {"enabled": False, "mode": "off", "path": ""},
    }


def load_or_generate_persona(
    profile_dir: Path | str,
    default_kernel_version: str,
    rng: Optional[random.Random] = None,
) -> Persona:
    """Read ``persona.json`` from a profile, or create and persist a new one.

    An existing profile always keeps its own ``kernelVersion``; the default only
    applies to profiles created right now. A corrupted file is regenerated
    rather than raising, matching the Node SDK.
    """
    directory = Path(profile_dir)
    path = directory / PERSONA_FILE
    if path.exists():
        try:
            persona = Persona.from_dict(json.loads(path.read_text(encoding="utf-8")))
            if not persona.kernel_version:
                # Backfill for profiles written before kernelVersion existed.
                persona.kernel_version = default_kernel_version
                write_persona(directory, persona)
            return persona
        except (ValueError, TypeError, OSError):
            pass  # corrupted -> regenerate below

    persona = generate_persona(
        chrome_major_of(default_kernel_version), default_kernel_version, rng=rng
    )
    write_persona(directory, persona)
    return persona


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
) -> Path:
    """Write ``<profile>/fp-config.json`` and return its path."""
    directory = Path(profile_dir)
    directory.mkdir(parents=True, exist_ok=True)
    config = persona_to_fp_config(
        persona, label=label, timezone=timezone, public_ip=public_ip, rtt_ms=rtt_ms
    )
    path = directory / FP_CONFIG_FILE
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return path
