"""NKD Timeline - a video/audio coordinator.

This is not a "load video" node: it is the piece missing between the loaders and the
graph. Material comes in through the INPUTS (the stock Load Video / Load Audio, or
anything emitting VIDEO/AUDIO), gets laid out on a multi-track timeline, and the numbers
that matter -- fps, frame count, resolution, ranges -- come back out as REAL SOCKETS the
rest of the graph can be coordinated with.

The important reframing: **a gap in the timeline is a region to generate**. The `coverage`
output is 1 IN THE GAPS and 0 where there is material, so it is directly the conditioning
mask for temporal inpainting - white means "generate here", which is the convention core
uses (`VAEEncodeForInpaint` in nodes.py:436 wipes the pixels where the mask is 1).

All the heavy lifting is already in ComfyUI core: the native VIDEO type
(`comfy_api.latest.InputImpl.VideoFromFile`) provides `as_trimmed()` with lazy,
keyframe-seeking decoding, so no decoder is written here.
"""

from __future__ import annotations

import json
import math
import re
import os
from typing import Any, NamedTuple, Optional

import folder_paths
import numpy as np
import torch

import comfy.utils
from comfy_api.latest import InputImpl, io, ui

# ── Frame-count quantisation ──────────────────────────────────────────────────
# Video models only accept certain frame counts. Getting this wrong looks fine while
# editing and blows up in the sampler twenty minutes later, so the timeline snaps to the
# grid and draws the valid stops on its ruler.
#
# Each preset is (step, offset): a valid count is `offset + step*k`. Values taken from the
# EmptyLatent nodes in ComfyUI core, which are the authority:
#   Each preset's (step, offset) is read off the matching EmptyLatent node in ComfyUI
#   core. MiniMax H3 is the exception to the Nn+1 shape and also the only one that
#   rounds UP. Verify against the core before adding or changing one.
QUANTIZE_FREE = "free"
QUANTIZE_CUSTOM = "custom (multiple of N)"
# Split per MODEL rather than per grid, even where the grid is shared: Wan and Hunyuan
# both want 4n+1 but were trained at different frame rates, so one grouped entry could not
# carry an honest expected fps.
QUANTIZE_PRESETS: dict[str, tuple[int, int]] = {
    "Wan (4n+1)": (4, 1),
    "Hunyuan (4n+1)": (4, 1),
    "LTX (8n+1)": (8, 1),
    "Cosmos (8n+1)": (8, 1),
    "Mochi (6n+1)": (6, 1),
    "MiniMax H3 (17n+5)": (17, 5),
}

# Frame rate each family was trained at, ONLY where ComfyUI core states it outright:
#   Only the rates ComfyUI core states outright. A family the repo does not document
#   stays out: a confident warning built on a guess is worse than no warning.
# Hunyuan, Cosmos and Mochi are absent on purpose: no rate is documented in the repo, and
# guessing one would produce a confident warning that might simply be wrong.
QUANTIZE_NATIVE_FPS: dict[str, float] = {
    "Wan (4n+1)": 16.0,
    "LTX (8n+1)": 25.0,
    "MiniMax H3 (17n+5)": 24.0,
}
QUANTIZE_MODES = [QUANTIZE_FREE, *QUANTIZE_PRESETS, QUANTIZE_CUSTOM]


def quantize_grid(mode: str, k: int = 8) -> Optional[tuple[int, int]]:
    """(step, offset) for a mode, or None when no snapping applies."""
    if mode == QUANTIZE_CUSTOM:
        return (max(1, int(k)), 0)
    return QUANTIZE_PRESETS.get(mode)


def first_stop(step: int, offset: int) -> int:
    """Smallest useful valid count.

    `offset` itself is arithmetically valid but for the Nn+1 families that means a
    single frame, which is never what someone dragging a timeline meant. So the floor is
    one full group up unless the offset already lands somewhere sensible: 4n+1 -> 5,
    8n+1 -> 9, 6n+1 -> 7, 17n+5 -> 5, multiple of N -> N.
    """
    return offset if offset > 1 else offset + step


# ── Output resolution from an aspect ratio ────────────────────────────────────
# Same table and same formula as NKD Klein Presampling (`helpers.py`), so a ratio picked
# here lands on exactly the numbers that pack already produces. `Custom` means "use the
# width/height widgets", which is the behaviour this node always had and stays the default.
ASPECT_CUSTOM = "Custom"
# Keep the material's own shape and only rescale it to the megapixel budget. Klein calls
# this "As Reference" because there it follows a reference IMAGE; here the reference is the
# first clip on the timeline, so the name says source.
ASPECT_SOURCE = "As Source"
ASPECT_RATIOS: dict[str, Optional[tuple[int, int]]] = {
    ASPECT_CUSTOM:      None,
    ASPECT_SOURCE:      None,
    "1:1":              (1, 1),
    "2:3 Vertical":     (2, 3),
    "3:4 Vertical":     (3, 4),
    "3:5 Vertical":     (3, 5),
    "4:5 Vertical":     (4, 5),
    "5:7 Vertical":     (5, 7),
    "5:8 Vertical":     (5, 8),
    "7:9 Vertical":     (7, 9),
    "9:16 Vertical":    (9, 16),
    "9:19 Vertical":    (9, 19),
    "9:21 Vertical":    (9, 21),
    "9:32 Vertical":    (9, 32),
    "3:2 Horizontal":   (3, 2),
    "4:3 Horizontal":   (4, 3),
    "5:3 Horizontal":   (5, 3),
    "5:4 Horizontal":   (5, 4),
    "7:5 Horizontal":   (7, 5),
    "8:5 Horizontal":   (8, 5),
    "9:7 Horizontal":   (9, 7),
    "16:9 Horizontal":  (16, 9),
    "19:9 Horizontal":  (19, 9),
    "21:9 Horizontal":  (21, 9),
    "32:9 Horizontal":  (32, 9),
}
ASPECT_MODES = list(ASPECT_RATIOS)


def scale_to_megapixels(width: int, height: int, target_pixels: float,
                        multiple: int) -> tuple[int, int]:
    """Scale (w,h) to about `target_pixels` keeping the aspect, aligned to `multiple`.

    Ported from `_scale_to_megapixels` in NKD Klein Tools. Rounding each axis on its own
    drifts the aspect by up to ~0.6% on awkward shapes, because the floor/ceil decisions are
    taken in isolation; evaluating the four aligned candidates together and picking the one
    closest in RATIO keeps it under ~0.15%. On a timeline that drift is a slow squash of the
    picture nobody attributes to the resolution widget.
    """
    m = max(1, int(multiple))
    if width <= 0 or height <= 0:
        return m, m
    aspect = width / height
    h_ideal = (target_pixels / aspect) ** 0.5
    w_ideal = h_ideal * aspect

    def snap(v: float, up: bool) -> int:
        n = int(v / m) + (1 if up else 0)
        return max(1, n) * m

    best = None
    for w_up in (False, True):
        for h_up in (False, True):
            cw, ch = snap(w_ideal, w_up), snap(h_ideal, h_up)
            cand = (abs(cw / ch - aspect) / aspect,
                    abs(cw * ch - target_pixels) / max(1.0, target_pixels), cw, ch)
            if best is None or cand < best:
                best = cand
    return best[2], best[3]


def resolve_resolution(aspect: str, megapixels: float, width: int, height: int,
                       multiple: int, src_w: int = 0, src_h: int = 0) -> tuple[int, int]:
    """(width, height) for the chosen ratio, or the widgets when it is `Custom`.

    `As Source` needs the first clip's dimensions, so it is resolved LATE - after the
    sources are known - unlike the fixed ratios, which the editor can work out on its own.

    `multiple` is not cosmetic: a video model's canvas has its own grid (MiniMax H3 rounds
    to 32, `nodes_minimax_h3.py:adapt_canvas`), and landing off it means the model resizes
    every frame again through `common_upscale`'s per-frame loop. Matching the grid here is
    what avoids paying for that resize twice.
    """
    mp0 = float(megapixels) if megapixels and float(megapixels) > 0 else 1.0
    if aspect == ASPECT_SOURCE:
        if src_w > 0 and src_h > 0:
            return scale_to_megapixels(src_w, src_h, mp0 * 1_048_576, multiple)
        return int(width), int(height)      # nothing to take a shape from yet
    parts = ASPECT_RATIOS.get(aspect)
    if parts is None:
        return int(width), int(height)
    m = max(1, int(multiple))
    up = lambda v: max(m, (int(v) + m - 1) // m * m)  # noqa: E731 - ceil to the grid
    mp = float(megapixels) if megapixels and float(megapixels) > 0 else 1.0
    target = mp * 1_048_576
    w_parts, h_parts = parts
    return (up(math.sqrt(target * w_parts / h_parts)),
            up(math.sqrt(target * h_parts / w_parts)))


# Which way a family rounds an invalid count, taken from what the core actually
# produces rather than from the formula's look:
#   Nn+1 families size the latent as `((length - 1) // step) + 1` (nodes_wan.py:44,
#   nodes_lt.py, nodes_mochi.py) -- a FLOOR, so asking for 20 decodes back to 17.
#   MiniMax H3 is the odd one: `align_frame_count` walks UP until `n % 17 == 5`
#   (nodes_minimax_h3.py:34), so asking for 20 gives 22.
# Rounding the wrong way is silent: down where the model goes up throws material
# away, and a timeline asked for 17 rendered 5.
QUANTIZE_ROUND_UP = {"MiniMax H3 (17n+5)"}


def quantize_count(n: int, mode: str, k: int = 8) -> int:
    """Round a frame count to the nearest valid stop, the way THIS model rounds."""
    n = max(0, int(n))
    grid = quantize_grid(mode, k)
    if grid is None or n == 0:
        return n
    step, offset = grid
    low = first_stop(step, offset)
    if n <= low:
        return low
    if mode in QUANTIZE_ROUND_UP:
        return offset + ((n - offset + step - 1) // step) * step
    return offset + ((n - offset) // step) * step


def quantize_stops(max_n: int, mode: str, k: int = 8) -> list[int]:
    """Every valid stop within [0, max_n] - what the editor paints on the ruler."""
    grid = quantize_grid(mode, k)
    if grid is None or max_n <= 0:
        return []
    step, offset = grid
    return list(range(first_stop(step, offset), max_n + 1, step))


# ── Defensive reading of the editor's JSON ────────────────────────────────────

def _int(v: Any, default: int = 0) -> int:
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _float(v: Any, default: float = 0.0) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _parse_clips(raw_list: Any) -> list[dict]:
    out = []
    for c in raw_list or []:
        if not isinstance(c, dict) or not c.get("src"):
            continue
        length = _int(c.get("length"))
        if length <= 0:
            continue
        # Freeze-frame markers: offsets from `start`, in timeline frames. Anchored to the
        # clip so they ride along when it moves; out-of-range ones are dropped rather than
        # clamped, which would silently pile several markers onto the same frame.
        markers = sorted({m for m in (_int(v, -1) for v in c.get("markers") or [])
                          if 0 <= m < length})
        out.append({
            "src": str(c["src"]),
            "track": _int(c.get("track")),
            "start": max(0, _int(c.get("start"))),
            "trimIn": max(0, _int(c.get("trimIn"))),
            "length": length,
            "muted": bool(c.get("muted")),
            "audioOnly": bool(c.get("audioOnly")),
            "markers": markers,
            **_fade_fields(c, length),
        })
    out.sort(key=lambda c: (c["track"], c["start"]))
    return out


MAX_GAIN = 2.0


def _fade_fields(raw: dict, length: int) -> dict:
    """`gain`/`fadeIn`/`fadeOut` off one clip's JSON, clamped inside the clip.

    Mirrors `fadeFields` + `clampFades` in `src/timeline/model.ts`. The two ramps are
    scaled together when they would overlap, so the shape the editor drew survives a clip
    that has since been shortened.
    """
    gain = max(0.0, min(MAX_GAIN, _float(raw.get("gain"), 1.0)))
    fi = max(0, _int(raw.get("fadeIn")))
    fo = max(0, _int(raw.get("fadeOut")))
    # NOT clamped to `length` one at a time first: doing that flattens a 3:1 shape to 1:1
    # before the joint scale ever sees it. Scaling both by the same factor is what keeps
    # the ramp the user drew recognisable after the clip is shortened.
    if fi + fo > length:
        k = length / (fi + fo) if fi + fo else 0
        fi, fo = int(fi * k), int(fo * k)
    return {"gain": gain, "fadeIn": fi, "fadeOut": fo}


def parse_timeline(raw: Any) -> dict:
    """Never raises. Corrupt JSON degrades to an empty timeline rather than taking the
    whole workflow run down with it."""
    out = {"clips": [], "masks": [], "audio": [], "tracks": [], "playhead": 0}
    if isinstance(raw, dict):
        data = raw
    else:
        if not raw or not isinstance(raw, str):
            return out
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return out
    if not isinstance(data, dict):
        return out

    # Higher tracks sit on top; write order decides who covers whom.
    tracks = data.get("tracks")
    if isinstance(tracks, list):
        out["tracks"] = [{"blend": t.get("blend", "normal")}
                         if isinstance(t, dict) else {"blend": "normal"}
                         for t in tracks]
    out["clips"] = _parse_clips(data.get("clips"))
    # The mask lane. A mask clip may point at ANY slot - a real MASK, an IMAGE batch or
    # even a video - and whatever it points at is read as a mask (luminance).
    out["masks"] = _parse_clips(data.get("masks"))
    for a in data.get("audio") or []:
        if not isinstance(a, dict) or not a.get("src"):
            continue
        length = _int(a.get("length"))
        if length <= 0:
            continue
        out["audio"].append({
            "src": str(a["src"]),
            "start": max(0, _int(a.get("start"))),
            "trimIn": max(0, _int(a.get("trimIn"))),
            "length": length,
            "muted": bool(a.get("muted")),
            "markers": sorted({m for m in (_int(v, -1) for v in a.get("markers") or [])
                               if 0 <= m < length}),
            **_fade_fields(a, length),
        })

    ui_state = data.get("ui")
    if isinstance(ui_state, dict):
        out["playhead"] = max(0, _int(ui_state.get("playhead")))
    return out


def marker_indices(lanes: list[list[dict]], start_frame: int, count: int) -> list[int]:
    """Every freeze-frame marker as an index INTO THE RENDERED BATCH.

    Not as an absolute timeline frame: `images` starts at `start_frame` and its length is
    quantised, so a marker at timeline frame 300 of a range starting at 200 is index 100 of
    the batch. Emitting absolute frames would make NKD Freeze Frames read the wrong picture
    - the same trap `duration` avoids by counting off the quantised length.

    Markers outside the rendered range are dropped: they exist on the timeline but there is
    no frame to freeze.
    """
    out = {c["start"] + m - start_frame
           for lane in lanes for c in lane for m in c.get("markers") or ()}
    return sorted(i for i in out if 0 <= i < count)


def clip_bound_indices(clips: list[dict], start_frame: int, count: int) -> list[int]:
    """First and last frame of every picture clip, as indices into the rendered batch.

    Ordered clip by clip - (start, track), the reading order of the editor - and NOT
    deduplicated: `clip 1 out` and `clip 2 in` are different sockets on Freeze Frames
    even when two stacked clips share a frame. `audioOnly` clips are skipped: their
    picture is a hole, so there is no frame to freeze.

    Same range rule as `marker_indices`: a bound outside the rendered window is dropped,
    not clamped - clamping would freeze a frame the clip does not actually show.
    """
    out = []
    for c in sorted(clips, key=lambda c: (c["start"], c.get("track", 0))):
        if c.get("audioOnly"):
            continue
        for f in (c["start"], c["start"] + c["length"] - 1):
            i = f - start_frame
            if 0 <= i < count:
                out.append(i)
    return out


def timeline_span(*lanes: list[dict]) -> int:
    """Last frame occupied by any lane."""
    ends = [c["start"] + c["length"] for lane in lanes for c in lane]
    return max(ends) if ends else 0


def muted_rows(lanes: list[list[dict]], start_frame: int, count: int) -> torch.Tensor:
    """One value per rendered frame: 1.0 where at least one MUTED clip covers it.

    The mute toggle is the user saying "this stretch of sound goes away" — which for a
    regeneration workflow is exactly "generate new sound here". Union across clips: an
    unmuted clip overlapping a muted one still sounds, but silencing was an explicit
    gesture and the mask reports the gesture, not the resulting mix.
    """
    rows = torch.zeros(count, dtype=torch.float32)
    end = start_frame + count
    for lane in lanes:
        for c in lane:
            if not c.get("muted"):
                continue
            a = max(c["start"], start_frame) - start_frame
            b = min(c["start"] + c["length"], end) - start_frame
            if b > a:
                rows[a:b] = 1.0
    return rows


def rows_to_ranges(rows: torch.Tensor, fps: float) -> str:
    """Per-frame rows -> "in,out" second pairs, e.g. "0.292,0.833,1.500,2.000".

    The exact syntax MVEx Audio Mask To Latent's `time_ranges` input parses (an even
    count of comma-separated seconds, out strictly after in). Relative to the RENDERED
    window, like `marker_indices`: the audio output starts at start_frame, so absolute
    timeline seconds would mask the wrong stretch of it.
    """
    pairs, start = [], None
    for i, v in enumerate(rows.tolist() + [0.0]):
        if v > 0 and start is None:
            start = i
        elif v <= 0 and start is not None:
            pairs.append(f"{start / fps:.3f},{i / fps:.3f}")
            start = None
    return ",".join(pairs)


def source_frame(clip: dict, f: int, src_fps: float, fps: float) -> int:
    """Source frame corresponding to timeline frame `f`.

    When the frame rates differ this IS the resampling: 30 -> 24 drops frames, 24 -> 30
    repeats them. It is the easiest thing in this node to get subtly wrong, which is why
    it is isolated and tested.
    """
    if fps <= 0:
        return clip["trimIn"]
    return clip["trimIn"] + int(round((f - clip["start"]) * (src_fps / fps)))


# ── Track blending ────────────────────────────────────────────────────────────
# Stacking two versions of a shot and reading the difference is a big part of why this node
# has tracks at all. These four are the ones a browser canvas can do natively, so the
# editor's preview shows the real composite and not an approximation of it.

BLEND_MODES = ["normal", "screen", "multiply", "difference"]


def blend_pixels(base: torch.Tensor, top: torch.Tensor, mode: str) -> torch.Tensor:
    """Composite `top` over `base`, both [.., C] in 0..1."""
    if mode == "screen":
        return 1.0 - (1.0 - base) * (1.0 - top)
    if mode == "multiply":
        return base * top
    if mode == "difference":
        return (base - top).abs()
    return top


def track_blend(tracks: list[dict], track: int) -> str:
    if 0 <= track < len(tracks):
        mode = tracks[track].get("blend")
        if mode in BLEND_MODES:
            return mode
    return "normal"


# ── One view over VIDEO / IMAGE / MASK sources ────────────────────────────────
# An IMAGE input is literally a frame sequence and a MASK is a batch of them, so both sit
# on the timeline exactly like a video. The only real difference is that a tensor batch has
# no intrinsic frame rate: it runs at the timeline rate, one element per timeline frame.

def classify(obj: Any) -> Optional[str]:
    """What kind of media is this? "video" | "image" | "mask" | "audio", or None.

    Every input arrives through ONE multi-type socket, so the kind is recovered from the
    object itself rather than from which group it was wired into. The four are trivially
    distinguishable and never ambiguous:
      AUDIO  a dict carrying a waveform
      VIDEO  a VideoInput (duck-typed on get_frame_rate, so any implementation counts)
      IMAGE  a [N,H,W,C] tensor
      MASK   a [N,H,W] tensor
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return "audio" if "waveform" in obj else None
    if torch.is_tensor(obj):
        if obj.ndim == 4:
            return "image"
        if obj.ndim == 3:
            return "mask"
        return None
    if hasattr(obj, "get_frame_rate") and hasattr(obj, "get_components"):
        return "video"
    return None


def build_sources(media: dict) -> tuple[dict[str, tuple[str, Any]], dict[str, dict]]:
    """(picture sources, audio sources) keyed by slot name.

    Audio is split out because it feeds the mixer rather than the picture pipeline.
    """
    visual: dict[str, tuple[str, Any]] = {}
    audio: dict[str, dict] = {}
    for name, obj in (media or {}).items():
        kind = classify(obj)
        if kind == "audio":
            audio[name] = obj
        elif kind is not None:
            visual[name] = (kind, obj)
    return visual, audio


def source_meta(kind: str, obj: Any, fps: float) -> tuple[float, int]:
    """(native fps, frame count) for any source kind."""
    if kind == "video":
        return float(obj.get_frame_rate()) or fps, int(obj.get_frame_count())
    return fps, int(obj.shape[0])


def _to_rgb(t: torch.Tensor) -> torch.Tensor:
    """Anything -> [N,H,W,3]. A mask becomes the grey image it looks like."""
    if t.ndim == 3:                      # [N,H,W] mask
        return t.unsqueeze(-1).repeat(1, 1, 1, 3)
    if t.shape[-1] == 1:
        return t.repeat(1, 1, 1, 3)
    return t[..., :3]


def _to_mask(t: torch.Tensor) -> torch.Tensor:
    """Anything -> [N,H,W]. Colour is read as luminance, which is what makes "use this
    video as a mask" work without a separate conversion node."""
    if t.ndim == 3:
        return t
    if t.shape[-1] == 1:
        return t[..., 0]
    # Rec.709 luma - the same weighting every mask-from-image node in the ecosystem uses.
    return (t[..., 0] * 0.2126 + t[..., 1] * 0.7152 + t[..., 2] * 0.0722)


def gather_window(kind: str, obj: Any, clip: dict, a: int, b: int,
                  fps: float) -> tuple[Optional[torch.Tensor], Optional[dict]]:
    """Frames covering timeline range [a, b), plus this clip's audio when it has any.

    For video this is ONE lazy, keyframe-seeking decode of just the window needed, then a
    gather by index. For tensor sources it is only the gather.
    """
    src_fps, total = source_meta(kind, obj, fps)
    if total <= 0 or b <= a:
        return None, None

    s0 = source_frame(clip, a, src_fps, fps)
    s1 = source_frame(clip, b - 1, src_fps, fps)
    lo, hi = min(s0, s1), max(s0, s1)
    audio = None

    if kind == "video":
        window = obj.as_trimmed(max(0, lo) / src_fps, (hi - lo + 1) / src_fps,
                                strict_duration=False)
        comps = (window or obj).get_components()
        frames = comps.images
        audio = comps.audio
    else:
        lo = max(0, min(lo, total - 1))
        hi = max(lo, min(hi, total - 1))
        frames = obj[lo:hi + 1]

    if frames is None or frames.shape[0] == 0:
        return None, None
    have = frames.shape[0]
    picks = [min(max(source_frame(clip, f, src_fps, fps) - lo, 0), have - 1)
             for f in range(a, b)]
    # Same cadence and no repeats is the ordinary case, and there the gather is the
    # identity: a slice is a VIEW, while index_select copies the whole decoded window -
    # 7.5 GiB and 2s for 81 frames of 4K. Only fall back to the gather when frames really
    # are being dropped or repeated.
    if picks == list(range(picks[0], picks[0] + len(picks))):
        return frames[picks[0]:picks[-1] + 1], audio
    return frames.index_select(0, torch.tensor(picks, dtype=torch.long)), audio


def _queue_clip_audio(segments: list, clip: dict, kind: str, obj: Any, a: int, b: int,
                      fps: float, audio: dict, start_frame: int) -> int:
    """Place a video clip's own sound on the mix, and report its sample rate.

    Shared by the ordinary path and the audio-only one, so a clip whose picture has been
    turned off still contributes exactly the same audio it did before.
    """
    wave = audio["waveform"]
    sr = int(audio["sample_rate"])
    src_fps = source_meta(kind, obj, fps)[0]
    s0 = source_frame(clip, a, src_fps, fps)
    s1 = source_frame(clip, b - 1, src_fps, fps)
    # The decoded window starts at min(s0,s1); the offset to `a` is the trim.
    trim = int(round((s0 - min(s0, s1)) / src_fps * sr))
    # `1.0` used to be hardcoded here, which is why a video clip's level and fades did
    # nothing however the editor was set: the sound was always mixed flat.
    segments.append((wave[0], sr, int(round((a - start_frame) / fps * sr)), trim,
                     audio_env(clip, a, fps, sr)))
    return sr


def audio_env(clip: dict, a: int, fps: float, sr: int) -> AudioEnv:
    """A clip's level envelope, converted from timeline frames to output samples.

    `a` is the first frame of the clip that the render window actually covers, so
    `a - clip["start"]` is how much of the clip (and of its fade-in) was already cut away.
    """
    per = sr / max(1e-6, fps)
    return AudioEnv(
        gain=float(clip.get("gain", 1.0)),
        fade_in=int(round(max(0, clip.get("fadeIn", 0)) * per)),
        fade_out=int(round(max(0, clip.get("fadeOut", 0)) * per)),
        length=int(round(clip["length"] * per)),
        head=int(round(max(0, a - clip["start"]) * per)),
    )


# ── Resolution fitting ────────────────────────────────────────────────────────

def _resize(chw: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Resize [N,C,H,W], picking the filter by direction.

    NOT `comfy.utils.common_upscale(..., "lanczos")` on the way down. That helper's lanczos
    is not a tensor op at all: it loops in PYTHON converting every frame to a PIL image and
    back. On a timeline that is per-frame work over a whole clip, and on a big source it
    can cost more than decoding the video did - which is why the filter is picked by
    direction here rather than left at one setting.

    Downscaling is what a timeline actually does (a camera source into a model-sized
    output), and antialiased bicubic is both faster than that loop and visually equal to
    it. Plain bilinear WITHOUT antialias is not the alternative: on a large reduction it
    aliases badly and is not even faster than area.

    Upscaling keeps lanczos: there is no aliasing to fight, it is the sharper filter, and
    at output sizes it is the faster of the two anyway.
    """
    src_h, src_w = chw.shape[-2], chw.shape[-1]
    if width * 2 <= src_w and height * 2 <= src_h:
        # Halved or more - a camera source landing on a model-sized output. Averaging every
        # source pixel that falls in the target one IS the right filter here (it is
        # supersampling), it cannot ring the way bicubic and lanczos do, and it is another
        # 3x faster again: 1.9s where antialiased bicubic takes 4.9s.
        return torch.nn.functional.interpolate(chw, size=(height, width), mode="area")
    if width * height < src_w * src_h:
        # Mild reduction: too few source pixels per target one for averaging to look good,
        # so bicubic - WITH antialias, or it aliases. It can overshoot, and every caller
        # clamps; so did lanczos.
        return torch.nn.functional.interpolate(
            chw, size=(height, width), mode="bicubic", antialias=True, align_corners=False)
    return comfy.utils.common_upscale(chw, width, height, "lanczos", "disabled")


def fit_frames(t: torch.Tensor, width: int, height: int, mode: str) -> torch.Tensor:
    """`t` is [N,H,W,C] (or [N,H,W] for a mask) in 0..1. Returns the same rank, resized.

    The editor's preview mirrors these three modes exactly, so what you scrub is what
    gets rendered.
    """
    if t.shape[1] == height and t.shape[2] == width:
        return t                     # BEFORE the mask branch: a mask that already fits
                                     # must not pay for a 3x channel copy to learn that.
    if t.ndim == 3:
        # Mask: fit it as a THREE-channel image and take one channel back. Not as a
        # single-channel one - `comfy.utils.lanczos` deliberately squeezes grayscale
        # (utils.py:1062, "the below API is strict"), so a [N,H,W,1] tensor returns rank 3
        # and every shape downstream breaks. The RGB path is the well-trodden one and the
        # extra channels cost nothing measurable at mask sizes.
        return fit_frames(t.unsqueeze(-1).repeat(1, 1, 1, 3), width, height, mode)[..., 0]
    chw = t.movedim(-1, 1)  # the resizers want [N,C,H,W]
    if mode == "cover":
        # Crop to the output aspect first, then resize once. Going through
        # common_upscale's "center" crop would put the whole thing back on the lanczos
        # path for the resize itself.
        src_h, src_w = chw.shape[-2], chw.shape[-1]
        keep_w = min(src_w, int(round(src_h * width / height)))
        keep_h = min(src_h, int(round(src_w * height / width)))
        x, y = (src_w - keep_w) // 2, (src_h - keep_h) // 2
        out = _resize(chw[:, :, y:y + keep_h, x:x + keep_w], width, height)
    elif mode == "stretch":
        out = _resize(chw, width, height)
    else:  # contain - scale to fit whole, pad the remainder with black
        src_h, src_w = chw.shape[-2], chw.shape[-1]
        scale = min(width / src_w, height / src_h)
        inner_w = max(1, int(round(src_w * scale)))
        inner_h = max(1, int(round(src_h * scale)))
        inner = _resize(chw, inner_w, inner_h)
        out = torch.zeros((chw.shape[0], chw.shape[1], height, width), dtype=chw.dtype)
        y = (height - inner_h) // 2
        x = (width - inner_w) // 2
        out[:, :, y:y + inner_h, x:x + inner_w] = inner
    return out.movedim(1, -1).clamp(0.0, 1.0)


# ── Audio ─────────────────────────────────────────────────────────────────────

def _resample(wave: torch.Tensor, src_sr: int, dst_sr: int) -> torch.Tensor:
    """ponytail: linear resampling via `interpolate` instead of pulling in torchaudio.
    No new dependency and good enough for mixing reference tracks. If master-grade quality
    is ever needed, a polyphase resampler goes here."""
    if src_sr == dst_sr or wave.shape[-1] == 0:
        return wave
    n = max(1, int(round(wave.shape[-1] * dst_sr / src_sr)))
    return torch.nn.functional.interpolate(wave, size=n, mode="linear", align_corners=False)


def _as_2ch(wave: torch.Tensor) -> torch.Tensor:
    """[C,T] -> [2,T]. Mono is duplicated, multichannel is cut to the first two."""
    if wave.shape[0] == 1:
        return wave.repeat(2, 1)
    return wave[:2] if wave.shape[0] > 2 else wave


class AudioEnv(NamedTuple):
    """One clip's level over time, in SAMPLES of the output rate.

    `head` is the trap this type exists to make impossible to forget: a clip may start
    before the rendered window, in which case `a = max(clip.start, start_frame)` chops its
    beginning off. The ramp is anchored to the CLIP, not to the window, so the samples that
    survive begin `head` into the fade - without it a clip whose head falls outside the
    render would fade in again at the window's edge, which is a dip in the middle of a
    stretch the user never touched.
    """
    gain: float = 1.0
    fade_in: int = 0
    fade_out: int = 0
    #: Clip length. 0 disables the ramps entirely (nothing to measure the tail against).
    length: int = 0
    head: int = 0


def clip_gain_ramp(env: AudioEnv, n: int) -> torch.Tensor | float:
    """Per-sample level for `n` samples starting `env.head` into the clip.

    Returns the plain float when there is no ramp, so the common case stays a scalar
    multiply. MIRRORS `gainAt` in `src/timeline/model.ts`: same linear shape, same
    `offset/fade_in` and `(length-offset)/fade_out` factors, so what the editor draws, what
    the preview plays and what lands in the file are the same curve.
    """
    if env.length <= 0 or (env.fade_in <= 0 and env.fade_out <= 0) or n <= 0:
        return env.gain
    idx = torch.arange(n, dtype=torch.float32) + env.head
    k = torch.ones(n, dtype=torch.float32)
    if env.fade_in > 0:
        k = torch.minimum(k, (idx / env.fade_in).clamp(0.0, 1.0))
    if env.fade_out > 0:
        k = torch.minimum(k, ((env.length - idx) / env.fade_out).clamp(0.0, 1.0))
    return k * env.gain


def mix_audio(segments: list[tuple[torch.Tensor, int, int, int, Any]],
              total_samples: int, sample_rate: int) -> torch.Tensor:
    """Additive mix into a [1,2,total_samples] buffer.

    Each segment is (waveform[C,T], source_sample_rate, offset_samples, trim_samples,
    level), where `level` is an `AudioEnv` or a plain float for a flat clip.
    """
    buf = torch.zeros((2, max(0, total_samples)), dtype=torch.float32)
    if total_samples <= 0:
        return buf.unsqueeze(0)
    for wave, sr, offset, trim, level in segments:
        if wave is None or wave.numel() == 0:
            continue
        w = _resample(_as_2ch(wave.to(torch.float32)).unsqueeze(0), sr, sample_rate)[0]
        if trim > 0:
            w = w[:, trim:]
        if w.shape[-1] == 0:
            continue
        dst_a = max(0, offset)
        src_a = max(0, -offset)
        n = min(w.shape[-1] - src_a, total_samples - dst_a)
        env = level if isinstance(level, AudioEnv) else AudioEnv(gain=float(level))
        # `src_a` samples were dropped off the front by the window, so they are also
        # consumed from the ramp.
        head = env.head + src_a
        # The CLIP's length, not the source's. Nothing here used to enforce it, so an
        # audio clip trimmed shorter than the file behind it kept playing to the end of
        # the timeline - the tail trim was silently ignored for sound. `length == 0` means
        # a caller that passed a bare float and has no clip to measure against.
        if env.length > 0:
            n = min(n, env.length - head)
        if n <= 0:
            continue
        gain = clip_gain_ramp(env._replace(head=head), n)
        buf[:, dst_a:dst_a + n] += w[:, src_a:src_a + n] * gain
    return buf.clamp(-1.0, 1.0).unsqueeze(0)


# ── Probe route ───────────────────────────────────────────────────────────────
# The frontend needs the EXACT frame count and fps before anything runs, and the browser's
# <video> element does not report them reliably. Path resolution is as strict as core's
# /view: absolute client-supplied paths are never honoured.

_probe_cache: dict[str, tuple[float, dict]] = {}


def _resolve_input_path(filename: str, type_: str, subfolder: str) -> Optional[str]:
    base = folder_paths.get_directory_by_type(type_ or "input")
    if not base:
        return None
    if subfolder:
        base = os.path.join(base, subfolder)
    path = os.path.abspath(os.path.join(base, os.path.basename(filename)))
    root = os.path.abspath(folder_paths.get_directory_by_type(type_ or "input"))
    try:
        # commonpath raises when the paths sit on different drives - that is a reject.
        if os.path.commonpath([path, root]) != root:
            return None
    except ValueError:
        return None
    return path if os.path.isfile(path) else None


def probe_media(path: str) -> dict:
    """Exact fps / frame count / duration / size, cached by mtime."""
    mtime = os.path.getmtime(path)
    hit = _probe_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    video = InputImpl.VideoFromFile(path)
    width, height = video.get_dimensions()
    info = {
        "fps": float(video.get_frame_rate()),
        "frame_count": int(video.get_frame_count()),
        "duration": float(video.get_duration()),
        "width": int(width),
        "height": int(height),
    }
    _probe_cache[path] = (mtime, info)
    return info


def _register_routes() -> None:
    # try/except as in Basic-Tools/nkd_spline_preview.py: aiohttp refuses duplicate
    # registrations, and the tests run with no server at all.
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.get("/nkd/timeline/probe")
        async def _probe(request):  # noqa: ANN001
            q = request.rel_url.query
            path = _resolve_input_path(q.get("filename", ""), q.get("type", "input"),
                                       q.get("subfolder", ""))
            if not path:
                return web.json_response({"error": "not found"}, status=404)
            try:
                return web.json_response(probe_media(path))
            except Exception as exc:  # noqa: BLE001 - an unreadable file must not 500
                return web.json_response({"error": str(exc)}, status=422)
    except Exception as exc:  # noqa: BLE001
        # The tests run without a server, so failing here is legitimate. But NOT
        # silently: registering too late (after the route table is frozen) raises exactly
        # this and leaves the probe answering 404 for files that plainly exist.
        print(f"[NKD Timeline] probe route not registered: {exc!r}")


_register_routes()


# ── Filmstrips for tensor sources ─────────────────────────────────────────────
# An IMAGE/MASK arrives as a TENSOR from another node, so there is no file for the browser
# to read: the clip could only draw the stills of whatever VIDEO happened to sit upstream
# (a lie the moment the mask comes from somewhere else), or nothing at all.
#
# One contact sheet per tensor slot closes that, and it costs almost no new code: the
# editor already fetches files from `/view` and slices strips into thumbnails. Written to
# temp/, which ComfyUI clears on startup, so nothing accumulates across sessions.

# ONE TILE PER FRAME up to this ceiling, not a sample. The mask overlay draws these
# stills against a picture running at full rate, so a still that is "the nearest one" is
# a mask from a different moment sitting on top of the wrong frame - and unlike a
# filmstrip, where nobody can tell, that reads as the mask being broken. Past the ceiling
# it falls back to sampling and the alignment degrades instead of the memory.
STRIP_MAX_TILES = 480
# The same tile height the browser's thumbnailer uses - and for the same reason: these
# stills are what the monitor draws for a computed slot, so they are sized for it rather
# than for the filmstrip that shows them at a third of this.
STRIP_HEIGHT = 160
# Full-resolution frames are what costs here (240 frames of 1080p is 5.9 GiB as float),
# so they are shrunk a block at a time and only the small ones are kept.
STRIP_CHUNK = 32
_strip_seq = 0


def strip_frame(i: int, tiles: int, n: int) -> int:
    """Which source frame tile `i` shows. Mirrored by `stripFrame` in media.ts - if the
    two ever disagree the overlay lands on a neighbouring frame, which is exactly the
    failure this whole layout exists to remove."""
    return min(n - 1, int((i + 0.5) * n / tiles))


def write_strip(slot: str, obj: torch.Tensor, node_id: Any,
                fps: float) -> Optional[dict]:
    """Contact sheet of one tensor source, plus the metadata the editor cannot probe.

    Laid out as a GRID rather than one long row: at one tile per frame a single row would
    run tens of thousands of pixels wide and hit the browser's image size limits.
    """
    global _strip_seq
    from PIL import Image

    n = int(obj.shape[0])
    if n <= 0:
        return None
    tiles = max(1, min(STRIP_MAX_TILES, n))
    idx = [strip_frame(i, tiles, n) for i in range(tiles)]
    h, w = int(obj.shape[1]), int(obj.shape[2])
    tile_w = max(1, int(round(w / h * STRIP_HEIGHT)))

    parts = []
    for lo in range(0, tiles, STRIP_CHUNK):
        block = obj.index_select(
            0, torch.tensor(idx[lo:lo + STRIP_CHUNK], dtype=torch.long)).float()
        small = _resize(_to_rgb(block).movedim(-1, 1), tile_w, STRIP_HEIGHT)
        parts.append((small.movedim(1, -1).clamp(0.0, 1.0) * 255.0)
                     .round().to(torch.uint8).cpu().numpy())
    arr = np.concatenate(parts, axis=0)

    cols = max(1, int(math.ceil(math.sqrt(tiles))))
    rows = int(math.ceil(tiles / cols))
    sheet = np.zeros((rows * STRIP_HEIGHT, cols * tile_w, 3), dtype=np.uint8)
    for i in range(tiles):
        r, c = divmod(i, cols)
        sheet[r * STRIP_HEIGHT:(r + 1) * STRIP_HEIGHT,
              c * tile_w:(c + 1) * tile_w] = arr[i]

    out_dir = folder_paths.get_temp_directory()
    os.makedirs(out_dir, exist_ok=True)
    _strip_seq += 1
    # A fresh NAME every run rather than overwriting one: the browser would keep serving
    # the old bytes from its own HTTP cache, the exact trap the reload button's `_nkd`
    # counter exists for.
    name = f"nkd_strip_{node_id}_{slot}_{_strip_seq}.png"
    Image.fromarray(sheet).save(os.path.join(out_dir, name), compress_level=1)
    return {"filename": name, "subfolder": "", "type": "temp",
            "tiles": tiles, "cols": cols,
            "frame_count": n, "width": w, "height": h, "fps": float(fps),
            "duration": n / fps if fps else 0.0}


def tensor_strips(sources: dict, node_id: Any, fps: float) -> dict:
    """A strip per tensor slot, keyed by slot name.

    Best-effort throughout: this exists so the editor can draw a picture, and a preview
    must never be able to take a render down with it.
    """
    out: dict[str, dict] = {}
    if not node_id:
        return out
    for slot, (kind, obj) in sources.items():
        if kind == "video":
            continue
        try:
            info = write_strip(slot, obj, node_id, fps)
        except Exception:  # noqa: BLE001 - a picture for the UI, never load-bearing
            info = None
        if info:
            out[slot] = info
    return out


def _push_meta(node_id: Any, data: dict) -> None:
    """Send what was really rendered back to this node's editor.

    Best-effort by design: no server (the tests), a client that went away, or a node with
    no id must never take a render down with them.
    """
    if not node_id:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("nkd-timeline-meta",
                                        {"node": str(node_id), **data})
    except Exception:  # noqa: BLE001 - telemetry for the UI, never load-bearing
        pass


def _read_playhead(cls: Any, node_id: Any) -> int:
    """Fish the playhead out of extra_pnginfo's workflow properties.

    The playhead lives in node.properties.nkdView.playhead — outside the widget — so
    that scrubbing does not invalidate ComfyUI's cache. Returns 0 when unavailable
    (tests, old workflows, missing data).
    """
    extra = getattr(getattr(cls, "hidden", None), "extra_pnginfo", None)
    if not extra or not isinstance(extra, dict):
        return 0
    wf = extra.get("workflow")
    if not isinstance(wf, dict):
        return 0
    for n in wf.get("nodes") or []:
        if str(n.get("id")) == str(node_id):
            props = n.get("properties") or {}
            view = props.get("nkdView") or {}
            return max(0, int(view.get("playhead", 0)))
    return 0


# ── The node ──────────────────────────────────────────────────────────────────

class NKDTimeline(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDTimeline",
            display_name="😺NKD Timeline",
            category="😺NKD Nodes/Preview",
            description=(
                "Lay several videos and audio tracks on a multi-track timeline and get "
                "fps, frame count and resolution back as connectable sockets, so the "
                "material can be coordinated before it enters the graph. Gaps in the "
                "timeline are regions to generate: the `coverage` output is WHITE there, "
                "ready to use as a temporal inpainting mask."
            ),
            inputs=[
                # ONE growing list that takes whatever you plug in. The socket carries a
                # multi-type ("VIDEO,IMAGE,MASK,AUDIO"); the kind is recovered from the
                # object at execute time, and the editor puts each source on the lane its
                # type belongs to. Same shape KJNodes ships in SimpleCalculatorKJ.
                io.Autogrow.Input(
                    "media",
                    template=io.Autogrow.TemplatePrefix(
                        input=io.MultiType.Input(
                            "slot", [io.Video, io.Image, io.Mask, io.Audio],
                            optional=True),
                        prefix="media_", min=1, max=24),
                    tooltip="Connect a video, an image sequence, a mask or audio - the "
                            "same socket takes any of them and the timeline puts it on "
                            "the right lane. More slots appear as you connect."),
                # WIDGET ORDER DELIBERATELY REBUILT (Neko, 2026-08-09) - the same one-off
                # break as the outputs below. `widgets_values` is a positional ARRAY in the
                # saved workflow, so this repoints every stored value and the node has to be
                # re-added. FROM HERE ON the append-only rule applies again: a widget
                # inserted in the middle would make fps come back as the old start_frame.
                # Read top to bottom as the order you set things up in: where material
                # lands, what shape it comes out, how it is fitted, then time, then which
                # model is going to eat it.
                #
                # The editor's data channel. socketless + multiline=False is mandatory:
                # multiline creates a DOM textarea whose element survives being hidden.
                io.String.Input("timeline", default="", socketless=True, multiline=False),
                # Frontend-only: decides where a newly connected source lands. Kept as a
                # real widget so it serialises with the workflow like everything else.
                io.Combo.Input("import_mode", options=["stack", "append"],
                               default="stack",
                               tooltip="Where a newly connected source is placed. "
                                       "'stack' gives each one its own track from frame "
                                       "0, so they layer like any other timeline - the "
                                       "higher track is the one you see. 'append' puts "
                                       "it after the previous one on the same track, to "
                                       "assemble a sequence."),
                io.Combo.Input("aspect_ratio", options=ASPECT_MODES, default=ASPECT_CUSTOM,
                               tooltip="'Custom' uses width/height below, which is what "
                                       "this node always did. Any other ratio computes "
                                       "them from the megapixel budget, and the monitor "
                                       "follows immediately - no run needed."),
                # The size group: the first pair shows on 'Custom', the second on any named
                # ratio. The editor swaps which two are visible.
                io.Int.Input("width", default=0, min=0, max=16384, step=8,
                             tooltip="0 = take the width of the first clip."),
                io.Int.Input("height", default=0, min=0, max=16384, step=8,
                             tooltip="0 = take the height of the first clip."),
                io.Float.Input("megapixels", default=1.0, min=0.05, max=16.0, step=0.05,
                               tooltip="Pixel budget for the chosen ratio. Ignored when "
                                       "aspect_ratio is 'Custom'."),
                io.Int.Input("size_multiple", default=16, min=1, max=64, step=1,
                             tooltip="Round the computed size to a multiple of this. Match "
                                     "the model's canvas grid (MiniMax H3 uses 32) or it "
                                     "resizes every frame again on its way in."),
                io.Combo.Input("fit", options=["contain", "cover", "stretch"],
                               default="contain",
                               tooltip="How a clip is fitted when its aspect ratio does "
                                       "not match the output. The preview shows this "
                                       "live."),
                io.Float.Input("fps", default=24.0, min=1.0, max=240.0, step=0.01,
                               tooltip="Timeline frame rate. Sources at a different rate "
                                       "are resampled."),
                # Named `model` rather than `quantize` (Neko): what you pick here IS the
                # model you are going to feed, and the frame-count grid is a consequence.
                # Nobody looks for "quantize" when the question in their head is "which
                # model is this for".
                io.Combo.Input("model", options=QUANTIZE_MODES, default=QUANTIZE_FREE,
                               tooltip="The model this timeline feeds. Its frame count is "
                                       "snapped to the grid that model requires: Wan, "
                                       "Hunyuan Video, Kandinsky, Cosmos Predict and SCAIL "
                                       "use 4n+1; LTX and Cosmos 1 use 8n+1; Mochi uses "
                                       "6n+1; MiniMax H3 uses 17n+5."),
                io.Int.Input("quantize_n", default=8, min=1, max=256,
                             tooltip="Only used by 'custom (multiple of N)'."),
                io.Int.Input("start_frame", default=0, min=0, max=1_000_000),
                io.Int.Input("frame_count", default=0, min=0, max=1_000_000,
                             tooltip="0 = up to the end of the last clip."),
                io.Boolean.Input("clip_audio", default=True,
                                 tooltip="Include the videos' own audio in the mix."),
                # Appended last, as the rule says: `widgets_values` is positional.
                io.Boolean.Input("clip_markers", default=False,
                                 display_name="clip in/out markers",
                                 tooltip="Also emit the first and last frame of every "
                                         "picture clip on the 'markers' output, AHEAD of "
                                         "the hand-placed markers: clip 1 in, clip 1 out, "
                                         "clip 2 in… NKD Freeze Frames then freezes each "
                                         "cut's boundary frames without marking them by "
                                         "hand."),
            ],
            # ORDER DELIBERATELY REBUILT (Neko, 2026-08-09) - a ONE-OFF break.
            #
            # Sockets are wired by INDEX, so this repoints every saved link and the node has
            # to be re-added by anyone who had it. Taken knowingly while the audience is
            # still small; the append-only rule below applies again from here on.
            # Grouped by what you reach for together: pictures, the three masks, sound, then
            # the numbers, and the playhead pair last.
            outputs=[
                io.Image.Output(display_name="images"),
                io.Mask.Output(display_name="mask",
                               tooltip="The mask lane, and nothing else."),
                # WHITE IN THE GAPS, black over material - the inpainting convention, not
                # a report of what is covered. Flipped deliberately (Neko, 2026-08-09): the
                # old polarity had to be inverted by hand before it was usable, which is
                # exactly the step everybody forgot.
                io.Mask.Output(display_name="coverage",
                               tooltip="White where there is NO material, i.e. the stretches "
                                       "the editor labels 'generate'. Feed it straight to a "
                                       "temporal inpainting mask. For the gaps PLUS the mask "
                                       "lane, use 'generate'."),
                io.Mask.Output(display_name="generate",
                               tooltip="Everything the model should generate: the mask "
                                       "lane UNION the gaps. A gap is a region to "
                                       "generate, so it belongs in the conditioning mask "
                                       "- 'mask' alone leaves it black and nothing is "
                                       "generated there. This is the socket for temporal "
                                       "inpainting."),
                io.Audio.Output(display_name="audio"),
                # Slotted next to `audio` on 2026-08-19 (Neko's call, BREAKING for saved
                # workflows: sockets wire by index, width…markers shifted by 2). Same-day
                # outputs, grouped with the sound they describe.
                io.Mask.Output(display_name="audio_mask",
                               tooltip="WHITE where the rendered soundtrack is silent: "
                                       "frames covered by a MUTED clip, and frames no "
                                       "clip gives sound to at all — silence is a region "
                                       "to generate, like a picture gap in coverage. One "
                                       "value per frame: feeds the audio mask of 😺NKD "
                                       "AV Latent / 😺NKD Audio Mask directly. For MVEx "
                                       "Audio Mask To Latent use audio_ranges instead."),
                io.String.Output(display_name="audio_ranges",
                                 tooltip="The same silent stretches as in,out second "
                                         "pairs (e.g. 0.292,0.833), relative to the "
                                         "rendered range — the exact syntax MVEx Audio "
                                         "Mask To Latent's time_ranges input parses."),
                # No VIDEO output. It only ever got split back into components downstream,
                # and core's own Create Video makes one from `images` + `audio` in one node
                # for the rare case that wants the container.
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.Float.Output(display_name="fps"),
                io.Int.Output(display_name="frame_count"),
                io.Float.Output(display_name="duration",
                                tooltip="Length of the output range in seconds."),
                io.Int.Output(display_name="current_frame"),
                io.Image.Output(display_name="current_image"),
                io.String.Output(display_name="markers",
                                 tooltip="Comma-separated indices of the freeze-frame "
                                         "markers (press M on a clip), counted INTO the "
                                         "'images' batch. Feed it to NKD Freeze Frames."),
                io.Image.Output(display_name="raw_images",
                                tooltip="The timeline cut as-is: every clip contributes "
                                        "its picture, including audio-only clips. Gaps "
                                        "with no material are black. Use as reference "
                                        "for models that need the original video."),
            ],
            # unique_id: needed to address the push below at THIS node's editor.
            # extra_pnginfo: carries the playhead from node.properties — the playhead
            # is kept OUT of the widget to avoid cache invalidation on every scrub.
            hidden=[io.Hidden.unique_id, io.Hidden.extra_pnginfo],
            # So the node can be executed ON ITS OWN, which is how a computed IMAGE/MASK
            # gets its contact sheet without running the samplers downstream: deciding
            # where to cut a mask has to be possible BEFORE generating anything.
            # `validate_prompt` builds the targets of a partial execution only from nodes
            # with OUTPUT_NODE true (execution.py:1163) and refuses a prompt whose set
            # comes out empty, so there is no way to ask for a lone non-output node.
            #
            # NOT the "always executes" flag it looks like: execution.py:443 still
            # short-circuits on a cache hit and re-sends the cached UI. What it does cost
            # is that a Timeline nothing consumes runs once on a full queue instead of
            # being pruned - bypass it if that ever gets in the way.
            is_output_node=True,
        )

    @classmethod
    def execute(cls, media: io.Autogrow.Type, timeline: str, import_mode: str,
                aspect_ratio: str, width: int, height: int, megapixels: float,
                size_multiple: int, fit: str, fps: float, model: str, quantize_n: int,
                start_frame: int, frame_count: int, clip_audio: bool,
                clip_markers: bool = False) -> io.NodeOutput:
        del import_mode   # placement happens in the editor; the backend reads the result
        sources, auds = build_sources(media)

        tl = parse_timeline(timeline)
        clips = [c for c in tl["clips"] if c["src"] in sources]
        maskclips = [c for c in tl["masks"] if c["src"] in sources]
        auclips = [a for a in tl["audio"] if a["src"] in auds]

        fps = max(1e-6, float(fps))

        # With no editor JSON yet (freshly dropped node) every connected picture source
        # gets its own track from frame 0, so the node does something sensible untouched.
        if not clips and sources:
            visual = [k for k in sorted(sources) if sources[k][0] != "mask"]
            clips = [{"src": k, "track": i, "start": 0, "trimIn": 0,
                      "length": source_meta(*sources[k], fps)[1]}
                     for i, k in enumerate(visual)]
        if not maskclips and not clips:
            maskclips = [{"src": k, "track": 0, "start": 0, "trimIn": 0,
                          "length": source_meta(*sources[k], fps)[1]}
                         for k in sorted(sources) if sources[k][0] == "mask"]
        # Audio too, so a graph driven purely from the API (no editor JSON) still mixes
        # whatever was wired in rather than coming out silent.
        if not auclips and auds:
            auclips = [{"src": k, "start": 0, "trimIn": 0, "gain": 1.0, "muted": False,
                        "length": max(1, int(round(
                            auds[k]["waveform"].shape[-1] / int(auds[k]["sample_rate"])
                            * fps)))}
                       for k in sorted(auds)]

        span = timeline_span(clips, maskclips, auclips)
        start_frame = max(0, int(start_frame))
        count = int(frame_count) if frame_count else max(0, span - start_frame)
        count = quantize_count(count, model, quantize_n)
        if count <= 0:
            raise ValueError(
                "NKD Timeline: the timeline is empty. Connect a video, image sequence or "
                "mask, or set frame_count by hand.")

        # Output resolution. Resolved HERE, not on the way in: `As Source` needs the first
        # clip's own dimensions, which only exist once the sources are built.
        first = (clips or maskclips)
        if first:
            kind, obj = sources[first[0]["src"]]
            if kind == "video":
                w0, h0 = obj.get_dimensions()
            else:
                h0, w0 = int(obj.shape[1]), int(obj.shape[2])
        else:
            w0, h0 = 512, 512
        width, height = resolve_resolution(aspect_ratio, megapixels, width, height,
                                           size_multiple, int(w0), int(h0))
        # Still 0 means Custom with nothing typed: fall back to the first clip as before.
        width = int(width) if width > 0 else int(w0)
        height = int(height) if height > 0 else int(h0)

        # `empty`, not `zeros`: at 1920x1080x294 this buffer is 6.8 GiB and MEMSETTING it
        # costs real seconds only for the clips to overwrite it a moment later. The
        # frames no clip covers are blacked out right after the loop, before anything reads
        # them, so the uninitialised memory is never observable.
        out = torch.empty((count, height, width, 3), dtype=torch.float32)
        # Which output frames already carry picture. A blend needs something underneath to
        # blend WITH: the bottom-most clip on a frame always writes straight, whatever its
        # track mode says, or `multiply` over the initial black would just erase it. It is
        # also what says which frames still need blacking out.
        written = torch.zeros(count, dtype=torch.bool)
        # Coverage is constant ACROSS each frame - it is only ever set whole frames at a
        # time - so it is kept as one flag per frame and expanded to a full-size view at the
        # end. Materialising it cost 2.0s and 2.3 GiB for information that is one bit per
        # frame. Same for the mask lane when nothing is on it.
        cover_rows = torch.zeros(count, dtype=torch.float32)
        mask_out = (torch.zeros((count, height, width), dtype=torch.float32)
                    if maskclips else None)
        audio_segments: list[tuple[torch.Tensor, int, int, int, float]] = []
        sample_rate = 0

        end_frame = start_frame + count
        # ponytail: progress is per CLIP, not per frame - gather_window decodes a whole
        # window in ONE core call (that is the point: no decoder of our own), so there is
        # no finer hook to report from. Ticked at the TOP of each body so the count still
        # lands on the total when a clip falls outside the range and is skipped.
        pbar = comfy.utils.ProgressBar(len(clips) + len(maskclips) + len(auclips))
        # 1.0 where some clip actually contributes SOUND to the mix. Marked at the queue
        # sites, so it honours everything they already decide: clip_audio off, a video
        # with no audio track, a muted clip. The audio mask is its complement (plus the
        # muted spans): silence is a region to generate, same thesis as `coverage`.
        heard = torch.zeros(count, dtype=torch.float32)
        for clip in clips:  # already sorted by track, so higher ones overwrite
            pbar.update(1)
            a = max(clip["start"], start_frame)
            b = min(clip["start"] + clip["length"], end_frame)
            if b <= a:
                continue
            kind, obj = sources[clip["src"]]
            frames, audio = gather_window(kind, obj, clip, a, b, fps)
            if frames is None:
                continue
            lo_i, hi_i = a - start_frame, b - start_frame
            # Picture off, sound on. The span stays UNWRITTEN, so it reads as a gap and
            # comes out of `generate` as a region to fill - while the audio below still
            # rides along. That is "cut the middle out, refill it, keep the sound".
            if clip.get("audioOnly"):
                if clip_audio and audio is not None and not clip.get("muted"):
                    got = _queue_clip_audio(audio_segments, clip, kind, obj,
                                            a, b, fps, audio, start_frame)
                    if got:
                        heard[lo_i:hi_i] = 1.0
                    sample_rate = got or sample_rate
                continue
            fitted = fit_frames(_to_rgb(frames), width, height, fit)
            mode = track_blend(tl["tracks"], clip["track"])
            if mode == "normal":
                out[lo_i:hi_i] = fitted
            else:
                base = out[lo_i:hi_i]
                blended = blend_pixels(base, fitted, mode).clamp(0.0, 1.0)
                # Frame-wise: only blend where something is already there.
                have = written[lo_i:hi_i].view(-1, 1, 1, 1)
                out[lo_i:hi_i] = torch.where(have, blended, fitted)
            written[lo_i:hi_i] = True
            cover_rows[lo_i:hi_i] = 1.0

            if clip_audio and audio is not None and not clip.get("muted"):
                got = _queue_clip_audio(audio_segments, clip, kind, obj,
                                        a, b, fps, audio, start_frame)
                if got:
                    heard[lo_i:hi_i] = 1.0
                sample_rate = got or sample_rate

        # Black out the frames no clip reached. This is what makes `torch.empty` above safe,
        # so it MUST stay ahead of every read of `out` - the mask lane and the audio mix do
        # not touch it, but `current_image` does.
        if not bool(written.all()):
            out[(~written).nonzero().flatten()] = 0.0

        # raw_images: same as `out` but audioOnly clips keep their picture.
        ao_clips = [c for c in clips if c.get("audioOnly")]
        if ao_clips:
            raw_out = out.clone()
            raw_written = written.clone()
            for clip in ao_clips:
                a = max(clip["start"], start_frame)
                b = min(clip["start"] + clip["length"], end_frame)
                if b <= a:
                    continue
                kind, obj = sources[clip["src"]]
                frames, _ = gather_window(kind, obj, clip, a, b, fps)
                if frames is None:
                    continue
                lo_i, hi_i = a - start_frame, b - start_frame
                fitted = fit_frames(_to_rgb(frames), width, height, fit)
                mode = track_blend(tl["tracks"], clip["track"])
                if mode == "normal":
                    raw_out[lo_i:hi_i] = fitted
                else:
                    base = raw_out[lo_i:hi_i]
                    blended = blend_pixels(base, fitted, mode).clamp(0.0, 1.0)
                    have = raw_written[lo_i:hi_i].view(-1, 1, 1, 1)
                    raw_out[lo_i:hi_i] = torch.where(have, blended, fitted)
                raw_written[lo_i:hi_i] = True
            if not bool(raw_written.all()):
                raw_out[(~raw_written).nonzero().flatten()] = 0.0
        else:
            raw_out = out

        # The mask lane. A mask clip may point at ANY slot: a real MASK passes through, an
        # image or video is read as luminance. That is "use this video as a mask".
        for clip in maskclips:
            pbar.update(1)
            a = max(clip["start"], start_frame)
            b = min(clip["start"] + clip["length"], end_frame)
            if b <= a:
                continue
            kind, obj = sources[clip["src"]]
            frames, _ = gather_window(kind, obj, clip, a, b, fps)
            if frames is None:
                continue
            mask_out[a - start_frame:b - start_frame] = fit_frames(
                _to_mask(frames), width, height, fit).clamp(0.0, 1.0)

        for ac in auclips:
            pbar.update(1)
            if ac.get("muted"):
                continue
            src = auds[ac["src"]]
            sr = int(src["sample_rate"])
            sample_rate = sample_rate or sr
            a = max(ac["start"], start_frame)
            b = min(ac["start"] + ac["length"], end_frame)
            if b <= a:
                continue
            trim = int(round((ac["trimIn"] + (a - ac["start"])) / fps * sr))
            audio_segments.append((src["waveform"][0], sr,
                                   int(round((a - start_frame) / fps * sr)), trim,
                                   audio_env(ac, a, fps, sr)))
            heard[a - start_frame:b - start_frame] = 1.0

        sample_rate = sample_rate or 44100
        total_samples = int(round(count / fps * sample_rate))
        audio_out = {"waveform": mix_audio(audio_segments, total_samples, sample_rate),
                     "sample_rate": sample_rate}

        # The playhead lives in node.properties (NOT in the widget) so that scrubbing
        # does not invalidate ComfyUI's cache. Read it from the workflow embedded in
        # extra_pnginfo, falling back to the timeline JSON for old workflows.
        node_id = getattr(getattr(cls, "hidden", None), "unique_id", None)
        current = _read_playhead(cls, node_id) or tl["playhead"]
        current = max(0, min(current, count - 1))
        current_image = out[current:current + 1]

        # Seconds, from the QUANTISED count - what actually gets rendered, not what was
        # asked for. Reading it off the raw request would drift from the real output the
        # moment a model grid is in play.
        duration = count / fps

        # Clip bounds FIRST, hand-placed markers after: the bounds are a stable prefix
        # (clip 1 in, clip 1 out, clip 2 in…) so adding a manual marker never repoints
        # a Freeze Frames socket that was wired to a cut boundary.
        marker_list = (clip_bound_indices(clips, start_frame, count)
                       if clip_markers else [])
        marker_list += marker_indices([clips, maskclips, auclips], start_frame, count)
        markers = ", ".join(str(i) for i in marker_list)

        # Tell the editor what was ACTUALLY rendered.
        #
        # `width`/`height` can arrive through a link (a resolution selector, a maths node,
        # a primitive), and a linked value simply does not exist in the browser: it is
        # produced while the graph runs. Without this the monitor keeps guessing the aspect
        # from the first source, so wiring a 9:16 selector left the preview stubbornly
        # landscape. Pushing the resolved numbers back is the only thing that works for ANY
        # upstream node - reading the origin's widgets only ever covers the nodes whose
        # output IS a widget, which a computed selector's is not.
        # `cls.hidden` is only populated by the runtime; calling execute() directly (the
        # tests, or any script driving the node) leaves it None.
        _push_meta(node_id, {
            "width": int(width), "height": int(height),
            "frame_count": int(count), "fps": float(fps),
            "start_frame": int(start_frame),
            # Y una hoja de contactos por fuente que llegó como TENSOR, que es la única
            # forma de que el editor pueda enseñar una máscara calculada: no hay fichero.
            "tensors": tensor_strips(sources, node_id, fps),
        })

        # Blown up to full size only now, and as a VIEW (stride 0 across H and W): no copy,
        # no allocation. Every ordinary tensor op reads it fine; a consumer that writes into
        # a mask IN PLACE gets a loud torch error rather than silent corruption, and can be
        # fed a `.contiguous()` copy at that point.
        gap_rows = 1.0 - cover_rows
        coverage = gap_rows.view(count, 1, 1).expand(count, height, width)

        # "generate" = the mask lane UNION the gaps.
        #
        # A gap is a region to generate - that is the whole thesis of this node - so it
        # belongs in the conditioning mask. `mask` on its own leaves it black, and a black
        # mask means the model generates nothing exactly where there is nothing.
        #
        # With no mask lane the union IS the gaps, which are one value per frame, so it
        # stays a stride-0 view and costs nothing. With a mask lane it has to be a real
        # tensor: per pixel inside a covered frame, all-white in a gap.
        if mask_out is None:
            mask_out = torch.zeros((count, 1, 1),
                                   dtype=torch.float32).expand(count, height, width)
            generate = gap_rows.view(count, 1, 1).expand(count, height, width)
        else:
            generate = torch.maximum(mask_out, gap_rows.view(count, 1, 1))

        # Where the rendered soundtrack is SILENT, exported: white per frame for our own
        # AV nodes (batch = frames, a stride-0 view like coverage), and as second pairs
        # for MVEx Audio Mask To Latent's time_ranges. Silence = no clip contributed
        # sound there (`heard`) OR a muted clip covers it — the union keeps the mute
        # gesture white even when an unmuted clip still sounds underneath. A stretch with
        # no material has no sound either, so it is white here for the same reason it is
        # white in `coverage` (Neko, 2026-08-19: black gaps in the audio mask read as
        # "keep this silence").
        mrows = torch.maximum(muted_rows([clips, auclips], start_frame, count),
                              1.0 - heard)
        audio_mask = mrows.view(count, 1, 1).expand(count, height, width)
        audio_ranges = rows_to_ranges(mrows, fps)

        # Must match the schema's output order exactly - the runtime indexes this tuple by
        # slot number, so a mismatch silently hands one socket's value to another.
        return io.NodeOutput(out, mask_out, coverage, generate, audio_out,
                             audio_mask, audio_ranges,
                             int(width), int(height), float(fps), int(count),
                             float(duration), int(current), current_image, markers,
                             raw_out)


def parse_frame_list(raw: str, total: int) -> list[int]:
    """Frame indices out of a human-written string.

    Separator-agnostic on purpose - commas, spaces and newlines all work - because this
    field gets typed by hand as often as it gets wired up. Duplicates are KEPT and order is
    preserved: repeating an index is a legitimate way to hold a freeze for longer.

    Out-of-range indices raise instead of being clamped or dropped. The timeline never
    emits one, so if it happens the number was typed and quietly turning it into a
    different frame is worse than saying so.
    """
    picks = [int(m) for m in re.findall(r"-?\d+", raw or "")]
    if not picks:
        raise ValueError(
            "NKD Freeze Frames: no frame numbers in 'frames'. Mark some frames with M in "
            "NKD Timeline and connect its 'markers' output, or type indices by hand.")
    for i in picks:
        # Negative indices count from the end, like Python's own.
        if not -total <= i < total:
            raise ValueError(
                f"NKD Freeze Frames: frame {i} is outside the batch (0..{total - 1}).")
    return [i if i >= 0 else total + i for i in picks]


# Hard cap on the per-frame sockets.
#
# There is no such thing as a truly dynamic OUTPUT in this API: `Autogrow` is a
# `ComfyTypeI` (inputs only) and `DynamicOutput` (comfy_api/latest/_io.py:1007) is an empty
# abstract placeholder. The runtime indexes the returned tuple by slot number, so a socket
# the frontend invents beyond the schema fails with an IndexError at execution.
#
# So the schema declares the ceiling and the editor hides the tail it is not using. That is
# ALSO why `images` and `count` come first: the frontend can only truncate from the end, and
# trimming a socket in the middle would slide every later index down and silently rewire a
# saved workflow to a different frame.
MAX_FREEZE_OUTPUTS = 16
PREVIEW_MAX_W = 256


def _badge_previews(frames: torch.Tensor, picks: list[int]) -> torch.Tensor:
    """Thumbnails of the frozen frames with their ordinal and source index burned in.

    Burned in rather than drawn as a widget: `ui.PreviewImage` is a plain gallery with no
    captions, and a row of stills with no way to tell which is which is exactly the thing
    this node exists to avoid. Only the PREVIEW copy is written on - the tensors that leave
    the outputs are untouched.
    """
    from PIL import Image as PILImage, ImageDraw, ImageFont

    h, w = frames.shape[1], frames.shape[2]
    scale = min(1.0, PREVIEW_MAX_W / max(1, w))
    tw, th = max(1, int(w * scale)), max(1, int(h * scale))
    try:
        font = ImageFont.load_default(size=max(11, th // 12))
    except TypeError:            # Pillow < 10.1: no sized default font
        font = ImageFont.load_default()

    out = []
    for n, (frame, idx) in enumerate(zip(frames, picks), start=1):
        arr = (frame.clamp(0, 1) * 255).to(torch.uint8).cpu().numpy()
        img = PILImage.fromarray(arr).resize((tw, th), PILImage.BILINEAR)
        draw = ImageDraw.Draw(img)
        label = f"{n} · f{idx}"
        box = draw.textbbox((0, 0), label, font=font)
        draw.rectangle((3, 3, box[2] + 11, box[3] + 9), fill=(12, 14, 18))
        draw.text((7, 5), label, font=font, fill=(123, 216, 143))   # the marker green
        out.append(torch.from_numpy(np.asarray(img).astype("float32") / 255.0))
    return torch.stack(out)


class NKDFreezeFrames(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDFreezeFrames",
            display_name="😺NKD Freeze Frames",
            category="😺NKD Nodes/Preview",
            description=(
                "Hold individual frames of a batch as still images, one per socket.\n\n"
                "Wire the 'markers' output of NKD Timeline into 'frames' and every frame "
                "you marked with M comes out of its own 'frame_N' output, previewed on the "
                "node so you can see which is which. The field can also just be typed: "
                "'0, 12, 47'. 'images' carries the same frames as one batch."),
            inputs=[
                io.Image.Input("images",
                               tooltip="The batch to pick from - normally the 'images' "
                                       "output of NKD Timeline."),
                io.String.Input("frames", default="", multiline=False,
                                tooltip="Indices into the batch, any separator. Negatives "
                                        "count from the end. Repeats are kept."),
            ],
            # images/count FIRST - see MAX_FREEZE_OUTPUTS. Never reorder these.
            outputs=[
                io.Image.Output(display_name="images"),
                io.Int.Output(display_name="count"),
                *[io.Image.Output(display_name=f"frame_{i}")
                  for i in range(1, MAX_FREEZE_OUTPUTS + 1)],
            ],
            is_output_node=True,      # so the node can show the previews at all
        )

    @classmethod
    def execute(cls, images: torch.Tensor, frames: str) -> io.NodeOutput:
        picks = parse_frame_list(frames, int(images.shape[0]))
        if len(picks) > MAX_FREEZE_OUTPUTS:
            raise ValueError(
                f"NKD Freeze Frames: {len(picks)} frames requested but the node has "
                f"{MAX_FREEZE_OUTPUTS} sockets. Use the 'images' batch output instead, or "
                f"split the markers across two nodes.")
        # index_select rather than fancy indexing: it is explicit about producing a copy,
        # so a downstream in-place op cannot reach back into the timeline's own batch.
        out = images.index_select(0, torch.tensor(picks, device=images.device))
        # One socket per frame, then None for the sockets the editor is hiding. A hidden
        # socket has no link, so nothing ever reads the None.
        singles = [out[i:i + 1] for i in range(len(picks))]
        singles += [None] * (MAX_FREEZE_OUTPUTS - len(singles))
        return io.NodeOutput(out, len(picks), *singles,
                             ui=ui.PreviewImage(_badge_previews(out, picks), cls=cls))


# No ComfyExtension and no NODE_CLASS_MAPPINGS here on purpose. `__init__.py` exports ONE
# entrypoint, `nodes.py:comfy_entrypoint`, and ComfyUI only looks at that; a second
# extension class in this module would never be called. There used to be one, and it is
# exactly why NKDFreezeFrames shipped invisible - it was registered somewhere nobody reads.
# A node added here MUST also go into the list in `nodes.py`.
