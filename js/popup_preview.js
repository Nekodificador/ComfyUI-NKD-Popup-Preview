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
        this.nodeId     = String(nodeId);
        this.win        = null;
        this.currentUrl = null;
        this._title     = "Preview Window";
        this._opening   = false;
        this._pipMode   = false; // true when the window is a Document PiP
    }

    setTitle(title) {
        this._title = title || "Preview Window";
        if (this.win && !this.win.closed) {
            try { this.win.document.title = this._title; } catch { /* cross-origin */ }
        }
    }

    /** Called on node execution: update existing window or open a new one. */
    showImage(imgData) {
        this.currentUrl = buildViewUrl(imgData);
        // Only update if already open; never auto-open on execution.
        if (this.win && !this.win.closed) {
            this._updateImage(this.currentUrl);
        }
    }

    /** Called from node button / context menu. */
    open() {
        if (this.win && !this.win.closed) {
            // PiP windows are always on top; regular windows need a focus call.
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
        if (this.currentUrl) {
            try {
                const { w, h } = await loadImageDimensions(this.currentUrl);
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

        // Register cleanup immediately so the window is tracked from the start.
        this.win      = pipWin;
        this._pipMode = true;
        pipWin.addEventListener("pagehide", () => {
            this.win      = null;
            this._pipMode = false;
        });

        try {
            // Fetch viewer.html and inject it into the blank PiP document.
            const html   = await fetch(viewerHtmlUrl()).then(r => r.text());
            const parser = new DOMParser();
            const parsed = parser.parseFromString(html, "text/html");

            // Inject <style> blocks into PiP <head>.
            parsed.querySelectorAll("style").forEach(s => {
                const ns = pipWin.document.createElement("style");
                ns.textContent = s.textContent;
                pipWin.document.head.appendChild(ns);
            });

            // Inject body markup without scripts (innerHTML doesn't execute them).
            const bodyClone = parsed.body.cloneNode(true);
            bodyClone.querySelectorAll("script").forEach(s => s.remove());
            pipWin.document.body.innerHTML = bodyClone.innerHTML;

            // Execute scripts in the PiP window's context by appending new elements.
            parsed.querySelectorAll("script").forEach(s => {
                const ns = pipWin.document.createElement("script");
                ns.textContent = s.textContent;
                pipWin.document.body.appendChild(ns);
                // Each script runs synchronously when appended; the IIFE in
                // viewer.html executes here and binds events to pipWin.document.
            });

            // Set title and seed the initial image (location.search is empty in PiP).
            pipWin.document.title = this._title;
            const pipImg = pipWin.document.getElementById("img");
            if (pipImg && this.currentUrl) {
                pipImg.style.opacity = "0.4";
                pipImg.src = this.currentUrl;
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

        const qp  = new URLSearchParams({ img: this.currentUrl ?? "", title: this._title });
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

    _updateImage(url) {
        try {
            const img = this.win.document.getElementById("img");
            if (!img) { this._openViewer(); return; }
            img.style.opacity = "0.4";
            img.src = url;
            // viewer.html's img.load listener calls fit() + restores opacity.
        } catch {
            this.win      = null;
            this._pipMode = false;
            this._openViewer();
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
            popup.showImage(detail.output.images[0]);
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            this.size = [210, 90];

            // Suppress the default node thumbnail.
            this.onExecuted = function () {};

            this.addWidget("button", "↗ Open Viewer", null, () => {
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
                content: "↗ Open Viewer",
                callback: () => {
                    const p = getPopup(String(node.id));
                    p.setTitle(node.title || "Preview Window");
                    p.open();
                },
            },
        ];
    },
});
