# ComfyUI NKD Preview Tools

A small set of preview and masking tools for [ComfyUI](https://github.com/comfyanonymous/ComfyUI):

- **NKD Popup Preview** — preview generated images in a persistent floating popup window, ideal for multi-monitor setups.
- **NKD Mask Painter** — paint a mask on top of any procedural image and pipe both the image and the mask downstream. Drop-in replacement for Impact Pack's Preview Bridge with a few extras.


https://github.com/user-attachments/assets/e52f40df-36a2-4027-8f7b-1e987ed2615f


## 🌟 Features

### NKD Popup Preview
- **Floating Image Preview**: Automatically opens a popup window showing the current output image during execution.
- **Multi-Monitor Support**: Drag the preview popup to any monitor you prefer.
- **Fullscreen Mode**: Maximize the popup to preview images without any UI distractions.
- **Unobtrusive**: Cleanly integrates into your workflow without taking up space on your main ComfyUI canvas.

### NKD Mask Painter
- **Bridge node**: accepts any `IMAGE` upstream — no need to duplicate `Load Image` to paint a mask.
- **Native mask editor integration**: opens the same painting UI as Preview Bridge / Load Image.
- **Three outputs**: `IMAGE` (passthrough), `MASK` and `MASK (inverted)`.
- **Optional `mask` input**: feed any mask from upstream as a starting point — it is fused into the editor canvas so you can refine it by adding or erasing parts. All blend modes only act when the upstream mask content actually changes, so a noisy queue never disturbs your edits. The `mask_input_mode` combo uses VFX/compositing vocabulary:
  - `Use as start` (default): import only if the node has no painted mask yet. After that, your manual edits stick even if the upstream mask changes.
  - `Replace`: overwrite your painted mask with upstream every time it changes.
  - `Add`: union — adds the upstream mask to whatever you painted.
  - `Subtract`: removes the upstream mask from yours. Useful for excluding regions marked by upstream.
  - `Intersect`: keeps only the area where painted and upstream masks overlap.
  - `Disconnected`: input connected but ignored.
- **Persistent across restarts**: painted masks are mirrored to `input/nkd_masks/` so they survive temp cleanup and ComfyUI restarts.
- **Edit / Clear / Reseed** button row:
  - `Edit` opens the native mask editor.
  - `Clear` wipes the painted mask and refreshes the node preview in place — no requeue needed.
  - `Reseed` arms the node to re-apply the current `mask_input_mode` operation against the upstream mask on the next Run (useful when you want to re-blend without changing upstream).
- **Visual feedback**: the node turns green when it carries a non-empty mask.
- **`on_image_change`** combo: choose `clear_mask` (default) to wipe the mask when the upstream image changes, or `keep_mask` to preserve it.
- **One mask per node**: instantiate multiple Mask Painter nodes from the same image to paint independent masks.

## 🛠️ Installation

### Method 1: Git Clone (Recommended)
1. Go to your ComfyUI `custom_nodes` folder.
2. Open a terminal or command prompt in that folder and run:
   ```bash
   git clone https://github.com/Nekodificador/ComfyUI-NKD-Preview-Tools.git
   ```
3. Restart ComfyUI.

### Method 2: Download ZIP
1. Click the **Code** button on this repository in GitHub, then select **Download ZIP**.
2. Extract the downloaded folder and place it directly inside your `ComfyUI/custom_nodes/` directory.
3. Restart ComfyUI.

## 💡 Usage

### NKD Popup Preview

1. Open your ComfyUI workspace.
2. Double-click on the canvas to open the node search box, or right-click to find the node menu.
3. Add the node under **`NKD Nodes/Preview` -> `NKD Popup Preview`**.
4. Connect any valid `IMAGE` output (for example, from a *VAE Decode* node) to the `image` input socket.
5. Click **Queue Prompt**. The pop-up window will open automatically and display the generated image.

### NKD Mask Painter

1. Add the node under **`NKD Nodes/Masking` -> `NKD Mask Painter`**.
2. Connect any `IMAGE` source (procedural or `Load Image`) to the `images` input.
3. Click **Queue Prompt** once so the node loads the image.
4. Click **Edit** to open the native mask editor. Paint, then **Save & Close**.
5. Click **Queue Prompt** again — `MASK` and `MASK (inverted)` are now populated.
6. The node preview shows the image with the painted area as transparency (the same way Preview Bridge does it).
7. Click **Clear** at any time to wipe the mask (refreshes in place, no requeue).
8. With a `mask` connected upstream, click **Reseed** then **Run** to re-apply the seed/add/subtract operation without changing upstream.

For multiple independent masks of the same image, instantiate the Mask Painter node several times.

## 📝 Troubleshooting

- **Pop-up Blocker** (Popup Preview): Your web browser might block the window from opening the first time you use this node. If this happens, please check your browser's address bar and make sure to **allow pop-ups** for the URL or localhost where ComfyUI is running.
- **Mask not appearing in preview** (Mask Painter): the node thumbnail uses transparency (checkerboard) to represent the mask. If you only see the RGB image, the mask is empty.
- **Mask seems to disappear after a restart** (Mask Painter): masks are restored from `input/nkd_masks/<node_id>_mask.png` on the first queue after restart. Hit **Queue Prompt** to refresh.
