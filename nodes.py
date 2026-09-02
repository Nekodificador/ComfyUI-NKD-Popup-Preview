import os
import shutil
import subprocess
import sys

import folder_paths
import numpy as np
import torch
from PIL import Image as PILImage
from aiohttp import web
from server import PromptServer

from comfy_api.latest import ComfyExtension, Types, io, ui
from comfy_api.latest._io import _UIOutput
from typing_extensions import override

# Import a nivel de MÓDULO, no dentro de get_node_list: nkd_timeline registra su ruta
# aiohttp al importarse, y get_node_list se ejecuta cuando la tabla de rutas ya está
# cerrada — la ruta se perdía en silencio.
from . import nkd_projects, nkd_video  # noqa: E402
from .nkd_audio_timeline import NKDAudioTimeline  # noqa: E402
from .nkd_timeline import NKDFreezeFrames, NKDTimeline  # noqa: E402
from .nkd_video import NKDVideoViewer  # noqa: E402


# The workflow's active reference slots ("wireless" compare sources): one IMAGE, one MASK
# and one VIDEO, independent of each other, each `(abs_path, item_dict)` where item_dict is
# the {filename, subfolder, type} the /view endpoint wants. Empty until something is
# captured; within a slot, the last NKDReferenceImage to execute wins.
#
# **Parked on the server singleton, NOT in module globals, and that is load-bearing.**
# Hot-reloading a custom node (comfyui_lg_hotreload and friends do `del sys.modules[...]`
# then re-import) builds a NEW module object with fresh globals. The node that executes
# then writes into the new module's `_ref_video`, while the aiohttp route - registered at
# the FIRST import and never re-registered, since the route table is closed by then - keeps
# reading the OLD module's, which stays None forever.
#
# Diagnosed live rather than guessed: the reference mp4 was sitting in temp/ with a
# timestamp newer than the render, and `/nkd/ref/get_video` still answered "not set".
# `PromptServer.instance` outlives every reload, so both halves meet on the same dict.
_REF_PREFIX = "NKDReferenceImage/NRI-"
_REF_MASK_PREFIX = "NKDReferenceImage/NRM-"
_REF_VIDEO_PREFIX = "NKDReferenceImage/NRV-"


def _slots() -> dict:
    """The reference slots, on an object that survives a module reload."""
    slots = getattr(PromptServer.instance, "_nkd_ref_slots", None)
    if slots is None:
        slots = {}
        PromptServer.instance._nkd_ref_slots = slots
    return slots



# ── Reference image helpers ───────────────────────────────────────────────────

def _save_reference_png(image_tensor: torch.Tensor) -> tuple[str, dict, int, int]:
    """Write the first frame of an IMAGE tensor as an RGB PNG into temp/.
    Returns (abs_path, item_dict, W, H).
    """
    img_np = np.clip(255.0 * image_tensor[0].cpu().numpy(), 0, 255).astype(np.uint8)
    H, W = img_np.shape[:2]
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        _REF_PREFIX, folder_paths.get_temp_directory(), W, H
    )
    os.makedirs(full_output_folder, exist_ok=True)
    file = f"{filename}_{counter:05}_.png"
    path = os.path.join(full_output_folder, file)
    PILImage.fromarray(img_np, "RGB").save(path, compress_level=4)
    item = {"filename": file, "subfolder": subfolder, "type": "temp"}
    return path, item, W, H


def _save_reference_mask_png(mask_tensor: torch.Tensor) -> tuple[str, dict, int, int]:
    """Write the first frame of a MASK tensor (B,H,W) as a grayscale L PNG into
    temp/. White (255) = masked region; the viewer tints it client-side.
    Returns (abs_path, item_dict, W, H).
    """
    mask_np = np.clip(255.0 * mask_tensor[0].cpu().numpy(), 0, 255).astype(np.uint8)
    H, W = mask_np.shape[:2]
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        _REF_MASK_PREFIX, folder_paths.get_temp_directory(), W, H
    )
    os.makedirs(full_output_folder, exist_ok=True)
    file = f"{filename}_{counter:05}_.png"
    path = os.path.join(full_output_folder, file)
    PILImage.fromarray(mask_np, "L").save(path, compress_level=4)
    item = {"filename": file, "subfolder": subfolder, "type": "temp"}
    return path, item, W, H


def _save_reference_video(video) -> tuple[str, dict]:
    """Write a VIDEO input into temp/ as mp4 and return (abs_path, item_dict).

    Through the core's `save_to`, which REMUXES instead of re-encoding whenever the source
    is already h264/mp4 - the common case, since that is what this pack writes.
    """
    width, height = video.get_dimensions()
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        _REF_VIDEO_PREFIX, folder_paths.get_temp_directory(), width, height
    )
    os.makedirs(full_output_folder, exist_ok=True)
    file = f"{filename}_{counter:05}_.mp4"
    path = os.path.join(full_output_folder, file)
    video.save_to(path, format=Types.VideoContainer.MP4)
    return path, {"filename": file, "subfolder": subfolder, "type": "temp"}


# ── REST endpoints ────────────────────────────────────────────────────────────

routes = PromptServer.instance.routes

def _serve_slot(kind: str, label: str) -> web.Response:
    """One slot's /view item, or 404 saying which half is missing."""
    entry = _slots().get(kind)
    if entry is None:
        return web.Response(status=404, text=f"No reference {label} set")
    path, item = entry
    if not os.path.isfile(path):
        return web.Response(status=404, text=f"Reference {label} file missing")
    return web.json_response(item)


@routes.get("/nkd/ref/get")
async def _nkd_ref_get(request: web.Request) -> web.Response:
    return _serve_slot("image", "image")


@routes.get("/nkd/ref/get_mask")
async def _nkd_ref_get_mask(request: web.Request) -> web.Response:
    return _serve_slot("mask", "mask")


@routes.get("/nkd/ref/get_video")
async def _nkd_ref_get_video(request: web.Request) -> web.Response:
    return _serve_slot("video", "video")


@routes.post("/nkd/ref/set_video")
async def _nkd_ref_set_video(request: web.Request) -> web.Response:
    """Adopt an already-rendered file as the reference, by /view item.

    This is what makes the compare loop usable without wiring anything: run, press "set as
    reference" in the viewer, change a parameter, run again, wipe between them. Going
    through a Reference node instead would mean re-queueing the graph just to nominate the
    thing you are already looking at.

    Resolution is as strict as the core's /view: the file must resolve inside one of
    ComfyUI's own directories, so a crafted request cannot point this at the filesystem.
    """
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="Expected JSON")
    filename = str(body.get("filename") or "")
    subfolder = str(body.get("subfolder") or "")
    kind = str(body.get("type") or "output")
    if not filename or kind not in ("output", "temp", "input"):
        return web.Response(status=400, text="Bad reference")

    root = {"output": folder_paths.get_output_directory,
            "temp": folder_paths.get_temp_directory,
            "input": folder_paths.get_input_directory}[kind]()
    path = os.path.abspath(os.path.join(root, subfolder, filename))
    if not folder_paths.is_within_directory(root, path) or not os.path.isfile(path):
        return web.Response(status=403, text="Outside the allowed directories")

    _slots()["video"] = (path, {"filename": filename, "subfolder": subfolder,
                                "type": kind})
    return web.json_response({"ok": True})


# ── Projects, "open folder", "save here" ──────────────────────────────────────

def _resolve_view(body: dict) -> tuple[str, str, str, str]:
    """`(abs_path, filename, subfolder, kind)` for a /view item, or raise.

    The containment rule is the core's: resolve inside one of ComfyUI's own directories or
    do not resolve at all. Same shape as `_nkd_ref_set_video` above - one helper now that
    three routes need it.
    """
    filename = str(body.get("filename") or "")
    subfolder = str(body.get("subfolder") or "")
    kind = str(body.get("type") or "output")
    if not filename or kind not in ("output", "temp", "input"):
        raise ValueError("Bad file reference")
    root = {"output": folder_paths.get_output_directory,
            "temp": folder_paths.get_temp_directory,
            "input": folder_paths.get_input_directory}[kind]()
    path = os.path.abspath(os.path.join(root, subfolder, filename))
    if not folder_paths.is_within_directory(root, path) or not os.path.isfile(path):
        raise PermissionError("Outside the allowed directories")
    return path, filename, subfolder, kind


def _is_local(request: web.Request) -> bool:
    """Is the caller on the same machine as the server?

    Revealing a folder acts on the SERVER's desktop, so it only makes sense - and is only
    safe - when the browser and the server are the same box. From a LAN client or a cloud
    instance the button would either do nothing visible or pop a window on someone else's
    screen, so the route says "not available" and the frontend never draws it.
    """
    return (request.remote or "") in ("127.0.0.1", "::1", "localhost")


@routes.get("/nkd/open")
async def _nkd_open(request: web.Request) -> web.Response:
    """No args: whether revealing is possible at all. With a /view item: reveal it."""
    local = _is_local(request)
    if not request.query.get("filename"):
        return web.json_response({"available": local})
    if not local:
        return web.Response(status=403, text="Only available on the ComfyUI machine")
    try:
        path, _, _, _ = _resolve_view(dict(request.query))
    except ValueError as exc:
        return web.Response(status=400, text=str(exc))
    except PermissionError as exc:
        return web.Response(status=403, text=str(exc))

    folder = path if os.path.isdir(path) else os.path.dirname(path)
    try:
        if sys.platform == "win32":
            # /select, highlights the file itself. The path has to be quoted-by-argument,
            # not shell-escaped: os.startfile cannot select, so explorer it is.
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
        else:
            # ponytail: xdg-open takes a directory, so Linux opens the folder without
            # highlighting the file. dbus FileManager1.ShowItems would select it; not worth
            # a dbus dependency until someone asks.
            subprocess.Popen(["xdg-open", folder])
    except Exception as exc:
        return web.Response(status=500, text=f"Could not open the folder: {exc}")
    return web.json_response({"ok": True, "folder": folder})


@routes.get("/nkd/project/config")
async def _nkd_project_config(request: web.Request) -> web.Response:
    return web.json_response(nkd_projects.load())


@routes.post("/nkd/project/active")
async def _nkd_project_active(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="Expected JSON")
    return web.json_response(
        nkd_projects.set_active(body.get("project"), body.get("category")))


# NOT `POST /nkd/project/config`, and this is a trap worth knowing about: hot reloaders
# re-sync routes by REPLACING handlers, and comfyui_lg_hotreload matches them by PATH ONLY,
# never by method (`__init__.py:352`). With a GET and a POST sharing one path, they share one
# aiohttp resource, so re-importing this module copied the POST handler over the GET one -
# after which a GET answered "Expected JSON", because it really was running the saver.
# Survives a restart, breaks again on the next reload. So: one path, one method.
@routes.post("/nkd/project/save")
async def _nkd_project_save(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="Expected JSON")
    return web.json_response(nkd_projects.save(body))


@routes.post("/nkd/save")
async def _nkd_save(request: web.Request) -> web.Response:
    """Copy a preview out of temp/ into the active project's folder.

    The Popup Preview's "save" used to be an `<a download>` - the browser's Downloads
    folder, which is the one place a project system cannot reach. This puts the file where
    the render would have gone.

    Copy, never re-encode: the bytes already exist and are already what the user is looking
    at. `%project%`/`%category%` are resolved here; `%node%` and `%date:...%` arrive already
    expanded, because only the frontend knows the node's title and the core expands its own
    date token at submit time.
    """
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="Expected JSON")
    try:
        src, filename, _, _ = _resolve_view(body)
    except ValueError as exc:
        return web.Response(status=400, text=str(exc))
    except PermissionError as exc:
        return web.Response(status=403, text=str(exc))

    cfg = nkd_projects.load()
    prefix = nkd_video.resolve_tokens(
        str(body.get("prefix") or cfg["image_prefix"]), nkd_projects.tokens())
    ext = os.path.splitext(filename)[1] or ".png"
    root = folder_paths.get_output_directory()
    # Versioning matches the video viewer (off/auto/manual) so this copy no longer just
    # stamps a bare counter — the frontend chip menu picks the mode.
    full_folder, out_name, subfolder = nkd_video.save_target(
        prefix, root, ext,
        str(body.get("versioning") or "off"), int(body.get("version") or 1))
    os.makedirs(full_folder, exist_ok=True)
    shutil.copy2(src, os.path.join(full_folder, out_name))
    return web.json_response({"filename": out_name, "subfolder": subfolder, "type": "output",
                              "path": os.path.join(full_folder, out_name)})


class NKDReferenceImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDReferenceImage",
            display_name="😺NKD Reference",
            category="😺NKD Nodes/Preview",
            description=(
                "Captures the connected IMAGE, MASK or VIDEO as the workflow's active "
                "reference. Any NKD Popup Preview node can then press-and-hold to "
                "flash a reference image over the current preview, or overlay a "
                "reference mask (tinted, adjustable) on top of it; NKD Video Viewer "
                "wipes between its own render and a reference video. Image, mask and "
                "video are separate slots — wire several Reference nodes to have more "
                "than one. Within each slot the last executed node wins."
            ),
            # MultiType accepts IMAGE, MASK or VIDEO on one wildcard input, disambiguated
            # at runtime — same pattern as KJNodes' "Preview Image Or Mask" and Comfy's
            # official Resize Image/Mask.
            inputs=[io.MultiType.Input("image", [io.Image, io.Mask, io.Video])],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
        )

    @classmethod
    def fingerprint_inputs(cls, image):
        # not_idempotent alone wasn't reliably forcing re-execution for this
        # output-only node, so we make the cache invalidate every time.
        return float("nan")

    @classmethod
    def execute(cls, image):
        # A VIDEO is not a tensor at all. Detected by DUCK TYPING rather than by class, so
        # any VideoInput implementation works — the same rule `classify` uses in
        # nkd_timeline.py.
        if not isinstance(image, torch.Tensor):
            if not (hasattr(image, "get_components") and hasattr(image, "save_to")):
                raise ValueError(
                    "😺NKD Reference got something that is not an image, mask or video.")
            _slots()["video"] = _save_reference_video(image)
            return io.NodeOutput()
        # MASK tensors are (B,H,W) → ndim 3; IMAGE tensors are (B,H,W,C) → ndim 4.
        if image.ndim == 3:
            path, item, _W, _H = _save_reference_mask_png(image)
            _slots()["mask"] = (path, item)
        else:
            path, item, _W, _H = _save_reference_png(image)
            _slots()["image"] = (path, item)
        return io.NodeOutput()


# ── NKDPopupPreviewNode ───────────────────────────────────────────────────────

class NKDPopupUI(_UIOutput):
    """PreviewImage plus this node's OWN wired reference/mask items.

    The popup viewer already flashes a reference and tints a mask, but only from the
    GLOBAL NKD Reference slot - so two viewers show the same thing. Carrying the items in
    this node's UI payload lets the frontend prefer them for THIS node, the same way the
    video viewer's wired `reference` input wins over the global slot. Nothing wired ->
    neither key is emitted and the viewer falls back to the global slot, unchanged.
    """

    def __init__(self, images_ui, ref=None, mask=None):
        self._images = images_ui
        self._ref = ref
        self._mask = mask

    def as_dict(self):
        d = dict(self._images.as_dict())   # {"images": [...]}
        if self._ref:
            d["nkd_ref"] = [self._ref]
        if self._mask:
            d["nkd_mask"] = [self._mask]
        return d


class NKDPopupPreviewNode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDPopupPreviewNode",
            display_name="😺NKD Popup Preview / Saver",
            category="😺NKD Nodes/Preview",
            description=(
                "Preview an image in a floating window on top of the browser. "
                "The window can be moved to a secondary monitor and maximised. "
                "Saves the still into the active project's folder, with an optional "
                "per-node folder/name override and off/auto versioning. Wire the optional "
                "reference/mask inputs to compare against them right here instead of a "
                "far-away NKD Reference node."
            ),
            # `reference`/`mask` are OPTIONAL and appended AFTER `image`, so a saved workflow
            # (which only ever had `image` wired at socket 0) is untouched. A wired reference
            # is flashed (press-and-hold) in the viewer; a wired mask is a tinted overlay.
            inputs=[
                io.Image.Input("image"),
                io.Image.Input(
                    "reference", optional=True,
                    tooltip="Optional reference image — hold in the viewer to flash it over "
                            "this preview (A/B). Wins over the global NKD Reference slot."),
                io.Mask.Input(
                    "mask", optional=True,
                    tooltip="Optional mask — shown as a tinted overlay in the viewer. "
                            "Wins over the global NKD Reference mask."),
            ],
            # Pass-through so the preview can sit inline in a chain instead of dangling.
            outputs=[io.Image.Output(display_name="image", tooltip="The input image, untouched.")],
            is_output_node=True,
            not_idempotent=True,
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, image, reference=None, mask=None):
        ref_item = _save_reference_png(reference)[1] if reference is not None else None
        mask_item = _save_reference_mask_png(mask)[1] if mask is not None else None
        return io.NodeOutput(
            image, ui=NKDPopupUI(ui.PreviewImage(image, cls=cls), ref_item, mask_item))


# ── Extension ─────────────────────────────────────────────────────────────────

class NKDExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKDPopupPreviewNode, NKDReferenceImage, NKDTimeline,
                NKDAudioTimeline, NKDFreezeFrames, NKDVideoViewer]

async def comfy_entrypoint() -> NKDExtension:
    return NKDExtension()
