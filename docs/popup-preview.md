# 😺NKD Popup Preview

- **Floating Image Preview**: Automatically opens a popup window showing the current output image during execution.
- **Multi-Monitor Support**: Drag the preview popup to any monitor you prefer.
- **Fullscreen Mode**: Maximize the popup to preview images without any UI distractions.
- **Unobtrusive**: Cleanly integrates into your workflow without taking up space on your main ComfyUI canvas.

## Using it

1. Open your ComfyUI workspace.
2. Double-click on the canvas to open the node search box, or right-click to find the node menu.
3. Add the node under **`NKD Nodes/Preview` -> `NKD Popup Preview`**.
4. Connect any valid `IMAGE` output (for example, from a *VAE Decode* node) to the `image` input socket.
5. Click **Queue Prompt**. The pop-up window will open automatically and display the generated image.

The node also passes the input through its `image` output, untouched, so it can sit inline in a chain (e.g. between *VAE Decode* and a *Save Image*) instead of dangling off a branch.

---

[← All 😺NKD Preview Tools nodes](../README.md)
