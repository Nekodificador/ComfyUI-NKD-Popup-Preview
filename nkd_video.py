"""
😺NKD Video Viewer — encode once, watch it properly.

Why this exists at all: the core only writes mp4/h264 (`SaveVideo`) and vp9/av1
(`SaveWEBM`), and both hand the browser a bare `<video>`. Video Helper Suite has the
formats but transcodes every preview into a streaming WebM WITHOUT Range support, which is
precisely why its preview cannot be scrubbed. Here the encoded file is served RAW through
`/view`, which aiohttp delivers with `FileResponse` — Range included — so the `<video>`
seeks natively. Same reasoning as `src/timeline/media.ts`.

Encoding goes through **PyAV**, already a hard dependency of the core
(`comfy_extras/nodes_video.py` imports it at module level), so this adds nothing new. It
cannot go through `VideoFromComponents.save_to`, which is wired to h264/mp4/aac
(`comfy_api/latest/_input_impl/video_types.py:833`).
"""

import json
import os
import re
import shutil
import time
import weakref
from fractions import Fraction

import av
import folder_paths
import numpy as np
import torch
from PIL import Image as PILImage
from typing_extensions import override

import comfy.utils
from comfy.cli_args import args
from comfy_api.latest import InputImpl, Types, io
from comfy_api.latest._io import _UIOutput

# Both spellings on purpose: ComfyUI imports this as part of the package, the tests import
# it flat (`from nkd_video import ...`), and a bare relative import breaks the second.
try:
    from . import nkd_projects
except ImportError:  # pragma: no cover - flat import, tests only
    import nkd_projects


# ── Output naming, the way a Write node does it ───────────────────────────────
# Nuke puts the version between the name and the frame padding
# (`final_comp_v01.####.exr`), and studio convention repeats it in the FOLDER too
# (`sh001_comp_v001/sh001_comp_v001.####.exr`) so a stray file still says which version it
# is. ComfyUI has tokens (Save Image Extended, SaveImageWithMetaData) but nothing has
# versioning, which is the gap this fills.
#
# `%date:...%` and `%NodeTitle.widget%` are already resolved by the FRONTEND before the
# prompt is sent (`applyTextReplacements`, exported on `comfyAPI.utils`), which also
# sanitises the substituted value so a widget cannot inject a path separator. What is left
# here are the tokens only the backend can know, because they describe the render that just
# happened.
#
# Kept in this file rather than a module of its own: `nkd_timeline.py` is self-contained for
# the same reason, so the tests can import it flat.

VERSION_RE = re.compile(r"%v(#+)%")


def resolve_tokens(prefix: str, ctx: dict) -> str:
    """Replace the render-time tokens. `%v###%` is handled separately, by `apply_version`."""
    out = prefix
    out = re.sub(r"%time:([^%]*)%",
                 lambda m: time.strftime(m.group(1) or "%H-%M-%S"), out)
    for key, value in ctx.items():
        out = out.replace(f"%{key}%", str(value))
    return out


def _version_pattern(part: str, pad: int) -> re.Pattern | None:
    """Turn one path segment containing `%v###%` into a regex with the number captured.

    The tail accepts `.` OR `_` after the number: anything that STARTS with the
    versioned stem occupies that version — `NKD_v001_labeled.mp4` claims v001 just as
    much as `NKD_v001.mp4` does. Extension-only matching let a run that wrote ONLY the
    labeled copy hand out v001 again next to it (reported by Neko, 2026-08-18).
    """
    if not VERSION_RE.search(part):
        return None
    escaped = VERSION_RE.sub("\x00", part)
    escaped = re.escape(escaped).replace("\x00", rf"(\d{{{pad},}})")
    return re.compile(rf"^{escaped}(?:[._].*)?$", re.IGNORECASE)


def next_version(root: str, prefix: str, pad: int) -> int:
    """The lowest unused version, found by scanning where the token actually sits.

    The token can be in a FOLDER (`shot/v%v###%/name`) or in the FILE NAME
    (`shot/name_v%v###%`), and studios use both at once. So: walk down the fixed part of the
    path, stop at the first segment carrying the token, and scan THAT directory for
    neighbours matching the same pattern.

    Returns 1 when nothing matches - including when the directory does not exist yet, which
    is the common first-run case.
    """
    parts = prefix.replace("\\", "/").split("/")
    fixed: list[str] = []
    for part in parts:
        pattern = _version_pattern(part, pad)
        if pattern is None:
            fixed.append(part)
            continue
        folder = os.path.join(root, *fixed) if fixed else root
        try:
            entries = os.listdir(folder)
        except OSError:
            return 1
        best = 0
        for entry in entries:
            m = pattern.match(entry)
            if m:
                best = max(best, int(m.group(1)))
        return best + 1
    return 1


def apply_version(prefix: str, version: int) -> str:
    """Stamp the version into every `%v###%`, each padded by its own hash count."""
    return VERSION_RE.sub(lambda m: str(version).zfill(len(m.group(1))), prefix)


# `v001`: three digits is the convention everywhere, and it is what gets appended when
# versioning is on but the prefix carries no token of its own.
DEFAULT_VERSION_PAD = 3


def version_pad(prefix: str) -> int:
    """Hash count of the first version token, or the default if there is none."""
    m = VERSION_RE.search(prefix)
    return len(m.group(1)) if m else DEFAULT_VERSION_PAD


def has_version(prefix: str) -> bool:
    return bool(VERSION_RE.search(prefix))


def save_target(prefix: str, root: str, ext: str,
                versioning: str = "off", version: int = 1) -> tuple[str, str, str]:
    """Where a copied still lands: (full_folder, out_name, subfolder).

    Same naming machinery the video viewer uses (`_resolve_prefix`), pulled out so the
    Popup Preview's `/nkd/save` copy gets versioning too instead of only a raw counter:
      off    -> a `_00001_` counter, the core's SaveImage convention (never overwrites).
      auto   -> `_vNNN` at the next free version.
      manual -> `_vNNN` at exactly `version` (re-saving overwrites, like a Write node).
    The version token is appended to the NAME when the prefix carries none, exactly as
    `_resolve_prefix` does.
    """
    if versioning != "off":
        if not has_version(prefix):
            prefix = f"{prefix}_v%v{'#' * DEFAULT_VERSION_PAD}%"
        used = version if versioning == "manual" else next_version(root, prefix, version_pad(prefix))
        prefix = apply_version(prefix, used)
        full_folder, name, _, subfolder, _ = folder_paths.get_save_image_path(prefix, root)
        return full_folder, f"{name}{ext}", subfolder
    full_folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(prefix, root)
    return full_folder, f"{name}_{counter:05}_{ext}", subfolder


# ── Formats ───────────────────────────────────────────────────────────────────
# The key IS the combo label, so it reads as "container / codec" the way an export dialog
# does. Everything downstream keys off this table rather than off scattered ifs.
# `preview` says what the BROWSER can do with the result, which is not the same question as
# what the format is good for:
#   video - a seekable <video>: the full scrubbing viewer.
#   image - an <img>: it animates, but the format has no seekable stream, so no scrub.
#   none  - nothing the browser will open. A poster frame is written alongside so the node
#           still shows what was rendered instead of a broken box.
#
# `mime` is what the VIEWER asks `canPlayType` about, rather than the backend deciding: what
# a browser will play is a property of the MACHINE, not of the file. Costs nothing and keeps
# the judgement where the answer actually lives.
FORMATS = {
    "mp4 / h264": {"ext": "mp4", "vcodec": "libx264", "acodec": "aac", "preview": "video",
                   "mime": 'video/mp4; codecs="avc1.42E01E"', "poster": False},
    # h265 is DELIBERATELY ABSENT and this is not an oversight. Do not add it back without
    # testing it to destruction first: what ruled it out is not a quality question.
    "webm / vp9": {"ext": "webm", "vcodec": "libvpx-vp9", "acodec": "libopus",
                   "preview": "video", "mime": 'video/webm; codecs="vp9"', "poster": False},
    # ProRes is the one case with no argument: no browser implements it and none will. It is
    # an editing intermediate, not a delivery format.
    "mov / prores": {"ext": "mov", "vcodec": "prores_ks", "acodec": "pcm_s16le",
                     "preview": "none", "mime": None, "poster": True},
    "gif": {"ext": "gif", "vcodec": None, "acodec": None, "preview": "image",
            "mime": None, "poster": False},
    "webp": {"ext": "webp", "vcodec": None, "acodec": None, "preview": "image",
             "mime": None, "poster": False},
    "png sequence": {"ext": "png", "vcodec": None, "acodec": None, "preview": "none",
                     "mime": None, "poster": True},
}

# prores_ks profile numbers, straight from ffmpeg.
#
# **4444 is the pack's only working alpha path.**
#
# The pixel format here is what the encoder is ASKED for, which is not what ends up in the
# file, and asking for the stored one directly fails to open. So this is the value that has
# to be here - a test pinning the stored format instead would be pinning the wrong one.
PRORES_PROFILES = {
    "proxy": (0, "yuv422p10le"),
    "lt": (1, "yuv422p10le"),
    "standard": (2, "yuv422p10le"),
    "hq": (3, "yuv422p10le"),
    "4444": (4, "yuva444p10le"),
}


# ── Re-encode avoidance ───────────────────────────────────────────────────────
# Bumping the version bumps an INPUT, so ComfyUI's signature changes and the node re-runs -
# correct, but the only thing that actually changed is where the file goes. Re-encoding a
# long clip to rename it is absurd, so an identical render is COPIED instead.
#
# "Identical" is decided by tensor IDENTITY, not by hashing:
#
# - Hashing the frames costs about a second per gigabyte, on every run, forever.
# - Reconstructing ComfyUI's own signature from `hidden.prompt` looks tempting and is WRONG:
#   it would miss `IS_CHANGED`. A Load Video pointing at a file whose CONTENTS were replaced
#   keeps the exact same prompt entry, so that signature would match and we would happily
#   copy the previous, stale render.
# - Object identity has neither problem. When an upstream node is served from ComfyUI's
#   cache it hands back the SAME tensor object; when it re-executes - for any reason,
#   including IS_CHANGED - it builds a new one. So `is` answers exactly the question.
#
# Held as WEAK references: a strong one would pin whole frame batches (gigabytes) alive for
# the rest of the session. If the tensor is collected the ref dies and we simply re-encode,
# which is the safe direction to fail in.
_ENCODED: dict[str, dict] = {}


def _weak(tensor):
    """A weakref to a tensor, or None. Never raises - not everything is weak-referenceable."""
    try:
        return weakref.ref(tensor) if tensor is not None else None
    except TypeError:
        return None


def _same_object(ref, obj) -> bool:
    """True when `ref` still points at exactly `obj`. A dead ref is never a match."""
    if ref is None and obj is None:
        return True
    if ref is None or obj is None:
        return False
    return ref() is obj


def reusable_render(node_key: str, images, audio_wave, settings: tuple,
                    ext: str) -> str | None:
    """Path of a previous render that is byte-for-byte what we are about to make."""
    prev = _ENCODED.get(node_key)
    if not prev or prev["settings"] != settings or prev["ext"] != ext:
        return None
    if not (_same_object(prev["images"], images) and _same_object(prev["audio"], audio_wave)):
        return None
    # The user may have moved or deleted it since; a missing source is not reusable.
    return prev["path"] if os.path.isfile(prev["path"]) else None


def remember_render(node_key: str, images, audio_wave, settings: tuple, ext: str,
                    path: str) -> None:
    _ENCODED[node_key] = {
        "images": _weak(images), "audio": _weak(audio_wave),
        "settings": settings, "ext": ext, "path": path,
    }


def _decompose(media):
    """(images, audio, fps or None) out of an IMAGE, a MASK or a VIDEO.

    A MASK **is** a sequence of greyscale frames and an IMAGE **is** a sequence, so all
    three arrive at the encoder by the same road - the same reasoning as `classify` in
    `nkd_timeline.py`, and the same duck typing for VIDEO so any `VideoInput`
    implementation works rather than one concrete class.
    """
    if isinstance(media, torch.Tensor):
        # MASK is (B,H,W) → ndim 3; IMAGE is (B,H,W,C) → ndim 4.
        if media.ndim == 3:
            media = media.unsqueeze(-1).repeat(1, 1, 1, 3)
        return media, None, None
    if not (hasattr(media, "get_components") and hasattr(media, "get_frame_rate")):
        raise ValueError("😺NKD Video Viewer got something that is not an image, "
                         "mask or video.")
    components = media.get_components()
    return components.images, components.audio, float(components.frame_rate)


def _view_item(path: str, kind: str = "temp") -> dict:
    """The `/view` item (filename + subfolder) for a file already written under a root."""
    root = (folder_paths.get_temp_directory() if kind == "temp"
            else folder_paths.get_output_directory())
    rel = os.path.relpath(path, root)
    return {"filename": os.path.basename(rel),
            "subfolder": os.path.dirname(rel).replace("\\", "/"),
            "type": kind}


# The reference is a PREVIEW artefact, never a deliverable: it goes to temp/ (which ComfyUI
# empties) as h264, because that is the one thing every browser can play and seek.
REFERENCE_PREFIX = "NKDVideoViewer/ref"
REFERENCE_CRF = 23.0


class NKDVideoUI(_UIOutput):
    """A UI payload the CORE frontend does not recognise.

    Deliberate: returning `ui.PreviewVideo` would make ComfyUI render its own player on top
    of ours, so the node would carry two. Our own key means only our widget reacts.
    """

    def __init__(self, result: dict, meta: dict):
        self.result = result
        self.meta = meta

    def as_dict(self):
        return {"nkd_video": [self.result], "nkd_meta": [self.meta]}


# ── Encoding ──────────────────────────────────────────────────────────────────

def _to_u8(frame: torch.Tensor, channels: int) -> np.ndarray:
    """One frame of an IMAGE tensor as HxWxC uint8."""
    return (frame[..., :channels] * 255).clamp(0, 255).byte().cpu().numpy()


def _add_audio_stream(container, audio: dict | None, codec: str | None,
                      max_seconds: float):
    """Declare the audio stream and prepare its source frame.

    **Must run before the first video packet is muxed.** The container writes its header on
    that first packet; a stream added afterwards is missing from the header, gets no
    time base, and every packet on it dies with "Cannot rebase to zero time".
    """
    if not audio or not codec:
        return None
    rate = int(audio["sample_rate"])
    wave = audio["waveform"][0]                       # (channels, samples)
    wave = wave[:, : max(1, int(rate * max_seconds))]  # never outrun the picture
    layout = {1: "mono", 2: "stereo", 6: "5.1"}.get(wave.shape[0], "stereo")

    # Opus only accepts 48 kHz, so a 44.1 kHz track has to be resampled. Going through
    # AudioResampler covers every codec rather than special-casing that one.
    stream = container.add_stream(codec, rate=48000 if codec == "libopus" else rate)
    stream.layout = layout
    src = av.AudioFrame.from_ndarray(
        wave.float().cpu().contiguous().numpy(), format="fltp", layout=layout)
    src.sample_rate = rate
    # Without a pts AND a time base the resampler emits frames with no timestamp, and the
    # muxer rejects them rather than assuming a start.
    src.pts = 0
    src.time_base = Fraction(1, rate)
    return stream, src


def _write_audio(container, prepared) -> None:
    if prepared is None:
        return
    stream, src = prepared
    resampler = av.audio.resampler.AudioResampler(
        format=stream.format, layout=stream.layout, rate=stream.rate)
    for frame in resampler.resample(src):
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)


def encode_video(images: torch.Tensor, path: str, spec: dict, fps: float,
                 crf: float, preset: str | None, audio: dict | None,
                 metadata: dict | None, pbar: comfy.utils.ProgressBar | None,
                 profile: str | None = None) -> None:
    """h264 / vp9 / ProRes through PyAV.

    **Alpha survives on ProRes 4444 and nowhere else.** Both halves checked,
    by encoding a half-transparent clip and reading it back:

    - **ProRes 4444: yes.** Comes back with alpha 0 on one side and 255 on the other.
    - **vp9: no**, however it is asked. WebM carries a vp9 alpha plane in `BlockAdditional`,
      which the ffmpeg CLI assembles as a second stream; libavformat does not, so nothing
      PyAV can express produces it - with or without `auto-alt-ref 0`. The core's `SaveWEBM`
      sets `yuva420p` and implies otherwise.
    - h264 has no alpha path at all.

    Everywhere except 4444 the alpha is flattened. Promising it would be a lie that only
    turns up once someone composites the result.
    """
    # mp4 drops any tag it does not recognise unless `use_metadata_tags` is on, so without
    # this the embedded prompt silently vanishes. `faststart` earns its place separately:
    # it moves the moov atom to the front, which is what lets a <video> start playing and
    # seeking without pulling the whole file first - the point of this node's viewer.
    open_kwargs = {"mode": "w"}
    if spec["ext"] == "mp4":
        open_kwargs["options"] = {"movflags": "use_metadata_tags+faststart"}
    # yuv420p (every codec here except ProRes) subsamples chroma 2x2, so libx264/libvpx
    # reject an odd width or height outright ("width not divisible by 2") instead of
    # rounding it themselves. Any odd-dimensioned IMAGE batch hits this — a free-drag crop
    # is the easiest way to get one, but it is not the only one — so the guard belongs here,
    # the one place every h264/vp9 render already routes through, not in each upstream node.
    # A 1px edge crop is imperceptible; padding would have to fabricate a column instead.
    if spec["vcodec"] != "prores_ks":
        h, w = images.shape[1], images.shape[2]
        if h % 2 or w % 2:
            images = images[:, :h - h % 2, :w - w % 2, :]

    container = av.open(path, **open_kwargs)
    try:
        if metadata:
            for key, value in metadata.items():
                container.metadata[key] = json.dumps(value)
        stream = container.add_stream(
            spec["vcodec"], rate=Fraction(round(fps * 1000), 1000))
        stream.width = images.shape[2]
        stream.height = images.shape[1]
        stream.bit_rate = 0
        alpha = False
        if spec["vcodec"] == "prores_ks":
            # ProRes is quality-by-PROFILE, not by crf: the profile picks the bitrate class
            # and the pixel format together, and 4444 is the only one with an alpha plane.
            number, pix_fmt = PRORES_PROFILES.get(profile or "hq", PRORES_PROFILES["hq"])
            stream.pix_fmt = pix_fmt
            stream.options = {"profile": str(number)}
            alpha = number == 4 and images.shape[-1] == 4
        else:
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": str(int(crf))}
            if preset and spec["vcodec"] == "libx264":
                stream.options["preset"] = preset
        # Before the first mux, or the stream misses the header. See _add_audio_stream.
        prepared = _add_audio_stream(
            container, audio, spec["acodec"], len(images) / max(fps, 1e-6))

        fmt = "rgba" if alpha else "rgb24"
        for frame in images:
            packet = stream.encode(av.VideoFrame.from_ndarray(
                _to_u8(frame, 4 if alpha else 3), format=fmt))
            container.mux(packet)
            if pbar:
                pbar.update(1)
        container.mux(stream.encode(None))
        _write_audio(container, prepared)
    finally:
        container.close()


PALETTE_SAMPLES = 16


def _gif_palette(images: torch.Tensor, colors: int) -> PILImage.Image:
    """One palette for the whole clip, sampled ACROSS it.

    Quantising each frame on its own is what makes a GIF shimmer: the table drifts frame to
    frame and flat areas crawl. But building it from the FIRST frame alone is just as wrong
    — a clip that opens on a fade gets a palette of near-blacks and everything after it
    collapses onto those few entries. Sampling evenly over the clip costs nothing here and
    is what ffmpeg's palettegen does for the same reason.
    """
    n = len(images)
    picks = {round(i * (n - 1) / max(1, PALETTE_SAMPLES - 1)) for i in range(PALETTE_SAMPLES)}
    sample = torch.cat([images[i] for i in sorted(picks)], dim=0)   # stack vertically
    return PILImage.fromarray(_to_u8(sample, 3), "RGB").quantize(
        colors=max(2, min(256, colors)), method=PILImage.Quantize.MEDIANCUT)


def encode_gif(images: torch.Tensor, path: str, fps: float, colors: int, dither: bool,
               pbar: comfy.utils.ProgressBar | None) -> None:
    d = PILImage.Dither.FLOYDSTEINBERG if dither else PILImage.Dither.NONE
    master = _gif_palette(images, colors)
    frames = []
    for frame in images:
        im = PILImage.fromarray(_to_u8(frame, 3), "RGB")
        frames.append(im.quantize(palette=master, dither=d))
        if pbar:
            pbar.update(1)
    frames[0].save(path, save_all=True, append_images=frames[1:], loop=0,
                   duration=max(1, round(1000 / max(fps, 1e-6))), disposal=2)


def encode_webp(images: torch.Tensor, path: str, fps: float, quality: int, lossless: bool,
                pbar: comfy.utils.ProgressBar | None) -> None:
    """Animated WebP. No palette to worry about - it is a true-colour format, unlike GIF."""
    frames = []
    for frame in images:
        frames.append(PILImage.fromarray(_to_u8(frame, 3), "RGB"))
        if pbar:
            pbar.update(1)
    frames[0].save(path, save_all=True, append_images=frames[1:], loop=0,
                   duration=max(1, round(1000 / max(fps, 1e-6))),
                   quality=max(0, min(100, quality)), lossless=bool(lossless), method=4)


def encode_png_sequence(images: torch.Tensor, folder: str, stem: str, pad: int,
                        pbar: comfy.utils.ProgressBar | None) -> str:
    """One PNG per frame, `stem.0001.png`, in a folder of their own.

    Numbered with a DOT before the frame number, which is the convention every compositor
    reads as an image sequence (`shot_v001.0001.png`); an underscore makes it look like part
    of the name. Returns the folder, because here the folder IS the output.
    """
    os.makedirs(folder, exist_ok=True)
    for i, frame in enumerate(images):
        PILImage.fromarray(_to_u8(frame, 3), "RGB").save(
            os.path.join(folder, f"{stem}.{i:0{pad}d}.png"), compress_level=4)
        if pbar:
            pbar.update(1)
    return folder


def _tree_size(path: str) -> int:
    """Bytes on disk, whether the output is one file or a folder of frames."""
    if os.path.isdir(path):
        return sum(os.path.getsize(os.path.join(path, f)) for f in os.listdir(path)
                   if os.path.isfile(os.path.join(path, f)))
    return os.path.getsize(path) if os.path.isfile(path) else 0


def write_poster(images: torch.Tensor, path: str) -> None:
    """A single PNG of the first frame, for formats no browser will open.

    ProRes and a PNG sequence cannot go in a `<video>` or an `<img>`, and a node that
    renders for thirty seconds and then shows an empty box reads as broken. One frame is
    cheap and answers the only question the preview needs to: did it render what I meant?
    """
    PILImage.fromarray(_to_u8(images[0], 3), "RGB").save(path, compress_level=4)


# ── Tracked-widget labels ─────────────────────────────────────────────────────
# The right-click "Track widget" mark (frontend, `src/labels.ts`) writes ONLY the list of
# `[node_id, widget]` pairs into the `labels` input. The VALUES never travel:
# `hidden.prompt` already carries every widget of every node for THIS run, so they are
# looked up at execute time and cannot go stale. Same principle as the core's
# `%NodeTitle.widget%` tokens, but resolved by id — titles are not unique.

LABEL_VALUE_MAX = 58

# ── Per-pass index, for swept values ──────────────────────────────────────────
# A Number OutputList driving a tracked widget turns the whole chain into a LIST: the
# executor runs this node once per item, SEQUENTIALLY AND IN ORDER (`execution.py:316`,
# `for i in range(max_len_input)`), so counting our own executions within a prompt IS the
# list index. The count lives on `PromptServer.instance` — the hot-reload rule: two module
# copies must share one dict — and resets when a new prompt is submitted, so an
# interrupted run can never bleed a stale index into the next one.

_LOCAL_COUNTS: dict[str, int] = {}    # tests / no server


def _pass_counts() -> dict:
    try:
        from server import PromptServer
        srv = PromptServer.instance
        if srv is None:
            return _LOCAL_COUNTS
        d = getattr(srv, "_nkd_pass_counts", None)
        if d is None:
            d = {}
            srv._nkd_pass_counts = d
        return d
    except Exception:
        return _LOCAL_COUNTS


def _reset_pass_counts(json_data):
    _pass_counts().clear()
    return json_data


try:
    from server import PromptServer as _PS
    # The marker guards hot reload: the OLD module's handler stays registered, but it
    # clears the same instance-anchored dict, so one registration is enough forever.
    if _PS.instance is not None and not getattr(_PS.instance, "_nkd_pass_reset", False):
        _PS.instance.add_on_prompt_handler(_reset_pass_counts)
        _PS.instance._nkd_pass_reset = True
except Exception:   # tests import this flat, with no server
    pass


def _source_list(prompt, node_id, slot):
    """The output at `slot` of a PURE generator node, executed out of band.

    This is what lets a swept value be labelled WITHOUT a cable: the per-pass number
    never exists in the prompt, but the node that generates the sweep is right there
    with all its literals, so run it and read the list. Only a node this simple
    qualifies — every input literal, every output a primitive — and None on anything
    else (or any error): a wrong label is worse than a `(linked)` one.
    """
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs", {})
    if any(_is_link(v) for v in inputs.values()):
        return None
    try:
        import nodes as comfy_nodes
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(node.get("class_type"))
    except Exception:
        return None
    if cls is None:
        return None
    prim = {"INT", "FLOAT", "STRING", "BOOLEAN"}
    returns = getattr(cls, "RETURN_TYPES", None)
    if returns is None and hasattr(cls, "define_schema"):     # V3 without V1 shim
        try:
            returns = tuple(o.io_type for o in cls.define_schema().outputs)
        except Exception:
            return None
    if not returns or int(slot) >= len(returns) or any(t not in prim for t in returns):
        return None
    try:
        if isinstance(cls.__dict__.get("execute"), classmethod):   # V3
            out = cls.execute(**inputs).result
        else:                                                      # V1
            out = getattr(cls(), cls.FUNCTION)(**inputs)
        return out[int(slot)]
    except Exception:
        return None


def _is_link(v) -> bool:
    """A linked input in a prompt is `[node_id, output_slot]`."""
    return isinstance(v, list) and len(v) == 2


def _fmt_label_value(v) -> str:
    if isinstance(v, float):
        v = f"{v:g}"
    s = " ".join(str(v).split())     # a multiline prompt text would break the bar
    return s if len(s) <= LABEL_VALUE_MAX else s[: LABEL_VALUE_MAX - 1] + "…"


def label_lines(labels: str, prompt, pass_index: int = 0) -> list[str]:
    """One `Title · widget: value` line per tracked entry, skipping what no longer exists.

    A deleted node leaves its mark behind in a saved list, and skipping beats failing a
    render over a label. A linked value arrives as `[node_id, slot]`, resolved cable-less
    (the system's hard rule — a `value_N` socket was built and vetoed by Neko), in order:

    1. The source is a PURE generator (a Number OutputList): execute it out of band and
       take item `pass_index` — this run's own position in the list execution. That is
       the real per-pass value of a sweep.
    2. The source has exactly ONE literal input (a primitive): that value stands in.
    3. `(linked → Source)` — name who drives it rather than guess.
    """
    try:
        entries = json.loads(labels) if labels else []
    except (ValueError, TypeError):
        return []
    if not isinstance(entries, list) or not isinstance(prompt, dict):
        return []
    out = []
    for entry in entries:
        try:
            node_id, widget = str(entry[0]), str(entry[1])
        except (TypeError, IndexError, KeyError):
            continue
        node = prompt.get(node_id)
        if not isinstance(node, dict):
            # A SUBGRAPH's surface id: the prompt only contains its expanded interior,
            # under composite ids ("192:199"). The frontend resolves marks to those ids
            # before sending (resolveMark in src/labels.ts); this is the net for a
            # labels list written by an older bundle. Only an UNAMBIGUOUS match counts:
            # with two interior nodes carrying the widget, guessing would label the
            # wrong one in silence.
            matches = [n for nid, n in prompt.items()
                       if nid.startswith(node_id + ":") and isinstance(n, dict)
                       and widget in n.get("inputs", {})
                       and not _is_link(n["inputs"][widget])]
            node = matches[0] if len(matches) == 1 else None
        if not isinstance(node, dict) or widget not in node.get("inputs", {}):
            continue
        value = node["inputs"][widget]
        if _is_link(value):
            lst = _source_list(prompt, value[0], value[1])
            src = prompt.get(str(value[0]), {})
            literals = [v for v in src.get("inputs", {}).values() if not _is_link(v)]
            if isinstance(lst, (list, tuple, range)):
                # Out of range would mean our pass count and the list disagree — say
                # linked rather than burn a neighbouring item's value.
                value = (lst[pass_index] if pass_index < len(lst)
                         else f"(linked → {src.get('class_type', '?')})")
            elif lst is not None:
                value = lst                       # a scalar output (a `count`)
            elif len(literals) == 1:
                value = literals[0]
            else:
                # Naming the source is the most that can be said here.
                value = f"(linked → {src.get('class_type', '?')})"
        title = str((node.get("_meta") or {}).get("title")
                    or node.get("class_type") or node_id)
        out.append(f"{title} · {widget}: {_fmt_label_value(value)}")
    return out


LABEL_BAR_ALPHA = 0.72


def burn_labels(images: torch.Tensor, lines: list[str]) -> torch.Tensor:
    """A COPY of the frames with a semi-transparent parameter bar burned in.

    The bar is identical on every frame, so it is rendered ONCE with PIL and composited
    over the batch as a tensor op — a per-frame PIL round-trip is the thing
    `comfy.utils.lanczos` already taught us to avoid. Overlaid, never concatenated: the
    review copy stays geometrically identical to the clean render, so it drops into the
    same comparisons. Same idiom (and the same green) as `_badge_previews` in the timeline.
    """
    from PIL import ImageDraw, ImageFont

    h, w = int(images.shape[1]), int(images.shape[2])
    size = max(11, h // 36)
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:                       # Pillow < 10.1: no sized default font
        font = ImageFont.load_default()
    pad = max(3, size // 3)
    line_h = size + pad
    # Never eat more than half the picture: drop the tail and say so.
    fit = max(1, (h // 2 - pad) // line_h)
    if len(lines) > fit:
        lines = lines[: fit - 1] + [f"… {len(lines) - fit + 1} more"]
    bar_h = min(h, pad + line_h * len(lines))

    img = PILImage.new("RGBA", (w, bar_h), (10, 12, 16, int(255 * LABEL_BAR_ALPHA)))
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((pad + 2, pad // 2 + i * line_h), line, font=font,
                  fill=(123, 216, 143, 255))          # the marker green
    overlay = torch.from_numpy(
        np.asarray(img).astype("float32") / 255.0).to(images.device)
    rgb, a = overlay[..., :3], overlay[..., 3:]

    out = images.clone()
    # Only the first 3 channels: an RGBA clip keeps its alpha plane untouched.
    top = out[:, :bar_h, :, :3]
    out[:, :bar_h, :, :3] = top * (1 - a) + rgb * a
    return out


# ── Node ──────────────────────────────────────────────────────────────────────

class NKDVideoViewer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDVideoViewer",
            display_name="😺NKD Video Viewer",
            category="😺NKD Nodes/Preview",
            search_aliases=["video combine", "save video", "export video", "video viewer"],
            description=(
                "Encodes frames (or a video) and previews the result in a scrubbable, "
                "looping viewer with frame-accurate stepping. The file is served raw, so "
                "seeking is native rather than a re-streamed approximation."
            ),
            # Ordered the way it is CONFIGURED, not the way it was written: what the clip is
            # (fps, pingpong), how it is encoded (format + its quality knobs), then where it
            # lands (save_output, prefix, versioning, numbering).
            #
            # Sockets are wired BY INDEX and `widgets_values` is a POSITIONAL array, so this
            # order is load-bearing: from here on, anything new goes at the END or every
            # saved workflow gets silently re-wired. It could be arranged freely today only
            # because the node has not left this machine yet.
            inputs=[
                # ONE input for all three. A MASK is a sequence of greyscale frames and a
                # VIDEO is a sequence with a cadence of its own, so they all encode down the
                # same road - two sockets for the same slot only made you look at the node
                # to remember which one this material goes in.
                #
                # The id stays `images` while the LABEL says `media`: renaming the id would
                # unwire the one input everybody has connected, and the label is what is
                # actually read. The old `video` socket is gone from the schema but still
                # accepted by `execute`, so a workflow saved with it wired keeps working.
                io.MultiType.Input("images", [io.Image, io.Mask, io.Video],
                                   display_name="media", optional=True,
                                   tooltip="What to encode: an IMAGE batch, a MASK, or a "
                                           "VIDEO to re-encode."),
                io.Audio.Input("audio", optional=True,
                               tooltip="Overrides the audio carried by `video`."),
                io.Float.Input("fps", default=24.0, min=0.01, max=1000.0, step=0.01),
                io.Boolean.Input("pingpong", default=False,
                                 tooltip="Play forward then backward, for a seamless loop."),
                # One DynamicCombo instead of the dozen loose widgets VHS carries: the
                # quality knobs of a format you did not pick are noise. Same pattern the
                # core's SaveVideo uses for its codec.
                io.DynamicCombo.Input(
                    "format",
                    options=[
                        io.DynamicCombo.Option("mp4 / h264", [
                            io.Float.Input("crf", default=19.0, min=0.0, max=51.0, step=1.0,
                                           tooltip="Lower is better quality and bigger."),
                            io.Combo.Input("preset", options=[
                                "medium", "veryfast", "fast", "slow", "veryslow"]),
                        ]),
                        io.DynamicCombo.Option("webm / vp9", [
                            io.Float.Input("crf", default=32.0, min=0.0, max=63.0, step=1.0),
                        ]),
                        io.DynamicCombo.Option("mov / prores", [
                            io.Combo.Input(
                                "profile", options=list(PRORES_PROFILES), default="hq",
                                tooltip="Editing codec: big files, no generation loss. "
                                        "4444 is the one that keeps an alpha channel."),
                        ]),
                        io.DynamicCombo.Option("gif", [
                            io.Int.Input("colors", default=256, min=2, max=256),
                            io.Boolean.Input("dither", default=True),
                        ]),
                        io.DynamicCombo.Option("webp", [
                            io.Int.Input("quality", default=85, min=0, max=100),
                            io.Boolean.Input("lossless", default=False),
                        ]),
                        io.DynamicCombo.Option("png sequence", [
                            io.Int.Input("padding", default=4, min=1, max=8,
                                         tooltip="Digits in the frame number: "
                                                 "shot.0001.png"),
                        ]),
                    ],
                ),
                # REORDENADO ROMPEDOR 2026-08-17 (decisión de Neko, junto con la release de
                # tracked widgets): `save_output` se movió de aquí AL FINAL, junto a
                # `labeled_copy`, para que los dos "saves" cierren la lista. Un workflow
                # guardado antes de esto carga sus `widgets_values` desplazados una
                # posición: hay que volver a añadir el nodo. A partir de aquí rige otra
                # vez la regla de siempre: lo nuevo va AL FINAL.
                io.String.Input(
                    # Project-aware out of the box: a node you just dropped should already
                    # land where the chip says. Only affects NEW nodes - a saved workflow
                    # carries its own value in `widgets_values`.
                    "filename_prefix", default="%project%/%category%/",
                    tooltip=(
                        "Relative to output/. Tokens: %project% and %category% (the active "
                        "ones, picked in the chip on this node — one click moves every NKD "
                        "node in the graph), %node% (this node's TITLE — rename the node to "
                        "SH010_comp and it lands there), %v###% (version, one digit per "
                        "hash), %res%, %fps%, %frames%, %duration%, %format%, %codec%, "
                        "%time:HH-mm-ss%, plus ComfyUI's own %date:yyyy-MM-dd% and "
                        "%Node title.widget%. Tokens work in the folder part too."
                    ),
                ),
                io.Combo.Input(
                    "versioning", options=["off", "auto (next free)", "manual"],
                    default="auto (next free)",
                    tooltip=(
                        "Adds _v001 to the name — no need to type %v###% yourself; spell "
                        "the token out only to place it elsewhere (a folder) or pad it "
                        "differently. `auto` takes the next unused version in the target "
                        "folder. Turning this on also drops ComfyUI's _0001_ counter, "
                        "which would number the same thing twice. Note that a cached graph "
                        "does not re-run, so it makes no new version — the render would be "
                        "identical; use `manual` to force one (and it overwrites, like "
                        "re-rendering a version in Nuke)."
                    ),
                ),
                io.Int.Input("version", default=1, min=1, max=99999,
                             tooltip="Used when versioning is `manual`."),
                io.Combo.Input(
                    "numbering", options=["counter", "none"], default="counter",
                    tooltip=(
                        "`counter` is ComfyUI's _0001_ suffix. `none` gives a clean name - "
                        "what you want once the version is carrying the uniqueness."
                    ),
                ),
                # NOT an Autogrow list like the timeline's `media_N`, deliberately. Autogrow
                # grows without limit and this viewer has exactly two roles - the render and
                # the thing you wipe against - so slots three and up would be dead sockets
                # the node quietly ignores. Two named inputs say which is which; a numbered
                # list would only say it in the docs.
                io.MultiType.Input(
                    "reference", [io.Image, io.Mask, io.Video], optional=True,
                    tooltip=(
                        "The 'before' for the A/B compare - a video, a batch of frames or a "
                        "mask. Wiring it beats the global NKD Reference slot: a connection "
                        "is a statement, the slot is whatever ran last."
                    ),
                ),
                io.String.Input(
                    # "NKD" and not "" since the 2026-08-17 reorder: the old "must stay
                    # empty" rule protected pre-split workflows whose widgets_values was
                    # shorter than the widget list — the reorder already obsoleted those,
                    # so the default can finally be the split pair Neko wanted. Empty
                    # still works: the prefix carries both halves again.
                    "filename", default="NKD",
                    tooltip=(
                        "Split the name from the folder: leave this EMPTY and "
                        "filename_prefix keeps carrying both, exactly as before. Fill it in "
                        "and filename_prefix becomes the folder only — so you can keep "
                        "%project%/%category% up there and change how files are named down "
                        "here without ever touching the project's directory. Same tokens "
                        "work in both."
                    ),
                ),
                # Hidden in the UI (src/video/register.ts) and written by the right-click
                # "Track widget" mark: the JSON list of [node_id, widget] pairs whose
                # values get burned into the `_labeled` review copy. An INPUT on purpose —
                # changing what is tracked must re-run the node to re-burn.
                io.String.Input("labels", default=""),
                # The two saves CLOSE the list (petición de Neko, reorden 2026-08-17):
                # se lee como "qué, cómo se llama, y al final si se guarda".
                io.Boolean.Input("save_output", default=True,
                                 display_name="save output",
                                 tooltip="Off writes the render to temp/ — a preview you "
                                         "can discard."),
                # Only VISIBLE while something is tracked (src/labels.ts): with no marks
                # there is nothing to burn and a dead knob would just raise the question.
                # An INPUT, not viewer state: it decides which files get written.
                io.Boolean.Input(
                    "labeled_copy", default=True,
                    display_name="save with labels",
                    tooltip="Also write <name>_labeled.mp4 with the tracked widget "
                            "values burned in. Off keeps the marks but skips the file. "
                            "With save output off, the labeled copy still goes to "
                            "output/ — in a test run it is the file worth keeping."),
            ],
            outputs=[io.Video.Output("video"), io.String.Output("filepath")],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo, io.Hidden.unique_id],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, filename_prefix="", **kwargs):
        """Make the active project/category visible to the cache.

        `CacheKeySetInputSignature` hashes the literal of every non-link input, and the
        active project is NOT an input - it lives on the server. So without this, picking a
        different project and hitting run would leave the signature untouched: ComfyUI
        would short-circuit (`execution.py:443`) and hand back the cached UI, having
        written nothing in the new folder. Silent, and it looks like the chip is broken.

        What this returns is ADDED to the signature, never replaces it, which is exactly
        what is wanted here. Returns None when the prefix uses neither token, so a graph
        that pins its own path never re-renders because of a chip nobody touched.
        """
        if not nkd_projects.uses_tokens(str(filename_prefix or "")):
            return None
        return nkd_projects.signature()

    @classmethod
    def _node_title(cls) -> str:
        """The node's TITLE, which is the naming field.

        Rename the node to `SH010_comp` and `%node%` picks it up - a rename instead of a
        taxonomy of shot/task/project widgets that nobody would fill in.

        The title only exists in the frontend, so it arrives inside `extra_pnginfo.workflow`
        rather than as a hidden of its own. Two things to know about that:

        - LiteGraph OMITS `title` when it still equals the node's default, so an un-renamed
          node has no title in the workflow at all. Verified live: a renamed node serialises
          `"title": "SH010_comp"`, an untouched one serialises nothing.
        - The fallback is therefore a constant, NOT the node id: `video/73/v073_...` is not
          a name anyone wants, and the default title itself is no better - it carries an
          emoji and spaces. Two un-renamed viewers do share a folder, which is the correct
          nudge: renaming is the whole mechanism.

        `cls.hidden` is None when `execute` is called directly, as the tests do.
        """
        fallback = "NKD"
        hidden = cls.hidden
        if hidden is None or hidden.unique_id is None:
            return fallback
        node_id = str(hidden.unique_id)
        try:
            for node in (hidden.extra_pnginfo or {})["workflow"]["nodes"]:
                if str(node.get("id")) == node_id:
                    title = str(node.get("title") or "").strip()
                    # Sanitised the same way the core sanitises a substituted widget value,
                    # so a renamed node can never inject a path separator.
                    return re.sub(r'[/?<>\\:*|"\x00-\x1f\x7f]', "_", title) or fallback
        except (KeyError, TypeError, AttributeError):
            pass
        return fallback

    @classmethod
    def _resolve_prefix(cls, filename_prefix, folder, versioning, version,
                        key, spec, fps, images, filename="") -> tuple[str, int | None]:
        """Render-time tokens, then the version. Returns (prefix, version used).

        `naming` is deliberately absent: the preset was already written into
        `filename_prefix` by the frontend's context-menu templates, which is also where
        `%date:...%` gets expanded.

        `filename` splits the name off the folder, and is OPT-IN: empty means
        `filename_prefix` still carries both, which is what every workflow saved before this
        existed says. Treating the prefix as folder-only unconditionally would quietly start
        writing `video/SH010/<name>` for anyone whose prefix was `video/SH010` - a changed
        path with no error to notice it by.
        """
        joined = filename_prefix
        if str(filename).strip():
            joined = f"{filename_prefix.rstrip('/')}/{str(filename).strip().lstrip('/')}"
        prefix = resolve_tokens(joined, {
            "fps": f"{fps:g}",
            "frames": len(images),
            "duration": f"{len(images) / max(fps, 1e-6):.2f}",
            "res": f"{int(images.shape[2])}x{int(images.shape[1])}",
            "width": int(images.shape[2]),
            "height": int(images.shape[1]),
            "format": spec["ext"],
            "codec": key.split("/")[-1].strip(),
            "node": cls._node_title(),
            **nkd_projects.tokens(),
        })
        if versioning != "off" and not has_version(prefix):
            # Turning versioning ON is the whole statement; having to also type `_v%v###%`
            # is asking for the same thing twice. Appended to the FILE NAME, which is where
            # Nuke puts it (`final_comp_v01.####.exr`) - putting it on a folder would be a
            # layout decision the user did not make. Spell out the token yourself when you
            # want it somewhere else, or padded differently.
            prefix = f"{prefix}_v%v{'#' * DEFAULT_VERSION_PAD}%"
        if versioning == "off":
            # A template carrying %v###% with versioning off would otherwise write the token
            # into the filename verbatim, which is never what anyone meant.
            return apply_version(prefix, version), None
        used = (version if versioning == "manual"
                else next_version(folder, prefix, version_pad(prefix)))
        return apply_version(prefix, used), used

    @classmethod
    def _reference_view(cls, reference, node_key: str, fps: float) -> dict | None:
        """Turn the wired reference into a file the browser can seek, and say where it is.

        Cached on tensor IDENTITY exactly like the main render (`reusable_render`): the
        reference is typically the same clip run after run, and bumping a version must not
        cost a second encode any more than it costs a first one.

        A VIDEO is already a file, so it goes through `save_to`, which REMUXES rather than
        re-encodes whenever the source is already h264/mp4 - the common case.
        """
        if reference is None:
            return None
        key = f"{node_key}:ref"
        settings = (round(float(fps), 6),)
        reuse = reusable_render(key, reference, None, settings, "mp4")
        if reuse:
            return _view_item(reuse)

        is_video = not isinstance(reference, torch.Tensor)
        if is_video:
            width, height = reference.get_dimensions()
        else:
            frames, _, _ = _decompose(reference)
            width, height = int(frames.shape[2]), int(frames.shape[1])
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            REFERENCE_PREFIX, folder_paths.get_temp_directory(), width, height)
        os.makedirs(full_folder, exist_ok=True)
        path = os.path.join(full_folder, f"{filename}_{counter:05}_.mp4")

        if is_video:
            reference.save_to(path, format=Types.VideoContainer.MP4)
        else:
            # No audio: the reference is muted in the viewer either way - the mix you judge
            # is the current render's.
            encode_video(frames, path, FORMATS["mp4 / h264"], fps, REFERENCE_CRF,
                         "veryfast", None, None, None)
        remember_render(key, reference, None, settings, "mp4", path)
        return _view_item(path)

    @classmethod
    def execute(cls, images=None, video=None, audio=None, fps=24.0, format=None,
                filename_prefix="video/NKD", save_output=True, pingpong=False,
                versioning="off", version=1, numbering="counter", reference=None,
                filename="", labels="", labeled_copy=True):
        key = (format or {}).get("format", "mp4 / h264")
        spec = FORMATS[key]

        # `video` is the socket this node used to have. It is no longer in the schema, but a
        # workflow saved while it was wired still sends it, and dropping the argument would
        # turn that into a hard error on load.
        media = images if images is not None else video
        if media is None:
            raise ValueError("😺NKD Video Viewer needs something wired into `media`.")
        # Captured BEFORE anything derives from it: the identity that answers "same render
        # as last time?" is the object the upstream node handed us, and both a MASK and a
        # VIDEO are about to be rebuilt into frames - a fresh tensor every run, which would
        # never match itself.
        src_images = media

        # A VIDEO has to be decomposed anyway to be re-encoded, and that is exactly what the
        # core's GetVideoComponents does. It is also the only one of the three with a
        # cadence of its own, so it is the only one that overrides the `fps` widget; its
        # audio only stands in when nothing was wired into `audio`.
        images, media_audio, media_fps = _decompose(media)
        if media_fps is not None:
            fps = media_fps
            if audio is None:
                audio = media_audio

        src_audio = audio.get("waveform") if isinstance(audio, dict) else None
        # Everything that changes the BYTES. Destination settings (filename_prefix,
        # versioning, version, numbering, save_output) are deliberately absent - that is the
        # whole point: they move the file, they do not re-render it.
        settings = (round(float(fps), 6), bool(pingpong), json.dumps(format, sort_keys=True,
                                                                    default=str))

        if pingpong and len(images) > 2:
            # Drop the shared end frames, or the loop stutters on a doubled first and last.
            images = torch.cat([images, torch.flip(images[1:-1], dims=[0])])

        folder = (folder_paths.get_output_directory() if save_output
                  else folder_paths.get_temp_directory())

        # Labels resolved EARLY because they steer the versioning below. The pass index
        # is counted even when labels are off, so a mid-queue toggle cannot desync it —
        # the executor maps list items sequentially and in order, so our own call count
        # IS this run's position in the list.
        node_key = str(cls.hidden.unique_id) if cls.hidden is not None else "-"
        counts = _pass_counts()
        pass_index = counts.get(node_key, 0)
        counts[node_key] = pass_index + 1
        lines = (label_lines(labels, cls.hidden.prompt if cls.hidden else None,
                             pass_index)
                 if labeled_copy else [])

        # Where the VERSION is claimed. With save_output off the clean render goes to
        # temp — which ComfyUI empties — but the labeled copy still lands in output/,
        # next to the history. Scanning temp there restarts at v001 every session and
        # names the labeled copy over versions that already exist (reported by Neko,
        # 2026-08-18): the version must be claimed where a file of this run actually
        # PERSISTS.
        version_root = folder
        if not save_output and lines:
            version_root = folder_paths.get_output_directory()
        prefix, used_version = cls._resolve_prefix(
            filename_prefix, version_root, versioning, version, key, spec, fps, images,
            filename)

        # Still through the core helper: it is the authority on containment (it refuses any
        # path escaping the output folder, folder_paths.py:552) and it creates the subfolder.
        # `base`, not `filename`: that is now an INPUT, and shadowing it here would make
        # the split silently do nothing.
        full_folder, base, counter, subfolder, _ = folder_paths.get_save_image_path(
            prefix, folder, images.shape[2], images.shape[1])
        os.makedirs(full_folder, exist_ok=True)
        # `none` drops ComfyUI's _0001_ (4 digits since 2026-08-17, Neko's ask): once a version carries the uniqueness the counter
        # is just noise on a name you are about to drag into an edit.
        #
        # Versioning forces it, because the two together number the same thing twice
        # (`NKD_v001_0001_.mp4`). With `auto` the counter would never even leave 0001,
        # since every run lands in a fresh version. The consequence to know: re-running a
        # `manual` version OVERWRITES it - which is exactly what re-rendering v003 does in
        # Nuke, and is the point of pinning a version by hand.
        versioned = used_version is not None
        stem = base if (numbering == "none" or versioned) else f"{base}_{counter:04}_"
        # A PNG sequence is a FOLDER of files, so it gets one of its own rather than
        # scattering a few hundred frames next to whatever else lives there.
        seq_dir = os.path.join(full_folder, stem) if spec["ext"] == "png" else None
        file = f"{stem}.{spec['ext']}"
        path = seq_dir if seq_dir else os.path.join(full_folder, file)

        metadata = None
        if not args.disable_metadata:
            meta = dict(cls.hidden.extra_pnginfo or {}) if cls.hidden else {}
            if cls.hidden and cls.hidden.prompt is not None:
                meta["prompt"] = cls.hidden.prompt
            metadata = meta or None

        # Same bytes as last time? Copy them. Bumping a version must not cost a re-encode.
        # A sequence is a directory, so `copy2` cannot stand in for the encode; copytree can,
        # but only onto a path that does not exist yet.
        reuse = reusable_render(node_key, src_images, src_audio, settings, spec["ext"])
        same_place = reuse and os.path.abspath(reuse) == os.path.abspath(path)
        opts = format or {}
        if reuse and not same_place:
            if seq_dir:
                shutil.copytree(reuse, path, dirs_exist_ok=True)
            else:
                shutil.copy2(reuse, path)
        elif not reuse:
            pbar = comfy.utils.ProgressBar(len(images))
            if seq_dir:
                encode_png_sequence(images, seq_dir, stem,
                                    int(opts.get("padding", 4)), pbar)
            elif spec["vcodec"]:
                encode_video(images, path, spec, fps, opts.get("crf", 19.0),
                             opts.get("preset"), audio, metadata, pbar,
                             profile=opts.get("profile"))
            elif spec["ext"] == "webp":
                encode_webp(images, path, fps, int(opts.get("quality", 85)),
                            bool(opts.get("lossless", False)), pbar)
            else:
                encode_gif(images, path, fps, int(opts.get("colors", 256)),
                           bool(opts.get("dither", True)), pbar)
        remember_render(node_key, src_images, src_audio, settings, spec["ext"], path)

        # The `_labeled` review copy: the same frames with the tracked widget values
        # burned in, written NEXT TO the clean render so a folder of takes says what each
        # one was. Always h264/mp4 whatever the main format is — its one job is being
        # skimmable in a file browser and playable in the viewer, and a ProRes review copy
        # would double gigabytes to say a number. The clean render, `filepath` and the
        # download button never change.
        labeled_file = None
        if lines:
            l_folder, l_sub, l_stem = full_folder, subfolder, stem
            if not save_output:
                # Tests mode (Neko's ask): save_output off makes the clean render a
                # discardable temp preview, but a labeled copy you asked for IS the thing
                # worth keeping — so it goes to output/ anyway. Its own
                # get_save_image_path call: the temp folder's counter would collide with
                # whatever already accumulated in output/ across sessions.
                out_root = folder_paths.get_output_directory()
                f2, base2, counter2, sub2, _ = folder_paths.get_save_image_path(
                    prefix, out_root, images.shape[2], images.shape[1])
                os.makedirs(f2, exist_ok=True)
                l_folder, l_sub = f2, sub2
                l_stem = (base2 if (numbering == "none" or versioned)
                          else f"{base2}_{counter2:04}_")
            labeled_file = f"{l_stem}_labeled.mp4"
            labeled_path = os.path.join(l_folder, labeled_file)
            lkey = f"{node_key}:labeled"
            # The label TEXT is part of the identity: same frames with different values
            # tracked is a different burn.
            lsettings = settings + ("\n".join(lines),)
            reuse_l = reusable_render(lkey, src_images, src_audio, lsettings, "mp4")
            if reuse_l and os.path.abspath(reuse_l) != os.path.abspath(labeled_path):
                shutil.copy2(reuse_l, labeled_path)
            elif not reuse_l:
                encode_video(burn_labels(images, lines), labeled_path,
                             FORMATS["mp4 / h264"], fps, 19.0, "veryfast", audio,
                             metadata, comfy.utils.ProgressBar(len(images)))
            remember_render(lkey, src_images, src_audio, lsettings, "mp4", labeled_path)

        # A fallback still, for anything the browser cannot open.
        preview = spec["preview"]
        poster_file = None
        if spec["poster"]:
            poster_file = f"{stem}.poster.png"
            write_poster(images, os.path.join(
                seq_dir if seq_dir else full_folder, poster_file))
            if seq_dir:
                poster_file = f"{stem}/{poster_file}"

        result = {
            "filename": file,
            "subfolder": subfolder,
            "type": "output" if save_output else "temp",
        }
        info = {
            "fps": fps,
            "frame_count": len(images),
            "width": int(images.shape[2]),
            "height": int(images.shape[1]),
            "preview": preview,
            # The viewer asks canPlayType about this and falls back to the poster if the
            # answer is no. Only the browser can settle it — see FORMATS.
            "mime": spec["mime"],
            "poster": poster_file,
            "format": key,
            "size": _tree_size(path),
            "path": path,
            "version": used_version,
            # None when nothing is wired, and the viewer falls back to the global slot.
            "reference": cls._reference_view(reference, node_key, fps),
            # The review copy with the tracked values burned in, when any are tracked.
            # ALWAYS type "output": with save_output off it is deliberately redirected
            # there — the labeled copy is the artefact a test run exists to keep.
            "labeled": ({"filename": labeled_file, "subfolder": l_sub,
                         "type": "output"}
                        if labeled_file else None),
        }
        out = InputImpl.VideoFromComponents(
            Types.VideoComponents(images=images, audio=audio, frame_rate=Fraction(fps)))
        return io.NodeOutput(out, path, ui=NKDVideoUI(result, info))
