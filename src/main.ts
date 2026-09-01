/**
 * NKD Timeline - extension registration and the bridge to ComfyUI.
 *
 * The hidden STRING widget `timeline` is the ONLY source of truth: it serialises with the
 * workflow and reaches Python untouched. The DOM widget is just a view (`serialize:false`).
 * Same pattern as the rest of the NKD ecosystem.
 */
import { app as comfyApp, api as comfyApi } from "./comfyRuntime";
import {
  type FitMode, type ImportMode, type QuantizeMode, type Timeline,
  firstStop, parseTimeline, quantizeCount, quantizeGrid, serialiseTimeline, slotInUse,
  viewState,
  ASPECT_CUSTOM, QUANTIZE_CUSTOM, resolveResolution,
} from "./timeline/model";
import {
  PREVIEW_MAX_H, TimelineEditor, type KeyAction, type TimelineHost,
} from "./timeline/editor";
import {
  type MediaInfo, type MediaRef, type VideoPool,
  adoptStrip, audioBufferFor, cachedInfo, ensureAudio, probe,
  resolveSource, slotKind,
} from "./timeline/media";
import { ensureStyles } from "./timeline/styles";
import { registerFreezeFrames, syncAllFreezeNodes } from "./freezeFrames";
import { registerVideoViewer } from "./video/register";
import { registerTrackedWidgets } from "./labels";
import { guardWidgetOrder } from "./schemaGuard";
import { registerProjectTopbar } from "./projects";
import {
  MAX_INSET, ROW_SAFETY, findW, hideWidget, keepDomWidgetSized, setWidgetVisible,
} from "./domHost";

const NODE_NAME = "NKDTimeline";
const EXT_NAME = "NKD.PreviewTools.Timeline";
const AUDIO_NODE_NAME = "NKDAudioTimeline";
const AUDIO_EXT_NAME = "NKD.PreviewTools.AudioTimeline";
const MIN_W = 380;
const SLOT_RE = /(?:^|\.)(media_\d+)$/;
// An IMAGE/MASK input is a tensor from another node, so its length cannot be known
// until the graph runs - there is no file to probe. Place it at a workable default
// and let the user trim; the execute-time metadata push will fill this in properly.
const TENSOR_DEFAULT_FRAMES = 24;

/**
 * Rebindable shortcuts, surfaced in ComfyUI's own Settings dialog.
 *
 * Only the ones that genuinely differ between editors: Premiere puts trim-to-playhead on
 * Q/W, Resolve elsewhere. The transport (Space, J/K/L) is the same everywhere, so it stays
 * fixed rather than adding settings nobody will touch.
 */
const KEY_SETTINGS: { action: KeyAction; id: string; label: string; def: string }[] = [
  { action: "trimHead", id: "NKD.Timeline.Key.TrimHead",
    label: "Trim head to playhead", def: "q" },
  { action: "trimTail", id: "NKD.Timeline.Key.TrimTail",
    label: "Trim tail to playhead", def: "e" },
  { action: "markIn", id: "NKD.Timeline.Key.MarkIn", label: "Mark in", def: "i" },
  { action: "markOut", id: "NKD.Timeline.Key.MarkOut", label: "Mark out", def: "o" },
  { action: "markClip", id: "NKD.Timeline.Key.MarkClip",
    label: "Mark clip (fit in/out to the clip)", def: "x" },
  { action: "marker", id: "NKD.Timeline.Key.Marker",
    label: "Freeze-frame marker at playhead (Shift+M toggles the mask overlay)", def: "m" },
  { action: "blade", id: "NKD.Timeline.Key.Blade",
    label: "Blade: split at the playhead", def: "w" },
  { action: "zoomFit", id: "NKD.Timeline.Key.ZoomFit", label: "Fit timeline", def: "f" },
];
const KEY_SETTING_BY_ACTION = new Map(KEY_SETTINGS.map((k) => [k.action, k.id]));

/** Read a setting, tolerating frontends that predate the settings API. */
function readSetting(id: string, fallback: string): string {
  try {
    const v = (comfyApp as any).extensionManager?.setting?.get?.(id);
    return typeof v === "string" && v.length ? v.toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}
// A console version stamp: a cached bundle is the number one confounder when debugging
// frontend behaviour that "should" already be fixed.
// Bump WITH every release: this stamp is how a stale cached bundle gets caught in the
// user's console, and it spent 3.8.1→3.10.1 frozen — exactly the confusion it exists
// to prevent.
console.log("[NKD Timeline] rev 3.10.2");

// ── Host: everything the editor needs to know about the node ──────────────────

/** Where the view state lives instead of the widget. See `serialiseTimeline`. */
const VIEW_PROP = "nkdView";

/** Put zoom/scroll/playhead back on a timeline that was just parsed from the widget. */
function restoreView(node: any, tl: Timeline): void {
  const v = node.properties?.[VIEW_PROP];
  if (!v || typeof v !== "object") return;
  if (Number.isFinite(Number(v.zoom))) tl.ui.zoom = Number(v.zoom);
  if (Number.isFinite(Number(v.scroll))) tl.ui.scroll = Number(v.scroll);
  if (Number.isFinite(Number(v.playhead))) tl.ui.playhead = Number(v.playhead);
}

type SourceEntry = { ref: MediaRef; info: MediaInfo | null; label: string };
/** One tensor slot's contact sheet, as pushed by `nkd-timeline-meta`. */
type StripMeta = MediaInfo & { filename: string; subfolder: string; type: string;
                               tiles: number; cols: number };
type Host = TimelineHost & {
  clearSourceCache: () => void;
  /** Store what the last run reported. True when it changed something worth redrawing. */
  applyMeta: (m: { width: number; height: number }) => boolean;
  peekSource: (src: string) => SourceEntry | undefined;
  dropSource: (src: string) => void;
  /** File the filmstrips a run wrote for its tensor slots. True when anything changed. */
  applyStrips: (t: Record<string, StripMeta> | undefined, onReady: () => void) => boolean;
  /** Drop strips for slots that are no longer connected. */
  pruneStrips: (live: Set<string>) => void;
};

/**
 * @param pool  The node's own `<video>` pool. Passed as a THUNK because the editor that
 *   owns it is built from this host, so it does not exist yet at this point.
 */
function makeHost(node: any, state: { tl: Timeline }, pool: () => VideoPool,
                  audioOnly = false): Host {
  const numW = (name: string, def: number) => {
    const v = Number(findW(node, name)?.value);
    return Number.isFinite(v) ? v : def;
  };
  const setW = (name: string, value: unknown) => {
    const w = findW(node, name);
    if (!w || w.value === value) return;
    w.value = value;
    w.callback?.(value);   // the only hook BOTH renderers fire
  };

  const srcCache = new Map<string, SourceEntry>();
  // Filmstrips for the slots that arrive as TENSORS, written by the backend at the end of
  // a run. Kept apart from `srcCache` because they are the only thing that can describe
  // those slots: walking the graph finds whatever file sits upstream, which is a wholly
  // different picture once a node has computed the mask.
  const strips = new Map<string, SourceEntry>();
  // Filled by the "nkd-timeline-meta" push at the end of every run. See `getOutSize`.
  let reported: { width: number; height: number } | null = null;

  const host: Host = {
    getTimeline: () => state.tl,
    commit() {
      const w = findW(node, "timeline");
      if (w) w.value = serialiseTimeline(state.tl);
      // Zoom, scroll and playhead ride in `properties`, NOT in the widget: LiteGraph saves
      // them with the workflow, but they are not a node input, so scrubbing/panning no
      // longer throws away a fifteen-second render.
      node.properties = node.properties || {};
      node.properties[VIEW_PROP] = viewState(state.tl);
      node.setDirtyCanvas(true, true);
      syncAllFreezeNodes();
    },
    saveView() {
      node.properties = node.properties || {};
      node.properties[VIEW_PROP] = viewState(state.tl);
    },
    onSeek() {
      node.setDirtyCanvas(true, true);
    },
    getFps: () => numW("fps", 24),
    getStartFrame: () => Math.max(0, Math.round(numW("start_frame", 0))),
    setStartFrame: (v) => setW("start_frame", Math.max(0, Math.round(v))),
    isStartFrameLinked: () =>
      node.inputs?.some((i: any) => i.name === "start_frame" && i.link != null) ?? false,
    getFrameCount: () => Math.max(0, Math.round(numW("frame_count", 0))),
    setFrameCount: (v) => setW("frame_count", Math.max(0, Math.round(v))),
    getQuantize: () => (findW(node, "model")?.value ?? "free") as QuantizeMode,
    getQuantizeN: () => Math.max(1, Math.round(numW("quantize_n", 8))),
    getFit: () => (findW(node, "fit")?.value ?? "contain") as FitMode,
    getImportMode: () => (findW(node, "import_mode")?.value ?? "stack") as ImportMode,
    getKey: (action, fallback) =>
      readSetting(KEY_SETTING_BY_ACTION.get(action) ?? "", fallback),
    srcFramesFor(src: string) {
      const info = host.sourceFor(src)?.info;
      if (info?.frame_count) return info.frame_count;
      // Audio has no frame count of its own: its length is its duration at timeline rate.
      return host.audioFramesFor(src);
    },
    /**
     * The DECODED SOUND's length in timeline frames.
     *
     * Separate from `srcFramesFor` because a clip on the audio lane is bounded by the
     * sound, and a VIDEO dropped there reports a frame count that measures the PICTURE -
     * a different number, in a different cadence, that would clamp the clip against the
     * wrong end of its own material.
     */
    audioFramesFor(src: string) {
      const ref = host.sourceFor(src)?.ref;
      const buf = ref && audioBufferFor(ref);
      return buf ? Math.round(buf.duration * host.getFps()) : null;
    },
    reloadSources() {
      pool().bust();
      srcCache.clear();
      node.setDirtyCanvas(true, true);
    },
    notify(summary, detail, severity = "info") {
      (comfyApp as any).extensionManager?.toast?.add?.({
        severity, summary, detail, life: 8000,
      });
    },
    /**
     * The output resolution, in order of how much it can be trusted.
     *
     * 1. The widgets, when they hold a real number.
     * 2. What the last run REPORTED. This is the only thing that works when width/height
     *    arrive through a LINK - a resolution selector, a maths node, a primitive - because
     *    a linked value does not exist in the browser at all: it is produced while the
     *    graph runs. Reading the upstream node's widgets instead would only ever cover the
     *    nodes whose output IS a widget, and a computed selector's is not.
     * 3. The first clip's own size, so a fresh node still previews something sane.
     */
    getOutSize(): [number, number] {
      // A named aspect ratio resolves in the browser, so the monitor turns vertical the
      // moment you pick 9:16 - no run needed. 'Custom' falls through to the widgets.
      // `As Source` needs the first clip's own size, which the editor already has cached
      // from the probe - so this one also resolves live, no run needed.
      const firstClip = state.tl.clips[0] ?? state.tl.masks[0];
      const srcInfo = firstClip ? srcCache.get(firstClip.src)?.info : null;
      const [w, h] = resolveResolution(
        String(findW(node, "aspect_ratio")?.value ?? ASPECT_CUSTOM),
        numW("megapixels", 1), Math.round(numW("width", 0)),
        Math.round(numW("height", 0)), numW("size_multiple", 16),
        srcInfo?.width ?? 0, srcInfo?.height ?? 0);
      if (w > 0 && h > 0) return [w, h];
      if (reported && reported.width > 0 && reported.height > 0) {
        return [reported.width, reported.height];
      }
      const first = state.tl.clips[0];
      const info = first ? srcCache.get(first.src)?.info : null;
      return info ? [info.width, info.height] : [16, 9];
    },
    sourceFor(src: string) {
      // A computed slot describes itself; nothing upstream can be trusted to.
      const strip = strips.get(src);
      if (strip) return strip;
      const hit = srcCache.get(src);
      if (hit) {
        if (!hit.info) hit.info = cachedInfo(hit.ref) ?? null;
        return hit;
      }
      // TENSOR slots only accept a file from the node they are DIRECTLY wired to.
      // Walking further up finds a loader whose content the chain has since changed -
      // that is how a SAM3 mask ended up labelled with the video's filename and the
      // overlay tinted the picture while claiming to be the mask. A plain block is a
      // better answer than a confident wrong one; the contact sheet fills it in after a
      // run. VIDEO keeps the full walk: there the object IS that file.
      const kind = slotKind(node, src);
      // VIDEO and AUDIO keep the full walk: whatever the chain does to them, the bytes
      // still come from that file, and the audio of a `Get Video Components` IS the
      // loader's audio. IMAGE and MASK stop at the node they are directly wired to.
      const ref = resolveSource(node, src, kind === "image" || kind === "mask" ? 0 : 6);
      if (!ref) return null;
      const entry: SourceEntry = { ref, info: cachedInfo(ref) ?? null, label: ref.filename };
      srcCache.set(src, entry);
      if (!entry.info) {
        void probe(ref).then((info) => {
          entry.info = info;
          node.setDirtyCanvas(true, true);
        });
      }
      return entry;
    },
    connectedSlots() {
      // One socket type for everything, so the kind comes from what is plugged in.
      const out: Record<string, string[]> =
        { video: [], image: [], mask: [], audio: [] };
      for (const inp of node.inputs ?? []) {
        const m = SLOT_RE.exec(inp.name ?? "");
        if (!m || inp.link == null) continue;
        const kind = slotKind(node, m[1]);
        if (kind) out[kind].push(m[1]);
      }
      // On the audio node a VIDEO slot IS an audio slot: the socket takes video so a
      // voice can be pulled out of a take without a separate extractor, and the backend
      // reads only the audio stream. There is no picture lane for it to land on anyway.
      if (audioOnly) {
        return { videos: [], images: [], masks: [],
                 audios: [...out.audio, ...out.video, ...out.image, ...out.mask] };
      }
      return {
        videos: out.video, images: out.image, masks: out.mask, audios: out.audio,
      };
    },
    conformToFirstClip(from?: MediaInfo) {
      const first = state.tl.clips[0];
      const info = from ?? (first ? host.sourceFor(first.src)?.info : null);
      if (!info) return;
      setW("fps", Number(info.fps.toFixed(3)));
      setW("width", info.width);
      setW("height", info.height);
      node.setDirtyCanvas(true, true);
    },
    clearSourceCache: () => srcCache.clear(),
    applyMeta(m) {
      if (!(m.width > 0 && m.height > 0)) return false;
      if (reported && reported.width === m.width && reported.height === m.height) {
        return false;
      }
      reported = { width: m.width, height: m.height };
      return true;
    },
    applyStrips(tensors, onReady) {
      let changed = false;
      for (const [slot, t] of Object.entries(tensors ?? {})) {
        if (!t?.filename || !(t.tiles > 0)) continue;
        const prev = strips.get(slot);
        if (prev?.ref.filename === t.filename) continue;
        // A fresh name every run on purpose (HTTP caching), so the old sheet is dead
        // weight the moment a new one lands.
        if (prev) pool().forget(prev.ref);
        const ref: MediaRef = {
          filename: t.filename, subfolder: t.subfolder ?? "", type: t.type ?? "temp",
        };
        const info: MediaInfo = {
          fps: t.fps, frame_count: t.frame_count, duration: t.duration,
          width: t.width, height: t.height,
        };
        // Named for what it is. The upstream file's name was the old lie.
        strips.set(slot, { ref, info, label: `${slot} · computed` });
        adoptStrip(ref, info, t.tiles, Math.max(1, t.cols || t.tiles), onReady);
        changed = true;
      }
      return changed;
    },
    pruneStrips(live) {
      // ponytail: a slot rewired to a DIFFERENT computed source keeps the old strip until
      // the next run. Detecting that needs an identity the graph does not expose, and one
      // stale filmstrip until the next execution is cheaper than a probe per tick.
      for (const slot of [...strips.keys()]) {
        if (live.has(slot)) continue;
        pool().forget(strips.get(slot)!.ref);
        strips.delete(slot);
      }
    },
    /** Read the cache WITHOUT resolving, so the swap detector can compare against it. */
    peekSource: (src: string) => srcCache.get(src),
    dropSource: (src: string) => { srcCache.delete(src); },
  };
  return host;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * The two nodes that share this editor.
 *
 * ONE registration, called twice, rather than a second copy of four hundred lines. The
 * audio node has a subset of the video node's widgets and every reader here goes through
 * `findW(...)` with a default, so the missing ones simply fall back - which is what makes
 * the sharing honest rather than a pile of `if (audioOnly)`.
 */
type TimelineVariant = {
  node: string; ext: string;
  /** Prototype flag for the re-entrancy guard. Must differ per node type or registering
   *  the second one would be skipped as "already wrapped". */
  flag: string;
  audioOnly: boolean;
};

function registerTimelineNode(v: TimelineVariant): void {
comfyApp.registerExtension({
  name: v.ext,
  // Surfaced in ComfyUI's own Settings dialog under "NKD Timeline", so the shortcuts are
  // discoverable and rebindable in the place users already look for them.
  //
  // Declared by the VIDEO variant only. The ids are shared - both editors read the same
  // bindings, which is the point - and registering an id twice is a conflict, not a
  // second copy.
  settings: v.audioOnly ? [] : KEY_SETTINGS.map((k) => ({
    id: k.id,
    name: k.label,
    type: "text",
    defaultValue: k.def,
    category: ["NKD Timeline", "Shortcuts", k.label],
    tooltip: `Single key, lower-case. Default: ${k.def}`,
  })),
  async beforeRegisterNodeDef(nodeType: any, nodeData: any) {
    if (nodeData?.name !== v.node) return;
    // Without this guard, "Refresh node definitions" re-runs the hook on the SAME
    // prototype and the wraps stack up: 2^n mounted widgets, and the orphans keep
    // rendering forever as frozen ghosts.
    if (nodeType.prototype[v.flag]) return;
    nodeType.prototype[v.flag] = true;
    // v1: no reorder has happened under the stamp regime — this only makes saved values
    // restore BY NAME (immune to future reorders), it never toasts.
    guardWidgetOrder(nodeType, v.node, 1);

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (this: any) {
      const result = origCreated?.apply(this, arguments as any);
      ensureStyles();
      const node = this;

      const dataW = findW(node, "timeline");
      hideWidget(dataW);
      // socketless is not honoured by the V3 frontend: it still creates a phantom socket.
      const ghost = node.inputs?.findIndex((i: any) => i.name === "timeline");
      if (ghost >= 0) node.removeInput(ghost);

      const state = { tl: parseTimeline(dataW?.value) };
      restoreView(node, state.tl);
      // The host needs the pool, the pool lives on the editor, and the editor needs the
      // host: a thunk breaks the cycle without a second owner for either.
      let editor!: TimelineEditor;
      const host = makeHost(node, state, () => editor.pool, v.audioOnly);
      editor = new TimelineEditor(host, { audioOnly: v.audioOnly });

      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.minWidth = `${MIN_W}px`;
      container.appendChild(editor.root);

      /**
       * Height reporting.
       *
       * `DOMWidgetImpl.computeLayoutSize` reads ONLY getMinHeight/getMaxHeight/getHeight
       * and NEVER `widget.computeSize`, so those getters are the whole contract. Measure
       * the real rendered content and report THAT: an estimate carries an error that
       * scales with the aspect ratio, so a portrait clip and a landscape one end up with
       * different margins.
       */
      let measured = 0;
      let inset = 0;     // ComfyUI hands the host a bit less than asked; calibrated below
      const estimate = () => {
        // No monitor to make room for: the timeline IS the whole widget.
        if (v.audioOnly) return editor.timelineHeight + 40;
        const w = Math.max(node.size?.[0] ?? MIN_W, MIN_W);
        const [ow, oh] = host.getOutSize();
        // Same cap the preview itself applies, so the first estimate is not wildly off
        // before the real content height is measured.
        return Math.min(Math.round((w - 24) * (oh / Math.max(1, ow))), PREVIEW_MAX_H)
          + editor.timelineHeight + 40;
      };
      const heightFor = () => (measured > 0 ? measured : estimate()) + ROW_SAFETY + inset;

      const domWidget = node.addDOMWidget("nkd_timeline", "NKD_TIMELINE", container, {
        getValue: () => dataW?.value ?? "",
        setValue: (v: string) => {
          if (dataW) dataW.value = v;
          state.tl = parseTimeline(v);
          restoreView(node, state.tl);
          editor.requestRender();
        },
        serialize: false,
        hideOnZoom: false,
        getMinHeight: heightFor,
        getMaxHeight: heightFor,
        getHeight: heightFor,
      });
      void domWidget;

      const widthKeeper = keepDomWidgetSized(node, container, MIN_W);
      /**
       * MIN_W is what the CONTENT needs; the node also has to pay for the gutter ComfyUI
       * leaves around the widget column.
       *
       * Clamping the node to MIN_W alone is what left the widget lopsided: the host then
       * gets MIN_W minus the gutter, the container's `min-width: MIN_W` overflows it, and
       * since the host is anchored on the left the spill all lands on the right - flush
       * against that border while the left keeps its margin. `margin()` is the measured
       * TOTAL (node width minus host width), so it is added once, not per side.
       */
      const minNodeWidth = () => MIN_W + widthKeeper.margin();

      /**
       * Keep the node's box wrapped around the widget.
       *
       * The width clamp is the important half. `container` carries `min-width: MIN_W`, so
       * the rendered DOM can never be narrower than that - but nothing forced the NODE to
       * be that wide, and a freshly created one is 210 px. Measured live: node 210 wide,
       * widget DOM 380, so the timeline hung out past both borders. Same fix as NKD Sigmas
       * Curve, which clamps to its canvas width on every resize.
       *
       * The width the user chose is still preserved - this only ever raises it to the
       * minimum, never shrinks it back to `computeSize()[0]`.
       */
      const resizeToContent = () => {
        node.setSize([Math.max(node.size[0], minNodeWidth()), node.computeSize()[1]]);
        node.setDirtyCanvas(true, true);
      };

      // Re-lock the height whenever the content's real height changes (new track, output
      // aspect changed by conform, control bar wrapping to two rows).
      let settling = false;

      /**
       * How many px the host row ends up short of what we asked for.
       *
       * ASSIGNED, never ratcheted. A one-way maximum was the bug: a single reading taken
       * while the layout was still settling (host briefly short) got locked in for the rest
       * of the session as dead space under the toolbar. Assigning converges instead - the
       * gap is `asked - got` and `asked` already contains the current inset, so a constant
       * renderer offset is an immediate fixed point, not a feedback loop. The 1 px deadband
       * keeps sub-pixel rounding from thrashing the node size.
       */
      const calibrate = (): boolean => {
        const hostH = container.parentElement?.clientHeight ?? 0;
        if (hostH < 1) return false;
        const gap = Math.min(MAX_INSET, Math.max(0, Math.round(heightFor() - hostH)));
        if (Math.abs(gap - inset) <= 1) return false;
        inset = gap;
        return true;
      };

      const ro = new ResizeObserver(() => {
        if (settling) return;
        const h = editor.root.offsetHeight;   // offsetHeight, NOT getBoundingClientRect:
        if (h < 1) return;                    // gBCR is screen space and scales with zoom
        const grew = Math.abs(h - measured) > 1;
        if (grew) measured = h;
        // Recalibrated on EVERY tick, not only when the content changed height: otherwise
        // a stale inset survives until the user happens to add a track.
        if (!calibrate() && !grew) return;
        settling = true;
        resizeToContent();
        requestAnimationFrame(() => { settling = false; });
      });
      ro.observe(editor.root);
      editor.onHeightChange = () => requestAnimationFrame(resizeToContent);

      const origResize = node.onResize;
      node.onResize = function (this: any, size: [number, number]) {
        origResize?.apply(this, arguments as any);
        const min = minNodeWidth();
        if (size[0] < min) size[0] = min;
        size[1] = this.computeSize(size[0])[1];
        editor.requestRender();
      };

      const origComputeSize = node.computeSize.bind(node);
      node.computeSize = function (this: any) {
        const sz = origComputeSize();       // no arguments: passing a width breaks LGN
        const needed = heightFor();
        if (sz[1] < needed) sz[1] = needed;
        const min = minNodeWidth();
        if (sz[0] < min) sz[0] = min;
        return sz;
      };

      /**
       * Make the frame_count widget step by the model's quantum, so nudging it walks
       * between legal frame counts instead of landing between them. LiteGraph reads
       * `options.step` (10x the visual step, a legacy quirk) and newer frontends read
       * `options.step2`, so both are set.
       */
      /**
       * `frame_count` WALKS the model's legal counts. There is no invalid value to land
       * on and then be corrected off - an arrow moves to the next legal count, full stop.
       *
       * The core states this in the schema: `io.Int.Input("length", min=5, step=17)` on
       * MiniMax H3, so its widget reads 5, 22, 39... and nothing else. Copying that
       * outright is not open to us, because `min` here is 0 and 0 MEANS something - "up
       * to the end of the last clip". Worse, it is the default, so every saved workflow
       * carries it: a min of 5 would have LiteGraph clamp those to 5 on load and quietly
       * render five frames of a two-minute edit.
       *
       * So the walk is done by hand, with 0 sitting one notch below the first stop.
       * Arrows step 0 -> 5 -> 22 -> 39 and back down into 0, and a typed number lands on
       * the nearest legal count instead of being rejected.
       */
      /** Put `frame_count` back on "auto" - the one state its own arrows cannot reach. */
      const setAutoFrameCount = () => {
        const w = findW(node, "frame_count");
        if (!w) return;
        w.value = 0;
        w.callback?.(0);
        syncQuantumStep();
        node.setDirtyCanvas(true, true);
      };

      const syncQuantumStep = () => {
        const w = findW(node, "frame_count");
        if (!w?.options) return;
        const grid = quantizeGrid(host.getQuantize(), host.getQuantizeN());
        const value = Number(w.value) || 0;
        // Feed the frontend the pair it already knows how to walk. A number widget
        // rounds to `min + k*step`, which is exactly why the core writes
        // `min=5, step=17` on MiniMax H3's length and its arrows read 5, 22, 39 and
        // nothing else. So `min` has to BE the first legal count, not 0.
        //
        // While the value is 0 - "auto", up to the end of the last clip - min stays 0
        // and the step is the distance to the first stop, so one press leaves auto and
        // lands ON it rather than one step past. Once off 0 the real pair takes over.
        // Stepping down then floors at the first count, so auto is unreachable by arrow:
        // that is what the context menu entry is for.
        const [min, step] = !grid ? [0, 1]
          : value <= 0 ? [0, firstStop(grid[0], grid[1])]
            : [firstStop(grid[0], grid[1]), grid[0]];
        if (w.options.step2 === step && w.options.min === min) return;
        w.options.min = min;
        w.options.step2 = step;
        w.options.step = step * 10;                 // LiteGraph's legacy 10x field
        // Re-land the current value, for the case the MODEL changed under it.
        const snapped = quantizeCount(value, host.getQuantize(), host.getQuantizeN());
        if (snapped > 0 && snapped !== value) {
          w.value = snapped;
          w.callback?.(snapped);
        }
      };

      // Toggling the clip-bounds markers changes how many sockets a downstream Freeze
      // Frames needs, and a plain widget flip never passes through host.commit().
      const clipMarkersW = findW(node, "clip_markers");
      if (clipMarkersW) {
        const origClipMarkersCb = clipMarkersW.callback;
        clipMarkersW.callback = (...args: any[]) => {
          const out = origClipMarkersCb?.apply(clipMarkersW, args);
          syncAllFreezeNodes();
          return out;
        };
      }

      requestAnimationFrame(() => {
        measured = editor.root.offsetHeight || 0;
        syncQuantumStep();
        resizeToContent();
        editor.requestRender();
      });

      /**
       * Connections: when a new Load Video is wired in, probe its duration and drop it at
       * the end of track 0 by itself, so the node does something sensible untouched.
       */
      /**
       * Where a newly connected sound belongs when its picture is already on the timeline.
       *
       * The two arrive on separate sockets - VHS hands out IMAGE and AUDIO apart, and so
       * does `Get Video Components` - so nothing links them and the sound was appended to
       * the end of the timeline, nowhere near its own picture.
       *
       * Paired by the FILE BOTH DESCEND FROM, walked without a depth limit. That walk is
       * exactly the one `sourceFor` refuses for a tensor slot, and for good reason: as a
       * source of PIXELS it lies, because the chain has since changed them. As an
       * IDENTITY it is still true - a rescaled frame and its audio came out of the same
       * loader - and identity is all this needs.
       */
      const twinOf = (slot: string) => {
        const origin = resolveSource(node, slot, 6)?.filename;
        if (!origin) return undefined;
        const fps = host.getFps();
        for (const c of [...state.tl.clips, ...state.tl.masks]) {
          if (resolveSource(node, c.src, 6)?.filename !== origin) continue;
          // A video clip's trimIn counts SOURCE frames; audio has no cadence of its own
          // and runs at the timeline's. A tensor twin reports the timeline rate, so the
          // ratio is 1 and this is a no-op there - which is correct.
          const srcFps = host.sourceFor(c.src)?.info?.fps || fps;
          return {
            start: c.start,
            trimIn: Math.max(0, Math.round(c.trimIn * (fps / srcFps))),
            length: c.length,
          };
        }
        return undefined;
      };

      const syncSlots = () => {
        host.clearSourceCache();
        const { videos, images, masks, audios } = host.connectedSlots();
        const live = new Set([...videos, ...images, ...masks, ...audios]);
        host.pruneStrips(live);
        if (editor.pruneToSlots(live)) host.commit();

        // `slotInUse` spans every lane on purpose: a video the user reinterpreted as a
        // mask has left the picture lane, and a per-lane check would add it straight back
        // as a video - undoing the reinterpretation on every refresh.
        // Videos carry a real file, so their length is probed exactly.
        for (const slot of videos) {
          if (slotInUse(state.tl, slot)) continue;
          const src = host.sourceFor(slot);
          if (!src) continue;
          const place = (info: MediaInfo | null) => {
            if (!info) return;
            // FIRST video on an untouched timeline: adopt its frame rate and size rather
            // than resampling it against an arbitrary default. Only when the timeline is
            // still empty, so it never overrides a rate the user chose.
            if (state.tl.clips.length === 0 && state.tl.masks.length === 0) {
              host.conformToFirstClip(info);
            }
            // The clip is measured in TIMELINE frames, not source frames.
            const fps = host.getFps();
            editor.addClipForSlot(slot,
              Math.round(info.frame_count * (fps / (info.fps || fps))), "video");
          };
          if (src.info) place(src.info);
          else void probe(src.ref).then(place);
        }
        // Tensor sources run 1:1 with the timeline and have no probeable length.
        const fallback = Math.max(1, host.getFrameCount() || TENSOR_DEFAULT_FRAMES);
        for (const slot of images) {
          if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "video");
        }
        for (const slot of masks) {
          if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "mask");
        }
        // Audio: the true length only exists once the file is decoded, and that decode is
        // the same one the waveform needs - so ask for it and place the clip when it lands.
        for (const slot of audios) {
          if (slotInUse(state.tl, slot)) continue;
          const src = host.sourceFor(slot);
          if (!src) continue;
          const place = () => {
            const buf = audioBufferFor(src.ref);
            const len = buf ? Math.round(buf.duration * host.getFps()) : fallback;
            editor.addClipForSlot(slot, len, "audio", twinOf(slot));
          };
          if (audioBufferFor(src.ref)) place();
          else ensureAudio(src.ref, place);
        }
        const refs = [...state.tl.clips, ...state.tl.masks, ...state.tl.audio]
          .map((c) => host.sourceFor(c.src)?.ref)
          .filter(Boolean) as MediaRef[];
        editor.pool.releaseUnused(refs);
        editor.requestRender();
      };

      const origConn = node.onConnectionsChange;
      node.onConnectionsChange = function (this: any, ...args: any[]) {
        const r = origConn?.apply(this, args);
        // Autogrow rebuilds its slots; give it a tick before reading them.
        requestAnimationFrame(syncSlots);
        return r;
      };

      const origConfigure = node.onConfigure;
      node.onConfigure = function (this: any, ...args: any[]) {
        const r = origConfigure?.apply(this, args);
        // Widget values are restored AFTER the node is created.
        requestAnimationFrame(() => {
          state.tl = parseTimeline(findW(node, "timeline")?.value);
          restoreView(node, state.tl);
          syncSlots();
          resizeToContent();
          editor.requestRender();
        });
        return r;
      };

      /**
       * What the backend actually rendered, pushed at the end of every run.
       *
       * This is what makes a LINKED width/height work: wire a resolution selector into
       * them and the browser has no value at all to show, because that number is produced
       * while the graph runs. One execution later the monitor knows the real aspect and
       * the preview turns vertical, or whatever the selector said.
       *
       * The event is broadcast to every client, so filter by node id - several timelines
       * in one workflow would otherwise adopt each other's resolution.
       */
      const onMeta = (e: any) => {
        const d = e?.detail;
        if (!d || String(d.node) !== String(node.id)) return;
        // The strips ride along on the same push and must be taken FIRST: `applyMeta`
        // short-circuits when the resolution has not moved, which is the common case.
        const gotStrips = host.applyStrips(d.tensors, () => {
          // Now that a computed slot finally has a real length, a clip placed on the old
          // guess can be brought inside it.
          editor.retightenToSources();
          editor.requestRender();
        });
        const gotSize = host.applyMeta(d);
        if (!gotStrips && !gotSize) return;
        if (gotSize) resizeToContent();   // the monitor's aspect drives the node's height
        editor.requestRender();
      };
      comfyApi.addEventListener("nkd-timeline-meta", onMeta);

      /**
       * Picking a different file in an upstream Load Video/Audio changes NO connection, so
       * `onConnectionsChange` never fires and the old media would stay on screen. Compare
       * the resolved reference instead, and drop just that source when it moves.
       */
      const detectSourceSwaps = () => {
        for (const slot of new Set(
          [...state.tl.clips, ...state.tl.masks, ...state.tl.audio].map((c) => c.src))) {
          const cached = host.peekSource(slot);
          if (!cached) continue;
          const now = resolveSource(node, slot);
          if (!now || now.filename === cached.ref.filename) continue;
          editor.pool.forget(cached.ref);
          host.dropSource(slot);
          editor.requestRender();
        }
      };

      /**
       * `Custom` shows width/height; a named ratio shows the budget that computes them.
       *
       * Driven from the tick rather than from the widget callback because the tick is
       * already the one path both renderers share for plain-widget edits, and it also
       * covers the value arriving from a loaded workflow.
       */
      let lastAspect: string | null = null;
      let lastModel: string | null = null;
      const syncAspectWidgets = () => {
        if (v.audioOnly) return;    // none of these widgets exist on the audio node
        const aspect = String(findW(node, "aspect_ratio")?.value ?? ASPECT_CUSTOM);
        const model = String(findW(node, "model")?.value ?? "");
        if (aspect === lastAspect && model === lastModel) return;
        lastAspect = aspect;
        lastModel = model;
        const custom = aspect === ASPECT_CUSTOM;
        // Width/height are the CUSTOM pair. Every other choice - a named ratio or As
        // Source - is driven by the megapixel budget instead.
        setWidgetVisible(node, "width", custom);
        setWidgetVisible(node, "height", custom);
        setWidgetVisible(node, "megapixels", !custom);
        setWidgetVisible(node, "size_multiple", !custom);
        // `quantize_n` only means anything to the custom grid; floating there the rest of
        // the time it just reads as a knob that does nothing.
        setWidgetVisible(node, "quantize_n", model === QUANTIZE_CUSTOM);
        // Vue keeps its own snapshot of the widget array and will not re-read it otherwise.
        if (Array.isArray(node.widgets)) node.widgets = [...node.widgets];
        resizeToContent();          // rows appeared or vanished: the node is a different height
        editor.requestRender();     // and the monitor's aspect just changed
      };

      // Vue Nodes never calls onDrawBackground, so a low-rate tick is the only common
      // path for reflecting fps / size / fit edits made in the plain widgets.
      const tick = window.setInterval(() => {
        syncAspectWidgets();
        syncQuantumStep();
        detectSourceSwaps();
        // After a swap the new length only lands once the probe answers, so the clamp
        // belongs here rather than inside the detector. No-op when nothing shrank.
        editor.retightenToSources();
        editor.requestRender();
      }, 300);

      // The one state the arrows cannot walk back to, so it needs a door of its own.
      const origMenu = node.getExtraMenuOptions;
      node.getExtraMenuOptions = function (this: any, canvas: any, options: any[]) {
        const r = origMenu?.apply(this, [canvas, options]);
        const w = findW(node, "frame_count");
        if (w && Number(w.value) > 0) {
          options.push({
            content: "Frame count: auto (to the end of the last clip)",
            callback: setAutoFrameCount,
          });
        }
        return r;
      };

      const origRemoved = node.onRemoved;
      node.onRemoved = function (this: any, ...args: any[]) {
        window.clearInterval(tick);
        ro.disconnect();
        widthKeeper.release();
        // The api emitter outlives the node; a listener holding this closure would keep
        // the whole editor (canvases, video pool) alive for the rest of the session.
        comfyApi.removeEventListener("nkd-timeline-meta", onMeta);
        editor.destroy();   // releases this node's video pool
        origRemoved?.apply(this, args);
      };

      requestAnimationFrame(syncSlots);
      return result;
    };
  },
});
}

registerTimelineNode({
  node: NODE_NAME, ext: EXT_NAME,
  flag: "__nkdTimelineWrapped", audioOnly: false,
});
registerTimelineNode({
  node: AUDIO_NODE_NAME, ext: AUDIO_EXT_NAME,
  flag: "__nkdAudioTimelineWrapped", audioOnly: true,
});

// The Freeze Frames companion: its own extension, registered from the same bundle.
registerFreezeFrames();
registerVideoViewer();
// Right-click "Track widget" on ANY node → burned into the viewer's _labeled review copy.
registerTrackedWidgets();
// The project picker in ComfyUI's top bar, so switching project does not require having a
// node on screen.
registerProjectTopbar();

/**
 * Shared surface for `js/popup_preview.js`.
 *
 * That file is hand-written and does NOT go through Vite, so it cannot import from `src/`.
 * It imports this bundle instead (`import { projectChip } from "./nkd_timeline.js"`) -
 * both are served flat from `js/`, and ESM caches the module, so the extension
 * registrations above still run exactly once.
 *
 * These re-exports are load-bearing: without a name in the entry's export list, Rollup
 * tree-shakes the code away and the popup's import resolves to undefined.
 */
export {
  projectChip, revealButton, saveToProject, reveal, revealAvailable, loadConfig, config,
} from "./projects";
export { ensureStyles } from "./timeline/styles";
export { mountDomWidget } from "./domHost";
