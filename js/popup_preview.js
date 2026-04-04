import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "NKD_PopupPreview";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildViewUrl(imgData) {
    const p = new URLSearchParams({
        filename: imgData.filename,
        type: imgData.type,
        subfolder: imgData.subfolder ?? "",
        t: Date.now(),
    });
    // Force absolute URL so it resolves correctly from any window context.
    return new URL(api.apiURL(`/view?${p}`), window.location.href).href;
}

/** Resolves to the natural pixel dimensions of a URL (loads it in a temp Image). */
function loadImageDimensions(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = reject;
        img.src = url;
    });
}

function viewerHtmlUrl() {
    return new URL("/extensions/ComfyUI-NKD-Popup-Preview/viewer.html", window.location.href).href;
}

// ── PopupWin ──────────────────────────────────────────────────────────────────

class PopupWin {
    constructor(nodeId) {
        this.nodeId       = String(nodeId);
        this.win          = null;
        this.compositeUrl = null;
        this.imageUrl     = null;
        this.maskUrl      = null;
        this._title       = "Preview Window";
        this._opening     = false;
        this._pipMode     = false;
    }

    setTitle(title) {
        this._title = title || "Preview Window";
        if (this.win && !this.win.closed) {
            try { this.win.document.title = this._title; } catch { /* cross-origin */ }
        }
    }

    /** Store the three URLs and push them to an open viewer window. */
    showImages(compositeUrl, imageUrl, maskUrl) {
        this.compositeUrl = compositeUrl || null;
        this.imageUrl     = imageUrl     || null;
        this.maskUrl      = maskUrl      || null;
        if (this.win && !this.win.closed) {
            this._pushUrls();
        }
    }

    /** Called from node button / context menu. */
    open() {
        if (this.win && !this.win.closed) {
            if (!this._pipMode) this.win.focus();
        } else {
            this._openViewer();
        }
    }

    async _openViewer() {
        if (this._opening) return;
        this._opening = true;
        try {
            if (window.documentPictureInPicture) {
                await this._openDirectPiP();
            } else {
                await this._openWindow();
            }
        } finally {
            this._opening = false;
        }
    }

    async _calcWindowSize() {
        let winW = 800, winH = 680;
        const sizeUrl = this.compositeUrl || this.imageUrl;
        if (sizeUrl) {
            try {
                const { w, h } = await loadImageDimensions(sizeUrl);
                const maxW = Math.round(screen.availWidth  * 0.9);
                const maxH = Math.round(screen.availHeight * 0.9);
                const s = Math.min(1, maxW / w, maxH / h);
                winW = Math.max(320, Math.round(w * s));
                winH = Math.max(240, Math.round(h * s));
            } catch { /* keep defaults */ }
        }
        return { winW, winH };
    }

    /** Primary path (Chrome 116+): open viewer.html directly inside a PiP window. */
    async _openDirectPiP() {
        const { winW, winH } = await this._calcWindowSize();

        const pipWin = await window.documentPictureInPicture.requestWindow({ width: winW, height: winH });

        this.win      = pipWin;
        this._pipMode = true;
        pipWin.addEventListener("pagehide", () => {
            this.win      = null;
            this._pipMode = false;
        });

        try {
            const html   = await fetch(viewerHtmlUrl()).then(r => r.text());
            const parser = new DOMParser();
            const parsed = parser.parseFromString(html, "text/html");

            parsed.querySelectorAll("style").forEach(s => {
                const ns = pipWin.document.createElement("style");
                ns.textContent = s.textContent;
                pipWin.document.head.appendChild(ns);
            });

            const bodyClone = parsed.body.cloneNode(true);
            bodyClone.querySelectorAll("script").forEach(s => s.remove());
            pipWin.document.body.innerHTML = bodyClone.innerHTML;

            parsed.querySelectorAll("script").forEach(s => {
                const ns = pipWin.document.createElement("script");
                ns.textContent = s.textContent;
                pipWin.document.body.appendChild(ns);
            });

            pipWin.document.title = this._title;

            // Push all three URLs and set initial mode.
            if (pipWin.window?.setUrls) {
                pipWin.window.setUrls(this.compositeUrl, this.imageUrl, this.maskUrl);
            }
            if (this.maskUrl && pipWin.window?.setViewMode) {
                pipWin.window.setViewMode("overlay");
            }
        } catch (err) {
            console.error("NKD PiP viewer load error:", err);
            pipWin.close();
        }
    }

    /** Fallback (no PiP support): open viewer.html in a regular popup window. */
    async _openWindow() {
        let winW, winH, left, top;
        try {
            const saved = JSON.parse(localStorage.getItem("nkd_preview_bounds"));
            if (saved && saved.w && saved.h) {
                winW = Math.max(320, saved.w);
                winH = Math.max(240, saved.h);
                left = saved.x || 0;
                top  = saved.y || 0;
            }
        } catch { /* ignore parsing errors */ }

        if (!winW) {
            const dims = await this._calcWindowSize();
            winW = dims.winW;
            winH = dims.winH;
            left = Math.round((screen.availWidth  - winW) / 2) + (screen.availLeft ?? 0);
            top  = Math.round((screen.availHeight - winH) / 2) + (screen.availTop  ?? 0);
        }

        const opts = `width=${winW},height=${winH},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no,scrollbars=no`;

        const qp = new URLSearchParams({
            composite: this.compositeUrl ?? "",
            image:     this.imageUrl     ?? "",
            mask:      this.maskUrl      ?? "",
            mode:      this.maskUrl ? "overlay" : "image",
            title:     this._title,
        });
        const url = `${viewerHtmlUrl()}?${qp}`;

        this.win      = window.open(url, `nkd_preview_${this.nodeId}`, opts);
        this._pipMode = false;

        if (!this.win) {
            app.extensionManager?.toast?.add?.({
                severity: "warn",
                summary: "Popup Blocked",
                detail: "Please allow popups for this site and click 'Open Viewer' on the node.",
                life: 7000,
            });
            return;
        }

        const saveState = () => {
            if (this.win && !this.win.closed) {
                localStorage.setItem("nkd_preview_bounds", JSON.stringify({
                    w: this.win.outerWidth || this.win.innerWidth,
                    h: this.win.outerHeight || this.win.innerHeight,
                    x: this.win.screenX,
                    y: this.win.screenY
                }));
            }
        };

        const saveInterval = setInterval(() => {
            if (!this.win || this.win.closed) clearInterval(saveInterval);
            else saveState();
        }, 500);

        this.win.addEventListener("beforeunload", () => {
            saveState();
            clearInterval(saveInterval);
            this.win = null;
        });
    }

    /** Push the three URLs to the viewer window. */
    _pushUrls() {
        try {
            if (!this.win || this.win.closed) return;
            if (this.win.setUrls) {
                this.win.setUrls(this.compositeUrl, this.imageUrl, this.maskUrl);
            }
        } catch {
            this.win      = null;
            this._pipMode = false;
        }
    }

    destroy() {
        if (this.win && !this.win.closed) this.win.close();
    }
}

// ── Extension ────────────────────────────────────────────────────────────────

const popups = new Map();

function getPopup(nodeId) {
    const key = String(nodeId);
    if (!popups.has(key)) popups.set(key, new PopupWin(key));
    return popups.get(key);
}

app.registerExtension({
    name: "NKD.PopupPreview",

    async setup() {
        api.addEventListener("executed", ({ detail }) => {
            if (!detail?.output?.images?.length) return;
            const node = app.graph?.getNodeById(detail.node);
            if (!node || node.comfyClass !== NODE_TYPE) return;

            const popup = getPopup(node.id);
            popup.setTitle(node.title || "Preview Window");

            const imgs = detail.output.images;

            // Decode batch by frame count:
            //  3 = [composite, original, mask]  (image + mask connected)
            //  1 = [single image]                (image-only / mask-only / blank)
            let compositeUrl, imageUrl = null, maskUrl = null;
            if (imgs.length === 3) {
                compositeUrl = buildViewUrl(imgs[0]);
                imageUrl     = buildViewUrl(imgs[1]);
                maskUrl      = buildViewUrl(imgs[2]);
            } else {
                compositeUrl = buildViewUrl(imgs[0]);
            }

            popup.showImages(compositeUrl, imageUrl, maskUrl);

            // Node thumbnail always shows the composite (first frame).
            const thumb = new Image();
            thumb.onload = () => {
                node.imgs = [thumb];
                app.graph?.setDirtyCanvas(true, false);
            };
            thumb.src = compositeUrl;
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            this.size = [240, 110];

            // Suppress the default node thumbnail triggered by onExecuted.
            this.onExecuted = function () {};

            this.addWidget("button", "\u2197 Open Viewer", null, () => {
                const p = getPopup(String(this.id));
                p.setTitle(this.title || "Preview Window");
                p.open();
            }, { serialize: false });
        };

        const origTitleChanged = nodeType.prototype.onTitleChanged;
        nodeType.prototype.onTitleChanged = function (title) {
            origTitleChanged?.apply(this, arguments);
            popups.get(String(this.id))?.setTitle(title);
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            origRemoved?.apply(this, arguments);
            const key = String(this.id);
            popups.get(key)?.destroy();
            popups.delete(key);
        };
    },

    getNodeMenuItems(node) {
        if (node.comfyClass !== NODE_TYPE) return [];
        return [
            {
                content: "\u2197 Open Viewer",
                callback: () => {
                    const p = getPopup(String(node.id));
                    p.setTitle(node.title || "Preview Window");
                    p.open();
                },
            },
        ];
    },
});
