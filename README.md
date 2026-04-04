# ComfyUI NKD Popup Preview

A custom node extension for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) that allows you to preview generated images in a persistent, floating popup window. This is especially useful for users with multi-monitor setups because the popup window can be dragged to a secondary screen and maximized for a full-screen preview.


https://github.com/user-attachments/assets/e52f40df-36a2-4027-8f7b-1e987ed2615f


## 🌟 Features

- **Floating Image Preview**: Automatically opens a popup window showing the current output image during execution.
- **Multi-Monitor Support**: Drag the preview popup to any monitor you prefer.
- **Fullscreen Mode**: Maximize the popup to preview images without any UI distractions.
- **Unobtrusive**: Cleanly integrates into your workflow without taking up space on your main ComfyUI canvas.

## 🛠️ Installation

### Method 1: Git Clone (Recommended)
1. Go to your ComfyUI `custom_nodes` folder.
2. Open a terminal or command prompt in that folder and run:
   ```bash
   git clone https://github.com/Nekodificador/ComfyUI-NKD-Popup-Preview.git
   ```
3. Restart ComfyUI.

### Method 2: Download ZIP
1. Click the **Code** button on this repository in GitHub, then select **Download ZIP**.
2. Extract the downloaded folder and place it directly inside your `ComfyUI/custom_nodes/` directory.
3. Restart ComfyUI.

## 💡 Usage

1. Open your ComfyUI workspace.
2. Double-click on the canvas to open the node search box, or right-click to find the node menu.
3. Add the node under **`NKD Nodes/Preview` -> `NKD Popup Preview`**.
4. Connect any valid `IMAGE` output (for example, from a *VAE Decode* node) to the `image` input socket.
5. Click **Queue Prompt**. The pop-up window will open automatically and display the generated image.

## 📝 Troubleshooting

- **Pop-up Blocker**: Your web browser might block the window from opening the first time you use this node. If this happens, please check your browser's address bar and make sure to **allow pop-ups** for the URL or localhost where ComfyUI is running.
