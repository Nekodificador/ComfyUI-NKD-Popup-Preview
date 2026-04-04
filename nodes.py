from comfy_api.latest import ComfyExtension, io, ui
from typing_extensions import override
import torch


def parse_color(s: str) -> list[int]:
    """Parse a color string into a list of ints [R, G, B] or [R, G, B, A].

    Supported formats:
      - CSV integers: "255, 0, 128" or "255, 0, 128, 200"
      - CSV floats (0-1 range): "1.0, 0.0, 0.5"
      - Hex: "#FF0080" or "#FF008080"
    """
    s = s.strip()
    try:
        if "," in s:
            vals = [float(v.strip()) for v in s.split(",")]
            if all(0.0 <= v <= 1.0 for v in vals):
                return [max(0, min(255, int(v * 255))) for v in vals]
            return [max(0, min(255, int(v))) for v in vals]
        h = s.lstrip("#")
        if len(h) == 6:
            return [int(h[i : i + 2], 16) for i in (0, 2, 4)]
        if len(h) == 8:
            return [int(h[i : i + 2], 16) for i in (0, 2, 4, 6)]
    except (ValueError, IndexError):
        pass
    return [0, 0, 0]


def resize_mask_to_image(mask: torch.Tensor, image: torch.Tensor) -> torch.Tensor:
    """Resize mask [B, H, W] to match image [B, H2, W2, 3] spatial dims."""
    ih, iw = image.shape[1], image.shape[2]
    mh, mw = mask.shape[1], mask.shape[2]
    if mh != ih or mw != iw:
        mask = torch.nn.functional.interpolate(
            mask.unsqueeze(1), size=(ih, iw), mode="bilinear", align_corners=False
        ).squeeze(1)
    return mask


def make_composite(
    image: torch.Tensor,
    mask: torch.Tensor,
    opacity: float,
    color_list: list[int],
) -> torch.Tensor:
    """Alpha-blend a colored mask overlay onto an image.

    image: [B, H, W, 3] float 0-1
    mask:  [B, H, W]    float 0-1
    Returns: [B, H, W, 3] float 0-1
    """
    r, g, b = color_list[0] / 255.0, color_list[1] / 255.0, color_list[2] / 255.0
    alpha_factor = (color_list[3] / 255.0) if len(color_list) >= 4 else 1.0

    alpha = (mask * opacity * alpha_factor).unsqueeze(-1)           # [B, H, W, 1]
    color = torch.tensor([r, g, b], device=image.device).view(1, 1, 1, 3)
    return (image * (1.0 - alpha) + color * alpha).clamp(0.0, 1.0)


class NKD_PopupPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKD_PopupPreview",
            display_name="NKD Popup Preview",
            category="NKD Nodes/Preview",
            description=(
                "Preview an image or mask in a floating popup window. "
                "When both are connected, composites the mask on top of the image "
                "with configurable color and opacity. "
                "Enable pass_through to skip the preview and return the composite."
            ),
            inputs=[
                io.Float.Input(
                    "mask_opacity", default=1.0, min=0.0, max=1.0, step=0.01,
                    tooltip="Opacity of the mask color overlay on the image.",
                ),
                io.String.Input(
                    "mask_color", default="255, 0, 128",
                    tooltip=(
                        "Color for the mask overlay. "
                        "RGB (255,0,128), RGBA (255,0,128,200), or Hex (#FF0080 / #FF008080)."
                    ),
                ),
                io.Boolean.Input(
                    "pass_through", default=False,
                    tooltip=(
                        "When ON the preview is disabled and the composite is only "
                        "returned through the output, useful for video pipelines."
                    ),
                ),
                io.Image.Input("image", optional=True),
                io.Mask.Input("mask", optional=True, tooltip=(
                    "Optional mask. When connected together with an image, the viewer "
                    "gains Image / Mask / Overlay modes."
                )),
            ],
            outputs=[
                io.Image.Output("composite"),
            ],
            is_output_node=True,
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, mask_opacity, mask_color, pass_through, image=None, mask=None):
        color = parse_color(mask_color)

        if mask is not None and image is None:
            # Mask only → show as RGB grayscale.
            preview = mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])).movedim(1, -1).expand(-1, -1, -1, 3)

        elif mask is None and image is not None:
            # Image only → pass through as-is.
            preview = image

        elif mask is not None and image is not None:
            # Both → composite with configurable color/opacity.
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
            mask = mask.clamp(0.0, 1.0)
            mask = resize_mask_to_image(mask, image)

            # Harmonise batch sizes.
            b = max(image.shape[0], mask.shape[0])
            if image.shape[0] < b:
                image = image.repeat(b, 1, 1, 1)
            if mask.shape[0] < b:
                mask = mask.repeat(b, 1, 1)

            preview = make_composite(image, mask, mask_opacity, color)

        else:
            # Neither connected → small blank.
            preview = torch.zeros(1, 64, 64, 3)

        # ── pass_through: skip UI, just return composite ──
        if pass_through:
            return io.NodeOutput(preview)

        # ── Build the preview batch for the frontend ──
        if mask is not None and image is not None:
            # 3-frame batch: [composite[:1], original[:1], mask_gray[:1]]
            mask_gray = mask[:1].unsqueeze(-1).expand(-1, -1, -1, 3)
            batch = torch.cat([preview[:1], image[:1], mask_gray], dim=0)
            return io.NodeOutput(preview, ui=ui.PreviewImage(batch, cls=cls))

        # 1-frame batch (image-only, mask-only, or blank).
        return io.NodeOutput(preview, ui=ui.PreviewImage(preview[:1], cls=cls))


class NKDExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKD_PopupPreview]


async def comfy_entrypoint() -> NKDExtension:
    return NKDExtension()
