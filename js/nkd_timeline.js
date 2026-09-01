var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
const int = (v, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const num$1 = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const MAX_ZOOM = 400;
function viewWindow(ui, contentFrames) {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, num$1(ui.zoom, 1)));
  const content = Math.max(2, num$1(contentFrames, 2));
  const frames = Math.max(2, content / zoom);
  const start = Math.max(0, Math.min(num$1(ui.scroll, 0), content - frames));
  return { start, frames };
}
const BLEND_MODES = ["normal", "screen", "multiply", "difference"];
const emptyTimeline = () => ({
  v: 1,
  clips: [],
  masks: [],
  audio: [],
  tracks: [],
  ui: { zoom: 1, scroll: 0, playhead: 0 }
});
function trackBlend(t, track) {
  var _a;
  return ((_a = t.tracks[track]) == null ? void 0 : _a.blend) ?? "normal";
}
function setTrackBlend(t, track, blend) {
  while (t.tracks.length <= track) t.tracks.push({ blend: "normal" });
  t.tracks[track].blend = blend;
}
let idCounter = 0;
function newId() {
  idCounter += 1;
  return `c${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
const QUANTIZE_FREE = "free";
const QUANTIZE_CUSTOM = "custom (multiple of N)";
const QUANTIZE_PRESETS = {
  // Split per MODEL, not per grid: Wan and Hunyuan share 4n+1 but were trained at
  // different frame rates, so one grouped entry could not carry an honest expected fps.
  "Wan (4n+1)": [4, 1],
  "Hunyuan (4n+1)": [4, 1],
  "LTX (8n+1)": [8, 1],
  "Cosmos (8n+1)": [8, 1],
  "Mochi (6n+1)": [6, 1],
  // NOT an Nn+1 family: MiniMax H3 walks up until `n % 17 == 5`.
  "MiniMax H3 (17n+5)": [17, 5]
};
const QUANTIZE_NATIVE_FPS = {
  "Wan (4n+1)": 16,
  "LTX (8n+1)": 25,
  "MiniMax H3 (17n+5)": 24
};
function nativeFpsFor(mode) {
  return QUANTIZE_NATIVE_FPS[mode] ?? null;
}
const TOKEN_GRIDS = {
  "Wan (4n+1)": { ratio: 4, chunk: 0 },
  "Hunyuan (4n+1)": { ratio: 4, chunk: 0 },
  "LTX (8n+1)": { ratio: 8, chunk: 0 },
  "Cosmos (8n+1)": { ratio: 8, chunk: 0 },
  "Mochi (6n+1)": { ratio: 6, chunk: 0 },
  // H3 accepts a cut only where the preserved material RESUMES on a whole block.
  // `cutLead` is how many frames before that boundary are also valid. Do not widen it.
  "MiniMax H3 (17n+5)": { ratio: 4, chunk: 17, audioMultiple: 3, cutEvery: 17, cutLead: 3 }
};
function cutStops(max, mode, withAudio = false, edge = "resume") {
  const grid = TOKEN_GRIDS[mode];
  if (!grid || max < 0) return [];
  const { ratio, chunk, audioMultiple, cutEvery, cutLead } = grid;
  if (ratio <= 0) return [];
  if (cutEvery && edge === "resume") {
    const lead = Math.max(0, cutLead ?? 0);
    const out2 = [0];
    for (let b = cutEvery; b <= max; b += cutEvery) {
      for (let f = Math.max(1, b - lead); f <= b; f++) out2.push(f);
    }
    const every2 = withAudio ? audioMultiple ?? 1 : 1;
    return every2 > 1 ? out2.filter((f) => f % every2 === 0) : out2;
  }
  const span = chunk > 0 ? chunk : max + 1;
  const out = [];
  for (let base = 0; base <= max; base += span) {
    out.push(base);
    for (let f = base + 1; f <= max && f < base + span; f += ratio) out.push(f);
  }
  const every = withAudio ? audioMultiple ?? 1 : 1;
  return every > 1 ? out.filter((f) => f % every === 0) : out;
}
const MODEL_CANVAS = {
  "MiniMax H3 (17n+5)": { multiple: 32, shortEdge: 768, maxPixels: 768 * 1344 }
};
function canvasFor(mode) {
  return MODEL_CANVAS[mode] ?? null;
}
function adaptCanvas(width, height, spec) {
  const { multiple: m, shortEdge, maxPixels } = spec;
  const ratio = width / height;
  let [w, h] = ratio >= 1 ? [shortEdge * ratio, shortEdge] : [shortEdge, shortEdge / ratio];
  if (w * h > maxPixels) {
    const s = Math.sqrt(maxPixels / (w * h));
    w *= s;
    h *= s;
  }
  const snapAxis = (v) => Math.max(m, Math.round(v / m) * m);
  return [snapAxis(w), snapAxis(h)];
}
[
  QUANTIZE_FREE,
  ...Object.keys(QUANTIZE_PRESETS),
  QUANTIZE_CUSTOM
];
function quantizeGrid(mode, k = 8) {
  if (mode === QUANTIZE_CUSTOM) return [Math.max(1, int(k, 1)), 0];
  return QUANTIZE_PRESETS[mode] ?? null;
}
function firstStop(step, offset) {
  return offset > 1 ? offset : offset + step;
}
const ASPECT_CUSTOM = "Custom";
const ASPECT_SOURCE = "As Source";
const ASPECT_RATIOS = {
  [ASPECT_CUSTOM]: null,
  [ASPECT_SOURCE]: null,
  "1:1": [1, 1],
  "2:3 Vertical": [2, 3],
  "3:4 Vertical": [3, 4],
  "3:5 Vertical": [3, 5],
  "4:5 Vertical": [4, 5],
  "5:7 Vertical": [5, 7],
  "5:8 Vertical": [5, 8],
  "7:9 Vertical": [7, 9],
  "9:16 Vertical": [9, 16],
  "9:19 Vertical": [9, 19],
  "9:21 Vertical": [9, 21],
  "9:32 Vertical": [9, 32],
  "3:2 Horizontal": [3, 2],
  "4:3 Horizontal": [4, 3],
  "5:3 Horizontal": [5, 3],
  "5:4 Horizontal": [5, 4],
  "7:5 Horizontal": [7, 5],
  "8:5 Horizontal": [8, 5],
  "9:7 Horizontal": [9, 7],
  "16:9 Horizontal": [16, 9],
  "19:9 Horizontal": [19, 9],
  "21:9 Horizontal": [21, 9],
  "32:9 Horizontal": [32, 9]
};
function scaleToMegapixels(width, height, targetPixels, multiple) {
  const m = Math.max(1, Math.round(multiple));
  if (!(width > 0) || !(height > 0)) return [m, m];
  const aspect = width / height;
  const hIdeal = Math.sqrt(targetPixels / aspect);
  const wIdeal = hIdeal * aspect;
  const snap2 = (v, up) => Math.max(1, Math.trunc(v / m) + (up ? 1 : 0)) * m;
  let best = null;
  for (const wUp of [false, true]) {
    for (const hUp of [false, true]) {
      const cw = snap2(wIdeal, wUp);
      const ch = snap2(hIdeal, hUp);
      const cand = [
        Math.abs(cw / ch - aspect) / aspect,
        Math.abs(cw * ch - targetPixels) / Math.max(1, targetPixels),
        cw,
        ch
      ];
      if (!best || cand[0] < best[0] || cand[0] === best[0] && cand[1] < best[1]) {
        best = cand;
      }
    }
  }
  return [best[2], best[3]];
}
function resolveResolution(aspect, megapixels, width, height, multiple, srcW = 0, srcH = 0) {
  const mp = Number.isFinite(megapixels) && megapixels > 0 ? megapixels : 1;
  if (aspect === ASPECT_SOURCE) {
    return srcW > 0 && srcH > 0 ? scaleToMegapixels(srcW, srcH, mp * 1048576, multiple) : [Math.round(width), Math.round(height)];
  }
  const parts = ASPECT_RATIOS[aspect];
  if (!parts) return [Math.round(width), Math.round(height)];
  const m = Math.max(1, Math.round(multiple));
  const up = (v) => Math.max(m, Math.ceil(Math.trunc(v) / m) * m);
  const target = mp * 1048576;
  const [w, h] = parts;
  return [up(Math.sqrt(target * w / h)), up(Math.sqrt(target * h / w))];
}
const QUANTIZE_ROUND_UP = /* @__PURE__ */ new Set(["MiniMax H3 (17n+5)"]);
function quantizeCount(n, mode, k = 8) {
  n = Math.max(0, int(n));
  const grid = quantizeGrid(mode, k);
  if (!grid || n === 0) return n;
  const [step, offset] = grid;
  const low = firstStop(step, offset);
  if (n <= low) return low;
  const groups = (n - offset) / step;
  return offset + (QUANTIZE_ROUND_UP.has(mode) ? Math.ceil(groups) : Math.floor(groups)) * step;
}
function quantizeStops(max, mode, k = 8) {
  const grid = quantizeGrid(mode, k);
  if (!grid || max <= 0) return [];
  const [step, offset] = grid;
  const stops = [];
  for (let s = firstStop(step, offset); s <= max; s += step) stops.push(s);
  return stops;
}
function fadeFields(raw, length) {
  const g = num$1(raw == null ? void 0 : raw.gain, 1);
  const c = {
    length,
    fadeIn: Math.max(0, int(raw == null ? void 0 : raw.fadeIn)),
    fadeOut: Math.max(0, int(raw == null ? void 0 : raw.fadeOut))
  };
  clampFades(c);
  return {
    ...g !== 1 ? { gain: Math.max(0, Math.min(MAX_GAIN, g)) } : {},
    ...c.fadeIn ? { fadeIn: c.fadeIn } : {},
    ...c.fadeOut ? { fadeOut: c.fadeOut } : {}
  };
}
const MAX_GAIN = 2;
function clampFades(c) {
  const len = Math.max(0, c.length);
  let fi = Math.max(0, Math.round(c.fadeIn ?? 0));
  let fo = Math.max(0, Math.round(c.fadeOut ?? 0));
  if (fi + fo > len) {
    const k = fi + fo ? len / (fi + fo) : 0;
    fi = Math.floor(fi * k);
    fo = Math.floor(fo * k);
  }
  if (fi > 0) c.fadeIn = fi;
  else delete c.fadeIn;
  if (fo > 0) c.fadeOut = fo;
  else delete c.fadeOut;
}
function gainAt(c, offset) {
  if (c.muted) return 0;
  const g = c.gain ?? 1;
  const len = Math.max(0, c.length);
  if (offset < 0 || offset >= len) return 0;
  let k = 1;
  const fi = c.fadeIn ?? 0;
  if (fi > 0 && offset < fi) k = offset / fi;
  const fo = c.fadeOut ?? 0;
  if (fo > 0) {
    const fromEnd = len - offset;
    if (fromEnd < fo) k = Math.min(k, fromEnd / fo);
  }
  return g * k;
}
const GAIN_DB_STEP = 3;
const GAIN_DB_FLOOR = -30;
function snapGainToDb(g) {
  if (g <= 0) return 0;
  const db = 20 * Math.log10(g);
  if (db < GAIN_DB_FLOOR - GAIN_DB_STEP / 2) return 0;
  const snapped = Math.round(db / GAIN_DB_STEP) * GAIN_DB_STEP;
  return Math.min(MAX_GAIN, 10 ** (snapped / 20));
}
function levelStops(c) {
  const len = Math.max(0, c.length);
  const eps = Math.min(1e-6, len);
  const offs = [0, c.fadeIn ?? 0, len - (c.fadeOut ?? 0), len - eps].map((o) => Math.max(0, Math.min(len - eps, o)));
  return [...new Set(offs)].sort((a, b) => a - b).map((o) => [o, gainAt(c, o)]);
}
function cleanMarkers(raw, length) {
  if (!Array.isArray(raw)) return [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of raw) {
    const v = int(m, -1);
    if (v >= 0 && v < length) seen.add(v);
  }
  return [...seen].sort((a, b) => a - b);
}
function pruneMarkers(clip) {
  if (!clip.markers) return;
  const kept = cleanMarkers(clip.markers, clip.length);
  if (kept.length) clip.markers = kept;
  else delete clip.markers;
}
function shiftMarkers(clip, delta) {
  if (!clip.markers || !delta) return;
  clip.markers = clip.markers.map((m) => m - Math.round(delta));
  pruneMarkers(clip);
}
function toggleMarker(clip, f) {
  var _a;
  const off = Math.round(f) - clip.start;
  if (off < 0 || off >= clip.length) return false;
  const next = (clip.markers ?? []).filter((m) => m !== off);
  if (next.length === (((_a = clip.markers) == null ? void 0 : _a.length) ?? 0)) next.push(off);
  clip.markers = next.sort((a, b) => a - b);
  if (!clip.markers.length) delete clip.markers;
  return true;
}
function markerFrames(t) {
  const out = /* @__PURE__ */ new Set();
  for (const lane2 of allLanes(t)) {
    for (const c of lane2) for (const m of c.markers ?? []) out.add(c.start + m);
  }
  return [...out].sort((a, b) => a - b);
}
function clipBoundFrames(t) {
  const out = [];
  const clips = [...t.clips].sort((a, b) => a.start - b.start || a.track - b.track);
  for (const c of clips) {
    if (c.audioOnly) continue;
    out.push(c.start, c.start + c.length - 1);
  }
  return out;
}
function parseClipList(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const c of raw) {
    if (!c || typeof c !== "object" || !c.src) continue;
    const length = int(c.length);
    if (length <= 0) continue;
    const markers = cleanMarkers(c.markers, length);
    out.push({
      id: typeof c.id === "string" && c.id ? c.id : newId(),
      src: String(c.src),
      track: Math.max(0, int(c.track)),
      start: Math.max(0, int(c.start)),
      trimIn: Math.max(0, int(c.trimIn)),
      length,
      ...c.muted ? { muted: true } : {},
      ...c.audioOnly ? { audioOnly: true } : {},
      ...fadeFields(c, length),
      ...markers.length ? { markers } : {}
    });
  }
  return out;
}
function parseTimeline(raw) {
  const out = emptyTimeline();
  if (!raw || typeof raw !== "string") return out;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object") return out;
  out.clips = parseClipList(data.clips);
  out.masks = parseClipList(data.masks);
  if (Array.isArray(data.tracks)) {
    out.tracks = data.tracks.map((t) => ({
      blend: BLEND_MODES.includes(t == null ? void 0 : t.blend) ? t.blend : "normal"
    }));
  }
  if (Array.isArray(data.audio)) {
    for (const a of data.audio) {
      if (!a || typeof a !== "object" || !a.src) continue;
      const length = int(a.length);
      if (length <= 0) continue;
      out.audio.push({
        id: typeof a.id === "string" && a.id ? a.id : newId(),
        src: String(a.src),
        track: Math.max(0, int(a.track)),
        start: Math.max(0, int(a.start)),
        trimIn: Math.max(0, int(a.trimIn)),
        length,
        gain: num$1(a.gain, 1),
        ...a.muted ? { muted: true } : {},
        ...fadeFields(a, length)
      });
    }
  }
  if (data.ui && typeof data.ui === "object") {
    out.ui.zoom = Math.min(MAX_ZOOM, Math.max(1, num$1(data.ui.zoom, 1)));
    out.ui.scroll = Math.max(0, num$1(data.ui.scroll, 0));
    out.ui.playhead = Math.max(0, int(data.ui.playhead));
  }
  sortClips(out);
  return out;
}
function serialiseTimeline(t) {
  const plain = (c) => {
    var _a;
    return {
      id: c.id,
      src: c.src,
      track: c.track,
      start: c.start,
      trimIn: c.trimIn,
      length: c.length,
      ...c.muted ? { muted: true } : {},
      // omitted when false: keeps the JSON small
      ...c.audioOnly ? { audioOnly: true } : {},
      ...c.gain !== void 0 && c.gain !== 1 ? { gain: c.gain } : {},
      ...c.fadeIn ? { fadeIn: c.fadeIn } : {},
      ...c.fadeOut ? { fadeOut: c.fadeOut } : {},
      ...((_a = c.markers) == null ? void 0 : _a.length) ? { markers: c.markers } : {}
    };
  };
  return JSON.stringify({
    v: 1,
    clips: t.clips.map(plain),
    masks: t.masks.map(plain),
    tracks: t.tracks.map((x) => ({ blend: x.blend })),
    audio: t.audio.map((a) => ({
      id: a.id,
      src: a.src,
      start: a.start,
      trimIn: a.trimIn,
      length: a.length,
      gain: a.gain,
      ...a.track ? { track: a.track } : {},
      ...a.muted ? { muted: true } : {},
      ...a.fadeIn ? { fadeIn: a.fadeIn } : {},
      ...a.fadeOut ? { fadeOut: a.fadeOut } : {}
    })),
    // ZOOM, SCROLL AND PLAYHEAD ARE DELIBERATELY ABSENT. This string is a node INPUT,
    // and a widget value goes verbatim into ComfyUI's cache signature
    // (comfy_execution/caching.py:126), so anything written here invalidates the render.
    // The playhead only drives `current_frame` / `current_image` — scrubbing through the
    // preview should never re-render the entire graph. All three live in
    // `node.properties` instead, which persists with the workflow but is not an input.
    ui: {}
  });
}
function viewState(t) {
  return { zoom: t.ui.zoom, scroll: t.ui.scroll, playhead: t.ui.playhead };
}
function sortClips(t) {
  const byTrack = (a, b) => a.track - b.track || a.start - b.start;
  t.clips.sort(byTrack);
  t.masks.sort(byTrack);
  t.audio.sort((a, b) => a.start - b.start);
}
function slotInUse(t, src) {
  return allLanes(t).some((lane2) => lane2.some((c) => c.src === src));
}
function allLanes(t) {
  return [t.clips, t.masks, t.audio];
}
function sourceFrame(clip, f, srcFps, fps) {
  if (!(fps > 0)) return clip.trimIn;
  return clip.trimIn + Math.round((f - clip.start) * (srcFps / fps));
}
function timelineSpan(t) {
  let end = 0;
  for (const lane2 of allLanes(t)) {
    for (const c of lane2) end = Math.max(end, c.start + c.length);
  }
  return end;
}
function materialRange(t) {
  let start = Infinity;
  let end = 0;
  for (const lane2 of [t.clips, t.masks]) {
    for (const c of lane2) {
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
    }
  }
  return end > 0 && Number.isFinite(start) ? { start, end } : null;
}
function clipsAt(t, frame) {
  return t.clips.filter((c) => frame >= c.start && frame < c.start + c.length).sort((a, b) => b.track - a.track);
}
function effectiveCount(t, startFrame, frameCount, mode, k = 8) {
  const raw = frameCount > 0 ? frameCount : Math.max(0, timelineSpan(t) - startFrame);
  return quantizeCount(raw, mode, k);
}
function snap(value, candidates, threshold) {
  let best = value;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
function snapCandidates(t, extra = []) {
  const out = [0, t.ui.playhead, ...extra];
  for (const lane2 of allLanes(t)) {
    for (const c of lane2) out.push(c.start, c.start + c.length);
  }
  return out;
}
function snapFrameToGrid(frame, startFrame, mode, k = 8, withAudio = false, edge = "resume") {
  const tokens = TOKEN_GRIDS[mode];
  const rel = frame - startFrame;
  if (tokens) {
    if (rel <= 0) return startFrame;
    const stops = cutStops(rel + Math.max(tokens.chunk, tokens.ratio) * 2, mode, withAudio, edge);
    let best = stops[0] ?? 0;
    for (const s of stops) if (Math.abs(s - rel) < Math.abs(best - rel)) best = s;
    return startFrame + best;
  }
  const grid = quantizeGrid(mode, k);
  if (!grid) return Math.round(frame);
  const [step, offset] = grid;
  const low = firstStop(step, offset);
  if (rel <= low) return startFrame + low;
  return startFrame + offset + Math.round((rel - offset) / step) * step;
}
function moveClip(clip, start, track) {
  clip.start = Math.max(0, Math.round(start));
  clip.track = Math.max(0, Math.round(track));
}
function trimStart(clip, newStart, srcFps, fps) {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const end = clip.start + clip.length;
  const minStart = clip.start - Math.floor(clip.trimIn / (ratio || 1));
  const s = Math.max(0, Math.max(minStart, Math.min(Math.round(newStart), end - 1)));
  const delta = s - clip.start;
  clip.trimIn = Math.max(0, clip.trimIn + Math.round(delta * ratio));
  clip.start = s;
  clip.length = end - s;
  clampFades(clip);
  shiftMarkers(clip, delta);
}
function trimEnd(clip, newEnd, srcFrames, srcFps, fps) {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const maxLen = srcFrames > 0 ? Math.max(1, Math.floor((srcFrames - clip.trimIn) / (ratio || 1))) : Number.MAX_SAFE_INTEGER;
  clip.length = Math.max(1, Math.min(Math.round(newEnd) - clip.start, maxLen));
  clampFades(clip);
  pruneMarkers(clip);
}
function rollEdit(left, right, frame, fps, srcFramesFor, rateFor) {
  const lRate = rateFor(left) || fps;
  const rRate = rateFor(right) || fps;
  const lRatio = fps > 0 ? lRate / fps : 1;
  const rRatio = fps > 0 ? rRate / fps : 1;
  const lSrc = srcFramesFor(left);
  const lMax = lSrc && lSrc > 0 ? left.start + Math.max(1, Math.floor((lSrc - left.trimIn) / (lRatio || 1))) : Number.MAX_SAFE_INTEGER;
  const hi = Math.min(right.start + right.length - 1, lMax);
  const lo = Math.max(left.start + 1, right.start - Math.floor(right.trimIn / (rRatio || 1)));
  const f = Math.max(lo, Math.min(Math.round(frame), hi));
  if (f === right.start || hi < lo) return false;
  trimEnd(left, f, 0, lRate, fps);
  trimStart(right, f, rRate, fps);
  return true;
}
function splitClip(clip, frame, srcFps, fps) {
  const at = Math.round(frame);
  if (!(at > clip.start && at < clip.start + clip.length)) return null;
  const ratio = fps > 0 ? srcFps / fps : 1;
  const leftLen = at - clip.start;
  const right = {
    ...clip,
    id: newId(),
    start: at,
    length: clip.length - leftLen,
    trimIn: Math.max(0, clip.trimIn + Math.round(leftLen * ratio))
  };
  const marks = clip.markers ?? [];
  const rightMarks = marks.filter((m) => m >= leftLen).map((m) => m - leftLen);
  clip.length = leftLen;
  clampFades(clip);
  clampFades(right);
  clip.markers = cleanMarkers(marks, clip.length);
  if (!clip.markers.length) delete clip.markers;
  right.markers = cleanMarkers(rightMarks, right.length);
  if (!right.markers.length) delete right.markers;
  return right;
}
function slipClip(clip, deltaFrames, srcFrames, srcFps, fps) {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const used = Math.ceil(clip.length * ratio);
  const maxTrim = srcFrames > 0 ? Math.max(0, srcFrames - used) : Number.MAX_SAFE_INTEGER;
  const before = clip.trimIn;
  clip.trimIn = Math.max(0, Math.min(maxTrim, clip.trimIn + Math.round(deltaFrames * ratio)));
  shiftMarkers(clip, (clip.trimIn - before) / (ratio || 1));
}
function moveClipToLane(t, clip, toMask) {
  const from = toMask ? t.clips : t.masks;
  const to = toMask ? t.masks : t.clips;
  const i = from.indexOf(clip);
  if (i < 0) return;
  from.splice(i, 1);
  clip.track = 0;
  to.push(clip);
  sortClips(t);
}
function cropToRange(t, start, end, fps, rateFor) {
  let changed = false;
  for (const lane2 of allLanes(t)) {
    const kept = [];
    for (const c of lane2) {
      if (c.start + c.length <= start || c.start >= end) {
        changed = true;
        continue;
      }
      const rate = rateFor(c) || fps;
      if (c.start + c.length > end) {
        trimEnd(c, end, 0, rate, fps);
        changed = true;
      }
      if (c.start < start) {
        trimStart(c, start, rate, fps);
        changed = true;
      }
      kept.push(c);
    }
    if (kept.length !== lane2.length) {
      lane2.length = 0;
      lane2.push(...kept);
    }
  }
  return changed;
}
function trimToPlayhead(t, frame, side, fps, rateFor, only) {
  let changed = false;
  for (const lane2 of allLanes(t)) {
    for (const c of lane2) {
      if (only && !only.has(c.id)) continue;
      if (frame <= c.start || frame >= c.start + c.length) continue;
      const rate = rateFor(c) || fps;
      if (side === "start") trimStart(c, frame, rate, fps);
      else trimEnd(c, frame, 0, rate, fps);
      changed = true;
    }
  }
  return changed;
}
function clampClipsToSources(t, fps, srcFramesFor, rateFor) {
  let changed = false;
  for (const lane2 of allLanes(t)) {
    for (const c of lane2) {
      const srcFrames = srcFramesFor(c);
      if (srcFrames === null || srcFrames <= 0) continue;
      const ratio = (rateFor(c) || fps) / (fps || 1);
      if (c.trimIn >= srcFrames) {
        c.trimIn = 0;
        changed = true;
      }
      const maxLen = Math.max(1, Math.floor((srcFrames - c.trimIn) / (ratio || 1)));
      if (c.length > maxLen) {
        c.length = maxLen;
        clampFades(c);
        pruneMarkers(c);
        changed = true;
      }
    }
  }
  return changed;
}
function expandClipsToSources(t, fps, srcFramesFor, rateFor, ids) {
  let changed = false;
  for (const lane2 of allLanes(t)) {
    for (const c of lane2) {
      if (ids && !ids.has(c.id)) continue;
      const srcFrames = srcFramesFor(c);
      if (srcFrames === null || srcFrames <= 0) continue;
      const ratio = (rateFor(c) || fps) / (fps || 1);
      const full = Math.max(1, Math.floor(srcFrames / (ratio || 1)));
      if (c.trimIn === 0 && c.length === full) continue;
      if (c.trimIn !== 0) c.markers = [];
      c.trimIn = 0;
      c.length = full;
      changed = true;
    }
  }
  return changed;
}
function clipExtent(t, frame, ids) {
  let start = Infinity;
  let end = 0;
  for (const lane2 of allLanes(t)) {
    for (const c of lane2) {
      const hit = ids ? ids.has(c.id) : frame >= c.start && frame < c.start + c.length;
      if (!hit) continue;
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
    }
  }
  return end > 0 && Number.isFinite(start) ? { start, end } : null;
}
function placementFor(t, lane2, mode) {
  if (mode === "stack") {
    const track = lane2.reduce((m, c) => Math.max(m, c.track + 1), 0);
    return { start: 0, track };
  }
  const start = lane2.filter((c) => c.track === 0).reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return { start, track: 0 };
}
function fitRect(sw, sh, dw, dh, mode) {
  if (sw <= 0 || sh <= 0) return { x: 0, y: 0, w: dw, h: dh };
  if (mode === "stretch") return { x: 0, y: 0, w: dw, h: dh };
  const scale2 = mode === "cover" ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = sw * scale2;
  const h = sh * scale2;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}
const ENV_BUCKET = 256;
function buildEnvelope(buf) {
  const out = [];
  const n = Math.max(1, Math.ceil(buf.length / ENV_BUCKET));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    const mn = new Float32Array(n);
    const mx = new Float32Array(n);
    const rms = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      const from = b * ENV_BUCKET;
      const to = Math.min(d.length, from + ENV_BUCKET);
      let lo = 0, hi = 0, sq = 0;
      for (let i = from; i < to; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sq += v * v;
      }
      mn[b] = lo;
      mx[b] = hi;
      rms[b] = to > from ? Math.sqrt(sq / (to - from)) : 0;
    }
    out.push({ min: mn, max: mx, rms });
  }
  return out;
}
const STEREO_MIN_H = 28;
const DB_FLOOR = -60;
function scale(v, db) {
  if (!db) return v;
  const m = Math.abs(v);
  if (m <= 1e-6) return 0;
  const d = 20 * Math.log10(m);
  if (d <= DB_FLOOR) return 0;
  return (1 - d / DB_FLOOR) * (v < 0 ? -1 : 1);
}
function column(buf, env, chans, s0, s1, out) {
  let lo = 0, hi = 0, sq = 0, n = 0;
  if (s1 - s0 >= ENV_BUCKET) {
    const b0 = Math.max(0, Math.floor(s0 / ENV_BUCKET));
    const b1 = Math.max(b0 + 1, Math.floor(s1 / ENV_BUCKET));
    for (const ch of chans) {
      const e = env[ch];
      if (!e) continue;
      const end = Math.min(e.min.length, b1);
      for (let b = b0; b < end; b++) {
        if (e.min[b] < lo) lo = e.min[b];
        if (e.max[b] > hi) hi = e.max[b];
        sq += e.rms[b] * e.rms[b];
        n++;
      }
    }
  } else {
    const i0 = Math.max(0, Math.floor(s0));
    const i1 = Math.max(i0 + 1, Math.ceil(s1));
    for (const ch of chans) {
      const d = buf.getChannelData(ch);
      const end = Math.min(d.length, i1);
      for (let i = i0; i < end; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sq += v * v;
        n++;
      }
    }
  }
  out.min = lo;
  out.max = hi;
  out.rms = n ? Math.sqrt(sq / n) : 0;
}
function lane(ctx, buf, env, chans, fromSec, toSec, x, y, w, h, x0, x1, colors, db) {
  const mid = y + h / 2;
  const half = h / 2;
  const sr = buf.sampleRate;
  const spanSec = Math.max(1e-9, toSec - fromSec);
  const samplesPerPx = spanSec * sr / Math.max(1, w);
  ctx.fillStyle = colors.zero;
  ctx.fillRect(x + x0, mid, x1 - x0, 1);
  if (samplesPerPx < 1) {
    ctx.strokeStyle = colors.peak;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const d = buf.getChannelData(chans[0]);
    for (let px = x0; px < x1; px++) {
      const i = Math.round((fromSec + spanSec * (px / Math.max(1, w))) * sr);
      const v = scale(i >= 0 && i < d.length ? d[i] : 0, db);
      const py = mid - v * half;
      if (px === x0) ctx.moveTo(x + px + 0.5, py);
      else ctx.lineTo(x + px + 0.5, py);
    }
    ctx.stroke();
    return;
  }
  const col = { min: 0, max: 0, rms: 0 };
  ctx.fillStyle = colors.peak;
  for (let px = x0; px < x1; px++) {
    const t0 = fromSec + spanSec * (px / Math.max(1, w));
    const t1 = fromSec + spanSec * ((px + 1) / Math.max(1, w));
    column(buf, env, chans, t0 * sr, t1 * sr, col);
    const top = mid - scale(col.max, db) * half;
    const bot = mid - scale(col.min, db) * half;
    ctx.fillRect(x + px, top, 1, Math.max(1, bot - top));
  }
  ctx.fillStyle = colors.body;
  for (let px = x0; px < x1; px++) {
    const t0 = fromSec + spanSec * (px / Math.max(1, w));
    const t1 = fromSec + spanSec * ((px + 1) / Math.max(1, w));
    column(buf, env, chans, t0 * sr, t1 * sr, col);
    const r = scale(col.rms, db) * half;
    if (r <= 0.5) continue;
    ctx.fillRect(x + px, mid - r, 1, r * 2);
  }
}
function drawWave(ctx, buf, env, fromSec, toSec, x, y, w, h, colors, db, visibleX0 = -Infinity, visibleX1 = Infinity) {
  if (w <= 0 || h <= 2 || !env.length) return;
  const x0 = Math.max(0, Math.floor(visibleX0 - x));
  const x1 = Math.min(Math.ceil(w), Math.ceil(visibleX1 - x));
  if (x1 <= x0) return;
  if (env.length >= 2 && h >= STEREO_MIN_H) {
    const lh = h / 2;
    lane(ctx, buf, env, [0], fromSec, toSec, x, y, w, lh, x0, x1, colors, db);
    lane(ctx, buf, env, [1], fromSec, toSec, x, y + lh, w, lh, x0, x1, colors, db);
    return;
  }
  const all = env.map((_, i) => i);
  lane(ctx, buf, env, all, fromSec, toSec, x, y, w, h, x0, x1, colors, db);
}
const refKey = (r) => `${r.type}|${r.subfolder}|${r.filename}`;
let cacheBust = 0;
function viewUrl(ref) {
  const q = new URLSearchParams({
    filename: ref.filename,
    type: ref.type || "input",
    subfolder: ref.subfolder || ""
  });
  if (cacheBust) q.set("_nkd", String(cacheBust));
  return api.apiURL(`/view?${q}`);
}
function bustCaches() {
  cacheBust += 1;
  infoCache.clear();
  thumbCache.clear();
  audioCache.clear();
  peakCache.clear();
}
function forgetFile(ref) {
  const key = refKey(ref);
  stripRefs.delete(key);
  infoCache.delete(key);
  thumbCache.delete(key);
  audioCache.delete(key);
  peakCache.delete(key);
}
const FILE_WIDGETS = ["file", "video", "audio", "image", "filename", "path"];
const looksLikeFile = (v) => typeof v === "string" && v.length > 0 && v !== "none" && /\.[a-z0-9]{2,5}$/i.test(v);
function resolveSource(node, slotName, maxDepth = 6, depth = 0) {
  var _a, _b, _c, _d;
  if (depth > maxDepth) return null;
  const slot = (_a = node == null ? void 0 : node.inputs) == null ? void 0 : _a.find((i) => {
    var _a2;
    return i.name === slotName || ((_a2 = i.name) == null ? void 0 : _a2.endsWith(`.${slotName}`));
  });
  if (!slot || slot.link == null) return null;
  const link = (_b = node.graph) == null ? void 0 : _b.getLink(slot.link);
  const src = link && ((_c = node.graph) == null ? void 0 : _c.getNodeById(link.origin_id));
  if (!src) return null;
  for (const name of FILE_WIDGETS) {
    const w = (_d = src.widgets) == null ? void 0 : _d.find((x) => x.name === name);
    if (w && looksLikeFile(w.value)) {
      const raw = String(w.value);
      const m = /^(.*?)\s*\[(\w+)\]$/.exec(raw);
      const clean = m ? m[1] : raw;
      const cut = clean.lastIndexOf("/");
      return {
        filename: cut >= 0 ? clean.slice(cut + 1) : clean,
        subfolder: cut >= 0 ? clean.slice(0, cut) : "",
        type: m ? m[2] : "input"
      };
    }
  }
  if (src.type === "NKDTimeline" || src.type === "NKDAudioTimeline") return null;
  for (const inp of src.inputs ?? []) {
    if (inp.link == null) continue;
    const up = resolveSource(src, inp.name, maxDepth, depth + 1);
    if (up) return up;
  }
  return null;
}
function slotKind(node, slotName) {
  var _a, _b, _c, _d, _e;
  const slot = (_a = node == null ? void 0 : node.inputs) == null ? void 0 : _a.find(
    (i) => {
      var _a2;
      return i.name === slotName || ((_a2 = i.name) == null ? void 0 : _a2.endsWith(`.${slotName}`));
    }
  );
  if (!slot || slot.link == null) return null;
  const link = (_b = node.graph) == null ? void 0 : _b.getLink(slot.link);
  let type = link == null ? void 0 : link.type;
  if (!type && link) {
    const src = (_c = node.graph) == null ? void 0 : _c.getNodeById(link.origin_id);
    type = (_e = (_d = src == null ? void 0 : src.outputs) == null ? void 0 : _d[link.origin_slot]) == null ? void 0 : _e.type;
  }
  const t = String(type ?? "").toUpperCase();
  if (t.includes("VIDEO")) return "video";
  if (t.includes("AUDIO")) return "audio";
  if (t.includes("MASK")) return "mask";
  if (t.includes("IMAGE")) return "image";
  return null;
}
const infoCache = /* @__PURE__ */ new Map();
const infoPending = /* @__PURE__ */ new Map();
function probe(ref) {
  const key = refKey(ref);
  const hit = infoCache.get(key);
  if (hit) return Promise.resolve(hit);
  const flight = infoPending.get(key);
  if (flight) return flight;
  const q = new URLSearchParams({
    filename: ref.filename,
    type: ref.type || "input",
    subfolder: ref.subfolder || ""
  });
  const p = api.fetchApi(`/nkd/timeline/probe?${q}`).then((r) => r.ok ? r.json() : null).then((info) => {
    if (info && info.frame_count > 0) infoCache.set(key, info);
    return info;
  }).catch(() => null).finally(() => infoPending.delete(key));
  infoPending.set(key, p);
  return p;
}
const cachedInfo = (ref) => infoCache.get(refKey(ref));
const stripRefs = /* @__PURE__ */ new Set();
const DRIFT_S = 0.25;
class VideoPool {
  constructor() {
    __publicField(this, "pool", /* @__PURE__ */ new Map());
    /** Called whenever one of our elements gains something new to show, so the editor can
     *  repaint instead of waiting for the next poll. One per pool, so several editors do not
     *  overwrite each other's - the last one registered used to win, and the rest went
     *  quiet. */
    __publicField(this, "onReady", null);
  }
  make(ref) {
    const el2 = document.createElement("video");
    el2.src = viewUrl(ref);
    el2.muted = true;
    el2.playsInline = true;
    el2.preload = "auto";
    el2.crossOrigin = "anonymous";
    const entry = {
      el: el2,
      good: document.createElement("canvas"),
      hasGood: false,
      wantTime: -1,
      sentTime: -1,
      seeking: false,
      guard: 0
    };
    el2.addEventListener("loadedmetadata", () => this.applySeek(entry));
    el2.addEventListener("seeked", () => {
      window.clearTimeout(entry.guard);
      entry.seeking = false;
      captureGood(entry);
      if (entry.wantTime >= 0 && Math.abs(entry.wantTime - entry.sentTime) > 1e-3) {
        this.applySeek(entry);
      }
    });
    el2.addEventListener("loadeddata", () => {
      var _a;
      captureGood(entry);
      (_a = this.onReady) == null ? void 0 : _a.call(this);
      ensureAudio(ref, () => {
        var _a2;
        return (_a2 = this.onReady) == null ? void 0 : _a2.call(this);
      });
    });
    return entry;
  }
  entry(ref) {
    const key = refKey(ref);
    let p = this.pool.get(key);
    if (!p) {
      p = this.make(ref);
      this.pool.set(key, p);
    }
    return p;
  }
  /**
   * Ask the element to seek, but only once it can.
   *
   * Assigning `currentTime` while `readyState` is HAVE_NOTHING is IGNORED by the browser -
   * silently, without throwing - so `seeked` never fires. Setting `seeking = true` around
   * that leaves the flag stuck forever, every later seek short-circuits on it, and the
   * preview freezes on whatever frame was captured first. It only ever worked after a hard
   * reload because the cached file has its metadata ready in the same tick.
   */
  applySeek(p) {
    if (p.seeking || p.wantTime < 0) return;
    if (p.el.readyState < 1) return;
    p.seeking = true;
    try {
      p.el.currentTime = p.wantTime;
      p.sentTime = p.wantTime;
    } catch {
      p.seeking = false;
      return;
    }
    window.clearTimeout(p.guard);
    p.guard = window.setTimeout(() => {
      var _a;
      p.seeking = false;
      captureGood(p);
      (_a = this.onReady) == null ? void 0 : _a.call(this);
    }, 2e3);
  }
  videoFor(ref) {
    return this.entry(ref).el;
  }
  /** Pide un instante. Coalescente: durante un arrastre llegan decenas de peticiones por
   *  segundo y el `<video>` solo puede atender una a la vez. */
  seekTo(ref, seconds, tolerance = 0.02) {
    const p = this.entry(ref);
    const want = Math.max(0, seconds);
    if (p.el.readyState >= 1 && !p.seeking && Math.abs(p.el.currentTime - want) < tolerance) {
      p.wantTime = want;
      return;
    }
    p.wantTime = want;
    this.applySeek(p);
  }
  /**
   * Let the element PLAY and only correct it when it has drifted.
   *
   * During playback, seeking once per displayed frame is what makes a preview stutter: an
   * h264 seek is far more expensive than simply decoding forward. So while running at 1x we
   * hand the browser the job it is good at and step in only past the drift threshold - big
   * enough to absorb ordinary jitter, small enough that a cut is never visibly late.
   */
  followPlayback(ref, seconds) {
    const p = this.entry(ref);
    if (p.el.paused) {
      p.wantTime = Math.max(0, seconds);
      this.applySeek(p);
      void p.el.play().catch(() => {
      });
      return;
    }
    if (Math.abs(p.el.currentTime - seconds) > DRIFT_S) {
      p.wantTime = Math.max(0, seconds);
      this.applySeek(p);
    }
  }
  /**
   * The picture to draw for a source at `seconds`, whatever kind of source it is.
   *
   * The single place that knows a TENSOR source has no video element behind it. Pointing
   * the pool at its contact sheet would spawn a `<video>` on a PNG: no error, no `seeked`,
   * just a slot that never draws - so route strips to their stills and leave the pool to
   * the sources that actually have a file to seek.
   */
  pictureAt(ref, seconds, playing2) {
    if (stripRefs.has(refKey(ref))) return thumbnailAt(ref, seconds);
    if (playing2) this.followPlayback(ref, seconds);
    else this.seekTo(ref, seconds, 0.02);
    return this.frameSource(ref);
  }
  /** Lo que hay que pintar AHORA: el frame vivo si está listo, y si no el último bueno. */
  frameSource(ref) {
    const p = this.pool.get(refKey(ref));
    if (!p) return null;
    if (!p.seeking && p.el.readyState >= 2) return p.el;
    return p.hasGood ? p.good : null;
  }
  /** Stop our elements. Called when the transport stops, so a clip that scrolled out from
   *  under the playhead does not keep decoding in the background. */
  pauseAll() {
    for (const p of this.pool.values()) {
      if (!p.el.paused) p.el.pause();
    }
  }
  drop(key) {
    const p = this.pool.get(key);
    if (!p) return;
    window.clearTimeout(p.guard);
    p.el.removeAttribute("src");
    p.el.load();
    this.pool.delete(key);
  }
  /** Suelta los elementos que ya no usa ningún clip — un `<video>` retenido mantiene el
   *  fichero decodificándose en memoria. */
  releaseUnused(active) {
    const keep = /* @__PURE__ */ new Set();
    for (const r of active) keep.add(refKey(r));
    for (const key of [...this.pool.keys()]) {
      if (!keep.has(key)) this.drop(key);
    }
  }
  /** Everything, on teardown. */
  releaseAll() {
    this.releaseUnused([]);
  }
  /** A slot silently started pointing somewhere else: drop the file's shared caches and
   *  our element for it. */
  forget(ref) {
    forgetFile(ref);
    this.drop(refKey(ref));
  }
  /**
   * The ↻ button: assume every file on disk changed under us.
   *
   * The shared caches and the URL counter are cleared GLOBALLY because the staleness is
   * global - the bytes really did change for everyone.
   * ponytail: but only THIS node's elements are torn down. The other nodes keep the
   * element they are holding until they next release it; the button is pressed on one node
   * and reloading half the workflow's video behind the user's back is the louder bug.
   */
  bust() {
    bustCaches();
    this.releaseAll();
  }
}
function captureGood(p) {
  const { el: el2, good } = p;
  if (!el2.videoWidth || !el2.videoHeight) return;
  if (good.width !== el2.videoWidth) good.width = el2.videoWidth;
  if (good.height !== el2.videoHeight) good.height = el2.videoHeight;
  try {
    good.getContext("2d").drawImage(el2, 0, 0);
    p.hasGood = true;
  } catch {
  }
}
const thumbCache = /* @__PURE__ */ new Map();
const thumbJobs = /* @__PURE__ */ new Map();
function thumbCount(duration) {
  return Math.max(6, Math.min(48, Math.ceil(duration * 2)));
}
function ensureThumbnails(ref, info, onFrame) {
  const key = refKey(ref);
  const have = thumbCache.get(key);
  if (have) return have;
  if (thumbJobs.has(key)) return [];
  const strip = [];
  thumbCache.set(key, strip);
  const job = new Promise((resolve) => {
    const el2 = document.createElement("video");
    el2.src = viewUrl(ref);
    el2.muted = true;
    el2.preload = "auto";
    el2.crossOrigin = "anonymous";
    const duration = info.duration || 1;
    const n = thumbCount(duration);
    let i = 0;
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      el2.removeAttribute("src");
      el2.load();
      resolve();
    };
    const grab = () => {
      if (i >= n) return done();
      el2.currentTime = (i + 0.5) / n * duration;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        i += 1;
        grab();
      }, 2e3);
    };
    el2.addEventListener("seeked", () => {
      window.clearTimeout(timer);
      if (el2.videoWidth && el2.videoHeight) {
        const h = 64;
        const c = document.createElement("canvas");
        c.height = h;
        c.width = Math.max(1, Math.round(el2.videoWidth / el2.videoHeight * h));
        try {
          c.getContext("2d").drawImage(el2, 0, 0, c.width, c.height);
          strip.push({ time: el2.currentTime, canvas: c });
          onFrame();
        } catch {
        }
      }
      i += 1;
      grab();
    });
    el2.addEventListener("error", done);
    el2.addEventListener("loadeddata", grab, { once: true });
  }).finally(() => thumbJobs.delete(key));
  thumbJobs.set(key, job);
  return strip;
}
const stripFrame = (i, tiles, n) => Math.min(n - 1, Math.floor((i + 0.5) * n / tiles));
function adoptStrip(ref, info, tiles, cols, onReady) {
  const key = refKey(ref);
  stripRefs.add(key);
  if (thumbCache.has(key)) return;
  infoCache.set(key, info);
  const strip = [];
  thumbCache.set(key, strip);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const rows = Math.max(1, Math.ceil(tiles / cols));
    const tw = img.width / cols;
    const th = img.height / rows;
    for (let i = 0; i < tiles; i++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(tw));
      c.height = Math.max(1, Math.round(th));
      c.getContext("2d").drawImage(
        img,
        Math.round(i % cols * tw),
        Math.round(Math.floor(i / cols) * th),
        c.width,
        c.height,
        0,
        0,
        c.width,
        c.height
      );
      strip.push({
        time: stripFrame(i, tiles, info.frame_count) / (info.fps || 1),
        canvas: c
      });
    }
    onReady();
  };
  img.src = viewUrl(ref);
}
function thumbnailAt(ref, seconds) {
  const strip = thumbCache.get(refKey(ref));
  if (!strip || strip.length === 0) return null;
  let best = strip[0];
  let dist = Math.abs(best.time - seconds);
  for (const t of strip) {
    const d = Math.abs(t.time - seconds);
    if (d < dist) {
      dist = d;
      best = t;
    }
  }
  return best.canvas;
}
const audioCache = /* @__PURE__ */ new Map();
const peakCache = /* @__PURE__ */ new Map();
const audioJobs = /* @__PURE__ */ new Map();
let audioCtx = null;
function audioContext() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}
function ensureAudio(ref, onDone) {
  const key = refKey(ref);
  if (audioCache.has(key)) {
    onDone();
    return;
  }
  const flight = audioJobs.get(key);
  if (flight) {
    void flight.then(() => onDone());
    return;
  }
  const job = fetch(viewUrl(ref)).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error("fetch failed"))).then((buf) => audioContext().decodeAudioData(buf)).then((decoded) => {
    audioCache.set(key, decoded);
    peakCache.set(key, buildEnvelope(decoded));
    return decoded;
  }).catch(() => null).finally(() => {
    audioJobs.delete(key);
    onDone();
  });
  audioJobs.set(key, job);
}
const peaksFor = (ref) => peakCache.get(refKey(ref));
const audioBufferFor = (ref) => audioCache.get(refKey(ref));
const SHUTTLE$1 = [1, 2, 4, 8];
let playing = null;
function applyFades(param, c, startOff, endOff, when, fps) {
  const base = c.gain ?? 1;
  const at = (off) => when + (off - startOff) / fps;
  param.setValueAtTime(gainAt(c, startOff), when);
  const fi = c.fadeIn ?? 0;
  if (fi > startOff && fi < endOff) param.linearRampToValueAtTime(base, at(fi));
  const fo = c.fadeOut ?? 0;
  const foStart = c.length - fo;
  if (fo > 0 && foStart < endOff) {
    if (foStart > startOff) param.setValueAtTime(base, at(foStart));
    param.linearRampToValueAtTime(gainAt(c, endOff - 1e-6), at(endOff));
  }
}
class Transport {
  constructor(host) {
    __publicField(this, "host");
    __publicField(this, "raf", 0);
    __publicField(this, "last", 0);
    /** Signed: negative is reverse. 0 means stopped. */
    __publicField(this, "speed", 0);
    /**
     * Sub-frame playhead position, kept HERE as a float.
     *
     * It must never be re-read from `ui.playhead`, which is rounded for display: at 24 fps
     * on a 60 Hz frame loop each tick advances ~0.4 frames, `Math.round` throws that away,
     * and the next tick starts from the same integer again - the playhead sticks while the
     * <video> plays on, until the drift correction yanks the picture backwards. That is the
     * classic accumulate-into-a-rounded-value bug, and it looks exactly like a stutter.
     */
    __publicField(this, "pos", 0);
    __publicField(this, "nodes", []);
    __publicField(this, "gain", null);
    __publicField(this, "onChange", null);
    __publicField(this, "tick", (now) => {
      if (this.speed === 0) {
        this.raf = 0;
        return;
      }
      const dt = Math.min(0.25, (now - this.last) / 1e3);
      this.last = now;
      const fps = this.host.getFps();
      const start = this.host.getStartFrame();
      const end = this.host.getEndFrame();
      this.pos += dt * fps * this.speed;
      if (this.pos >= end - 1) {
        this.pos = start;
        this.restartAudio();
      } else if (this.pos < start) {
        this.pos = end - 1;
        this.restartAudio();
      }
      this.host.seek(Math.round(this.pos));
      this.raf = requestAnimationFrame(this.tick);
    });
    this.host = host;
  }
  get rate() {
    return this.speed;
  }
  /** Space / the play button: toggle between stopped and 1x forward. */
  toggle() {
    if (this.speed === 0) this.play(1);
    else this.stop();
  }
  /** L steps forward through the shuttle speeds, J steps backward. Pressing the opposite
   *  direction first brings it back to a stop, the way every NLE behaves. */
  shuttle(dir) {
    const cur = this.speed;
    if (cur === 0 || Math.sign(cur) !== dir) {
      this.play(dir);
      return;
    }
    const i = SHUTTLE$1.indexOf(Math.abs(cur));
    this.play(dir * SHUTTLE$1[Math.min(SHUTTLE$1.length - 1, i + 1)]);
  }
  play(speed) {
    var _a;
    if (playing && playing !== this) playing.stop();
    playing = this;
    this.speed = speed;
    this.pos = this.host.getTimeline().ui.playhead;
    this.last = performance.now();
    this.scheduleAudio();
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    (_a = this.onChange) == null ? void 0 : _a.call(this);
  }
  stop() {
    var _a;
    if (playing === this) playing = null;
    this.speed = 0;
    this.stopAudio();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    (_a = this.onChange) == null ? void 0 : _a.call(this);
  }
  // ── Audio ───────────────────────────────────────────────────────────────────
  stopAudio() {
    var _a;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
      }
    }
    this.nodes = [];
    (_a = this.gain) == null ? void 0 : _a.disconnect();
    this.gain = null;
  }
  /** Re-schedule from the current position: a mute toggled mid-playback. */
  refreshAudio() {
    if (this.speed === 1) this.restartAudio();
  }
  restartAudio() {
    this.stopAudio();
    this.scheduleAudio();
  }
  /**
   * Schedule every audio clip that is still ahead of the playhead, each at its own offset
   * on the AudioContext clock. Scheduling up front is what keeps it in sync: nudging
   * playback from a rAF loop would drift audibly within seconds.
   *
   * Reverse and shuttle speeds run silent - browsers cannot play a buffer backwards, and
   * pitch-shifted scrub audio is noise rather than information.
   */
  scheduleAudio() {
    this.stopAudio();
    if (this.speed !== 1) return;
    const ctx = audioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const tl = this.host.getTimeline();
    const fps = this.host.getFps();
    const end = this.host.getEndFrame();
    const now = Math.round(this.pos);
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    const lanes = [
      ...tl.audio.map((a) => ({ ...a, sourceRate: false })),
      ...tl.clips.map((c) => ({ ...c, sourceRate: true }))
    ];
    for (const a of lanes) {
      if (a.muted) continue;
      const ref = this.host.audioRefFor(a.src);
      if (!ref) continue;
      const buf = audioBufferFor(ref);
      if (!buf) {
        ensureAudio(ref, () => {
          if (this.speed === 1) this.restartAudio();
        });
        continue;
      }
      const clipEnd = Math.min(a.start + a.length, end);
      if (clipEnd <= now) continue;
      const from = Math.max(a.start, now);
      const when = ctx.currentTime + (from - now) / fps;
      const rate = a.sourceRate ? this.host.srcFpsFor(a.src) || fps : fps;
      const offset = a.trimIn / rate + (from - a.start) / fps;
      const duration = (clipEnd - from) / fps;
      if (duration <= 0 || offset >= buf.duration) continue;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const g = ctx.createGain();
      applyFades(g.gain, a, from - a.start, clipEnd - a.start, when, fps);
      node.connect(g);
      g.connect(this.gain);
      node.start(when, offset, Math.min(duration, buf.duration - offset));
      this.nodes.push(node);
    }
  }
  /** The user grabbed the playhead while it was running: adopt their position instead of
   *  fighting them back to ours. */
  reanchor(frame) {
    this.pos = frame;
  }
  destroy() {
    var _a;
    this.stop();
    (_a = this.gain) == null ? void 0 : _a.disconnect();
    this.gain = null;
  }
}
const WAVE_COLORS = {
  peak: "rgba(120,190,235,0.65)",
  body: "rgba(165,225,255,0.95)",
  zero: "rgba(255,255,255,0.22)"
};
const C = {
  bg: "#16181d",
  trackBg: "#1b1e24",
  trackAlt: "#191c21",
  bar: "#1a1c22",
  gridLine: "#0f1114",
  accent: "#4ab4ff",
  dim: "rgba(255,255,255,0.45)",
  faint: "rgba(255,255,255,0.20)",
  hover: "#ffd166",
  active: "#ff6b6b",
  // Premiere-ish clip colours: one flat fill, a slightly lighter header band, a dark
  // outline. No gradient.
  clipFill: "#1d5673",
  clipHead: "#2a7099",
  clipEdge: "#0e2c3d",
  audioFill: "#1a4a63",
  audioHead: "#246186",
  // The mask lane reads as monochrome, because that is what it produces.
  maskFill: "#3a3f45",
  maskHead: "#565d66",
  clipName: "#e8f2f8",
  // Freeze-frame markers. Green, because every other signal on a clip is already blue
  // (selection), amber (hover/gaps) or red (active drag).
  marker: "#7bd88f",
  markerLine: "rgba(123,216,143,0.55)",
  outside: "rgba(0,0,0,0.55)",
  gap: "rgba(255,209,102,0.07)"
};
const RULER_H = 27;
const IO_BAR_H = 7;
const IO_BAR_TOP = RULER_H - IO_BAR_H;
const IO_GRAB_PX = 7;
const CLIP_HEAD_H = 15;
const HANDLE_PX = 16;
const ROLL_PX = 6;
const MUTE_BOX = 16;
const MUTE_PAD = 5;
const MUTE_INSET = HANDLE_PX + 10;
const PREVIEW_MAX_H$1 = 260;
const TRACK_H = 46;
const MASK_H = 30;
const AUDIO_H = 34;
const AUDIO_ONLY_H = 74;
const MIN_VIDEO_TRACKS = 2;
const MAX_VIDEO_TRACKS = 8;
const MIN_AUDIO_TRACKS = 1;
const MAX_AUDIO_TRACKS = 6;
const SCALE_WARN_RATIO = 6;
const HANDLE_CORE = 4;
const FADE_BAND_H = 12;
const FADE_GRIP = 7;
const LEVEL_GRAB = 5;
const SNAP_PX = 12;
const MIN_LEN = 1;
class TimelineEditor {
  constructor(host, opts = {}) {
    __publicField(this, "host");
    __publicField(this, "root");
    __publicField(this, "canvas");
    __publicField(this, "ctx");
    __publicField(this, "preview");
    __publicField(this, "pctx");
    __publicField(this, "status");
    __publicField(this, "playBtn");
    __publicField(this, "bar");
    __publicField(this, "drag", null);
    __publicField(this, "hover", { kind: "none" });
    /** Transient status-bar message. A button whose conditions are not met must SAY so
     *  there — silently doing nothing reads as a dead button (reported by Neko). */
    __publicField(this, "notice", null);
    /** Last play/pause state painted on the button — see updateStatus for why it matters. */
    __publicField(this, "playBtnPlaying", null);
    __publicField(this, "snapping", true);
    /**
     * Does the cut grid have to respect the SOUNDTRACK's grid as well?
     *
     * The extra condition (frames divisible by 3, because 40 audio steps per second
     * against 24 fps is 5/3) only bites where the audio mask actually has an EDGE - and
     * with the soundtrack kept whole, it has none. Off by default because that is the
     * common case, and holding everyone to a grid three times coarser costs four out of
     * every five legal cuts for nothing.
     *
     * It cannot be inferred: whether the sound is kept or regenerated is decided
     * downstream, in the AV latent node, which this editor cannot see. So it is asked.
     * Not persisted, same as `snapping` - the default is the useful state.
     */
    __publicField(this, "audioGrid", false);
    __publicField(this, "raf", 0);
    __publicField(this, "disposed", false);
    __publicField(this, "lastTimelineH", 0);
    /** Undo stack of whole JSON snapshots. None of the three reference implementations has
     *  one, and ComfyUI's graph undo does not understand drags inside a canvas. */
    __publicField(this, "undoStack", []);
    __publicField(this, "redoStack", []);
    /** Ids of the selected clips. A group drag moves all of them together. */
    __publicField(this, "selection", /* @__PURE__ */ new Set());
    __publicField(this, "menu", null);
    /** Show the mask lane tinted over the picture in the monitor. */
    __publicField(this, "maskOverlay", false);
    __publicField(this, "maskBtn");
    __publicField(this, "dbBtn");
    /** Draw the wave on a logarithmic scale. UI-only, like the mask overlay: it changes
     *  nothing the backend renders, so it stays out of the widget and its cache signature. */
    __publicField(this, "waveDb", false);
    /** Default ON (Neko, 2026-08-19): the band is why the toggle exists; session-only. */
    __publicField(this, "showClipWave", true);
    /** Scratch canvas for tinting the mask; reused so playback does not allocate. */
    __publicField(this, "tintCanvas", document.createElement("canvas"));
    /** Last quantise/fps pair we warned about, so the toast fires on CHANGE only. */
    __publicField(this, "lastFpsWarning", "");
    /** Same, for the canvas warning. */
    __publicField(this, "lastCanvasWarning", "");
    /** Last (sources, output size) pair warned about. See `checkSourceScale`. */
    __publicField(this, "lastScaleWarning", "");
    __publicField(this, "transport");
    /** The `<video>` elements THIS editor scrubs. One per node: sharing them is what used to
     *  make two Timeline nodes on the same file drag each other's playhead. */
    __publicField(this, "pool", new VideoPool());
    /** Called whenever the intrinsic height changes, so the host can resize the node. */
    __publicField(this, "onHeightChange", null);
    /**
     * Sound only: no monitor, no picture lanes, and the audio lanes get the whole widget.
     *
     * A MODE on this class rather than a second editor, because the interaction is
     * identical - drag, trim, blade, snap, undo, in/out, transport - and a parallel
     * implementation of all that would drift within a month. The lane geometry already
     * funnels through `trackCount`/`maskH`/`audioTop`/`laneHeight`, so the mode is those
     * four accessors and the monitor, not a flag sprinkled through the drawing code.
     */
    __publicField(this, "audioOnly");
    // ── Interaction ─────────────────────────────────────────────────────────────
    __publicField(this, "onDown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startScroll = this.tl.ui.scroll;
        const move = (m) => {
          const width = Math.max(1, this.canvas.getBoundingClientRect().width);
          this.tl.ui.scroll = startScroll - (m.clientX - startX) / width * this.viewFrames;
          this.clampScroll();
          this.requestRender();
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          this.host.commit();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        return;
      }
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      this.root.focus({ preventScroll: true });
      const { x, y } = this.localPos(e);
      const hit = this.hitTest(x, y);
      if (hit.kind === "mute") {
        this.pushUndo();
        hit.clip.muted = !hit.clip.muted;
        this.host.commit();
        if (this.transport.rate === 1) this.transport.refreshAudio();
        this.requestRender();
        return;
      }
      if (hit.kind !== "none") this.pushUndo();
      if (hit.kind === "ruler" || hit.kind === "playhead") this.scrubTo(x);
      const c = hit.kind === "clip" || hit.kind === "edge" ? hit.clip : null;
      const additive = e.ctrlKey || e.metaKey;
      if (c) {
        if (additive) {
          if (this.selection.has(c.id)) this.selection.delete(c.id);
          else this.selection.add(c.id);
        } else if (!this.selection.has(c.id)) {
          this.selection.clear();
          this.selection.add(c.id);
        }
      } else if (hit.kind === "none" && !additive) {
        this.selection.clear();
      }
      const origins = /* @__PURE__ */ new Map();
      const snapshot = (k) => ({
        clip: k,
        from: { start: k.start, length: k.length, trimIn: k.trimIn, track: k.track }
      });
      if (c) {
        if (hit.kind === "clip") {
          for (const lane2 of [
            this.tl.clips,
            this.tl.masks,
            this.tl.audio
          ]) {
            for (const k of lane2) if (this.selection.has(k.id)) origins.set(k.id, snapshot(k));
          }
        }
        if (!origins.has(c.id)) origins.set(c.id, snapshot(c));
      }
      this.drag = {
        hit,
        startX: x,
        before: JSON.stringify(this.tl),
        origin: c ? { start: c.start, length: c.length, trimIn: c.trimIn, track: c.track } : { start: 0, length: 0, trimIn: 0, track: 0 },
        origins,
        moved: false,
        slip: e.altKey,
        fadeFrom: hit.kind === "fade" ? hit.side === "in" ? hit.clip.fadeIn ?? 0 : hit.clip.fadeOut ?? 0 : 0,
        gainFrom: hit.kind === "level" ? hit.clip.gain ?? 1 : 1,
        startY: y
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.addEventListener("pointermove", this.onMove);
      this.canvas.addEventListener("pointerup", this.onUp);
      this.canvas.addEventListener("pointercancel", this.onUp);
      this.requestRender();
    });
    __publicField(this, "onMove", (e) => {
      if (!this.drag) return;
      e.stopPropagation();
      const { x, y } = this.localPos(e);
      const d = this.drag;
      d.moved = true;
      const gain = e.ctrlKey || e.metaKey ? 0.1 : 1;
      const edge = d.hit.kind === "edge" && d.hit.side === "end" ? "end" : "resume";
      const toGrid = (f) => e.shiftKey ? snapFrameToGrid(
        f,
        this.host.getStartFrame(),
        this.host.getQuantize(),
        this.host.getQuantizeN(),
        this.audioGrid,
        edge
      ) : f;
      const dFrames = Math.round((x - d.startX) * gain / this.logicalWidth * this.viewFrames);
      switch (d.hit.kind) {
        case "roll": {
          const h = d.hit;
          if (rollEdit(
            h.left,
            h.right,
            toGrid(this.frameOf(d.startX + (x - d.startX) * gain)),
            this.host.getFps(),
            (c) => this.host.srcFramesFor(c.src),
            (c) => {
              var _a, _b;
              return ((_b = (_a = this.host.sourceFor(c.src)) == null ? void 0 : _a.info) == null ? void 0 : _b.fps) || this.host.getFps();
            }
          )) {
            this.host.commit();
          }
          break;
        }
        case "ruler":
        case "playhead":
          this.seek(toGrid(this.frameOf(d.startX + (x - d.startX) * gain)));
          break;
        case "inPoint":
        case "outPoint": {
          let frame = toGrid(this.frameOf(d.startX + (x - d.startX) * gain));
          if (this.snapping && !e.shiftKey) {
            const thr = SNAP_PX / this.logicalWidth * this.viewFrames;
            frame = snap(frame, snapCandidates(this.tl), thr);
          }
          if (d.hit.kind === "inPoint") this.applyIn(frame);
          else this.applyOut(frame);
          break;
        }
        case "fade": {
          const c = d.hit.clip;
          const len = d.fadeFrom + (d.hit.side === "in" ? dFrames : -dFrames);
          const want = Math.max(0, Math.min(c.length, toGrid(c.start + len) - c.start));
          if (d.hit.side === "in") c.fadeIn = want;
          else c.fadeOut = want;
          clampFades(c);
          if (this.transport.rate === 1) this.transport.refreshAudio();
          break;
        }
        case "level": {
          const c = d.hit.clip;
          const lane2 = d.hit.lane;
          const head = this.laneHeight(lane2) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0;
          const bodyTop = this.laneTop(lane2, c.track) + head + 3;
          const bodyH = this.laneHeight(lane2) - 6 - head;
          const py = d.startY + (y - d.startY) * gain;
          const want = this.levelOf(py, bodyTop, bodyH) - (this.levelOf(d.startY, bodyTop, bodyH) - d.gainFrom);
          c.gain = e.shiftKey ? snapGainToDb(want) : Math.max(0, Math.min(MAX_GAIN, Math.round(want * 100) / 100));
          if (c.gain === 1) delete c.gain;
          if (this.transport.rate === 1) this.transport.refreshAudio();
          break;
        }
        case "clip": {
          const c = d.hit.clip;
          if (d.slip) {
            c.trimIn = d.origin.trimIn;
            slipClip(
              c,
              -dFrames,
              this.framesOf(c) ?? 0,
              this.rateOf(c),
              this.host.getFps()
            );
          } else {
            let start = toGrid(d.origin.start + dFrames);
            if (this.snapping && !e.shiftKey) {
              const cands = snapCandidates(this.tl, [
                this.host.getStartFrame(),
                this.host.getStartFrame() + this.effCount()
              ]).filter((v) => v !== c.start && v !== c.start + c.length);
              const thr = SNAP_PX / this.logicalWidth * this.viewFrames;
              const byHead = snap(start, cands, thr);
              const byTail = snap(start + c.length, cands, thr) - c.length;
              start = Math.abs(byHead - start) <= Math.abs(byTail - start) ? byHead : byTail;
            }
            const track = d.hit.lane === "video" ? Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y))) : d.hit.lane === "audio" && this.audioOnly ? this.audioTrackOf(y) : 0;
            const shift = start - d.origin.start;
            const lift = track - d.origin.track;
            let allowed = shift;
            for (const { from } of d.origins.values()) {
              allowed = Math.max(allowed, -from.start);
            }
            for (const { clip: k, from } of d.origins.values()) {
              moveClip(
                k,
                from.start + allowed,
                k === c || this.tl.clips.includes(k) ? from.track + lift : from.track
              );
            }
          }
          break;
        }
        case "edge": {
          const c = d.hit.clip;
          const info = this.infoFor(c);
          const fps = this.host.getFps();
          const srcFps = this.rateOf(c);
          let frame = toGrid(d.hit.side === "start" ? d.origin.start + dFrames : d.origin.start + d.origin.length + dFrames);
          if (this.snapping && !e.shiftKey) {
            const thr = SNAP_PX / this.logicalWidth * this.viewFrames;
            frame = snap(frame, snapCandidates(this.tl, [
              this.host.getStartFrame(),
              this.host.getStartFrame() + this.effCount()
            ]), thr);
          }
          c.start = d.origin.start;
          c.length = d.origin.length;
          c.trimIn = d.origin.trimIn;
          if (d.hit.side === "start") trimStart(c, frame, srcFps, fps);
          else trimEnd(c, frame, (info == null ? void 0 : info.frame_count) ?? 0, srcFps, fps);
          if (c.length < MIN_LEN) c.length = MIN_LEN;
          break;
        }
      }
      this.requestRender();
    });
    __publicField(this, "onUp", (e) => {
      this.canvas.removeEventListener("pointermove", this.onMove);
      this.canvas.removeEventListener("pointerup", this.onUp);
      this.canvas.removeEventListener("pointercancel", this.onUp);
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
      }
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (JSON.stringify(this.tl) === d.before) {
        this.undoStack.pop();
      } else {
        sortClips(this.tl);
        this.host.commit();
      }
      this.requestRender();
    });
    __publicField(this, "onHover", (e) => {
      if (this.drag) return;
      const { x, y } = this.localPos(e);
      const hit = this.hitTest(x, y);
      if (hit.kind !== this.hover.kind || hit.kind === "clip" && this.hover.kind === "clip" && hit.clip !== this.hover.clip || hit.kind === "roll" && this.hover.kind === "roll" && hit.right !== this.hover.right || hit.kind === "fade" && this.hover.kind === "fade" && (hit.clip !== this.hover.clip || hit.side !== this.hover.side)) {
        this.hover = hit;
        this.requestRender();
      }
      this.canvas.style.cursor = hit.kind === "mute" ? "pointer" : hit.kind === "roll" ? "col-resize" : hit.kind === "fade" ? hit.side === "in" ? "nesw-resize" : "nwse-resize" : hit.kind === "level" ? "ns-resize" : hit.kind === "edge" || hit.kind === "inPoint" || hit.kind === "outPoint" ? "ew-resize" : hit.kind === "clip" ? e.altKey ? "col-resize" : "grab" : hit.kind === "playhead" ? "grab" : hit.kind === "ruler" ? "pointer" : "default";
    });
    /**
     * Right-click menu. Two jobs that both belong to "this clip is not what you assumed":
     * reinterpreting a black-and-white video as a mask, and setting how its track composites.
     */
    __publicField(this, "onContextMenu", (e) => {
      var _a;
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = this.localPos(e);
      const hit = this.hitTest(x, y);
      const items = [];
      if (hit.kind === "clip" || hit.kind === "edge" || hit.kind === "fade" || hit.kind === "level") {
        const c = hit.clip;
        if (hit.lane !== "mask") {
          const inside = this.playhead > c.start && this.playhead < c.start + c.length;
          if (inside) {
            const setFade = (side) => () => {
              this.pushUndo();
              if (side === "in") c.fadeIn = this.playhead - c.start;
              else c.fadeOut = c.start + c.length - this.playhead;
              clampFades(c);
              this.host.commit();
              if (this.transport.rate === 1) this.transport.refreshAudio();
            };
            items.push({ label: "Fade in to playhead", on: setFade("in") });
            items.push({ label: "Fade out from playhead", on: setFade("out") });
          }
          if (c.fadeIn || c.fadeOut) {
            items.push({
              label: "Clear fades",
              on: () => {
                this.pushUndo();
                delete c.fadeIn;
                delete c.fadeOut;
                this.host.commit();
                if (this.transport.rate === 1) this.transport.refreshAudio();
              }
            });
          }
        }
        if (hit.lane === "video" || hit.lane === "mask") {
          const toMask = hit.lane === "video";
          items.push({
            label: toMask ? "Interpret as mask" : "Interpret as video",
            on: () => {
              this.pushUndo();
              moveClipToLane(this.tl, c, toMask);
              this.host.commit();
            }
          });
        }
        if ((_a = c.markers) == null ? void 0 : _a.length) {
          items.push({
            label: `Clear ${c.markers.length} marker${c.markers.length > 1 ? "s" : ""}`,
            on: () => {
              this.pushUndo();
              delete c.markers;
              this.host.commit();
            }
          });
        }
        if (hit.lane === "video") {
          items.push({
            label: c.audioOnly ? "Restore picture" : "Audio only (picture becomes a gap)",
            active: !!c.audioOnly,
            on: () => {
              this.pushUndo();
              if (c.audioOnly) delete c.audioOnly;
              else c.audioOnly = true;
              this.host.commit();
              this.requestRender();
            }
          });
        }
        items.push({
          label: "Split at playhead",
          on: () => {
            this.select(c);
            this.bladeAtPlayhead();
          }
        });
        items.push({ label: "Delete", on: () => {
          this.select(c);
          this.deleteSelected();
        } });
      }
      if (y >= RULER_H && y < this.maskTop) {
        const track = Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y)));
        const current = trackBlend(this.tl, track);
        for (const mode of BLEND_MODES) {
          items.push({
            label: `Track ${track} blend: ${mode}`,
            active: mode === current,
            on: () => {
              this.pushUndo();
              setTrackBlend(this.tl, track, mode);
              this.host.commit();
            }
          });
        }
      }
      if (items.length) this.openMenu(e.clientX, e.clientY, items);
    });
    /**
     * Close on a click OUTSIDE the menu.
     *
     * The target check is load-bearing: this listener is on `window` in the CAPTURE phase,
     * so without it a pointerdown on a menu ITEM tears the menu out of the DOM before the
     * item's own `click` ever dispatches - every option silently does nothing.
     */
    __publicField(this, "closeMenuOnce", (e) => {
      if (this.menu && e.target instanceof Node && this.menu.contains(e.target)) return;
      this.closeMenu();
    });
    __publicField(this, "onLeave", () => {
      if (this.drag) return;
      this.hover = { kind: "none" };
      this.requestRender();
    });
    __publicField(this, "onKey", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const key = e.key.toLowerCase();
      const bound = (action, fallback) => key === this.host.getKey(action, fallback);
      let handled = true;
      if (key === "m" && e.shiftKey) this.toggleMaskOverlay();
      else if (bound("marker", "m")) this.toggleMarkerAtPlayhead();
      else if (bound("trimHead", "q")) this.trimEdgeToPlayhead("start");
      else if (bound("trimTail", "e")) this.trimEdgeToPlayhead("end");
      else if (bound("markIn", "i")) this.setIn(this.playhead);
      else if (bound("markOut", "o")) this.setOut(this.playhead);
      else if (bound("markClip", "x")) this.markClip();
      else if (bound("blade", "w")) this.bladeAtPlayhead();
      else if (bound("zoomFit", "f")) this.zoomFit();
      else switch (key) {
        case " ":
          this.transport.toggle();
          break;
        // J K L: the transport every editor has in their fingers, so not rebindable.
        case "j":
          this.transport.shuttle(-1);
          break;
        case "k":
          this.transport.stop();
          break;
        case "l":
          this.transport.shuttle(1);
          break;
        case "delete":
        case "backspace":
          this.deleteSelected();
          break;
        case "=":
        case "+":
          this.zoomBy(1.6, this.playhead);
          break;
        case "-":
          this.zoomBy(1 / 1.6, this.playhead);
          break;
        case ",":
          this.seek(this.playhead - step);
          break;
        case ".":
          this.seek(this.playhead + step);
          break;
        case "home":
          this.seek(this.host.getStartFrame());
          break;
        case "end":
          this.seek(this.host.getStartFrame() + this.effCount() - 1);
          break;
        case "z":
          if (e.ctrlKey || e.metaKey) this.undo();
          else handled = false;
          break;
        case "y":
          if (e.ctrlKey || e.metaKey) this.redo();
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        this.requestRender();
      }
    });
    /**
     * Ctrl/Cmd + wheel zooms; plain and shift wheel pan, as does a trackpad horizontal axis.
     *
     * `{ passive: false }` on the listener is load-bearing: browsers treat wheel listeners
     * as passive by default and then IGNORE preventDefault, so without it Ctrl+wheel zooms
     * the whole PAGE instead of the timeline. stopPropagation is the other half - otherwise
     * the same event reaches ComfyUI graph canvas and zooms the graph underneath.
     */
    __publicField(this, "onWheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { x } = this.localPos(e);
      if (e.ctrlKey || e.metaKey) {
        this.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, this.frameOf(x));
        return;
      }
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.panBy(raw / this.logicalWidth * this.viewFrames);
    });
    this.host = host;
    this.audioOnly = !!opts.audioOnly;
    this.transport = new Transport({
      getTimeline: () => host.getTimeline(),
      getFps: () => host.getFps(),
      getStartFrame: () => host.getStartFrame(),
      getEndFrame: () => this.host.getStartFrame() + this.effCount(),
      seek: (f) => this.seek(f, true),
      audioRefFor: (src) => {
        var _a;
        return ((_a = host.sourceFor(src)) == null ? void 0 : _a.ref) ?? null;
      },
      srcFpsFor: (src) => {
        var _a, _b;
        return ((_b = (_a = host.sourceFor(src)) == null ? void 0 : _a.info) == null ? void 0 : _b.fps) ?? host.getFps();
      }
    });
    this.transport.onChange = () => {
      if (this.transport.rate !== 1) this.pool.pauseAll();
      if (this.transport.rate === 0) this.host.commit();
      this.requestRender();
    };
    this.root = document.createElement("div");
    this.root.className = "nkd-tl";
    this.preview = document.createElement("canvas");
    this.preview.className = "nkd-tl-preview";
    this.pctx = this.preview.getContext("2d");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "nkd-tl-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.bar = document.createElement("div");
    this.bar.className = "nkd-tl-bar";
    this.status = document.createElement("span");
    this.status.className = "nkd-tl-status";
    this.buildBar();
    if (this.audioOnly) this.root.append(this.canvas, this.bar);
    else this.root.append(this.preview, this.canvas, this.bar);
    this.applyTimelineHeight();
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onHover);
    this.canvas.addEventListener("pointerleave", this.onLeave);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.pool.onReady = () => this.requestRender();
    this.root.addEventListener("keydown", this.onKey);
    this.root.tabIndex = 0;
  }
  // ── Control bar ─────────────────────────────────────────────────────────────
  buildBar() {
    const make = (inner, title, on) => {
      const b = document.createElement("button");
      b.className = "nkd-tl-btn";
      b.title = title;
      b.innerHTML = inner;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        on();
        this.requestRender();
      });
      return b;
    };
    const icon = (name, title, on) => make(`<i class="pi ${name}"></i>`, title, on);
    const mdi = (name, fallback, title, on) => {
      var _a, _b;
      const b = make(`<i class="mdi ${name}"></i>`, title, on);
      void ((_b = (_a = document.fonts) == null ? void 0 : _a.ready) == null ? void 0 : _b.then(() => {
        if (!document.fonts.check(`16px "Material Design Icons"`)) {
          b.innerHTML = `<i class="pi ${fallback}"></i>`;
        }
      }).catch(() => {
      }));
      return b;
    };
    const bracket = (glyph, title, on) => make(`<span class="nkd-tl-brk">${glyph}</span>`, title, on);
    const paintMagnet = () => {
      magnet.classList.toggle("on", this.snapping);
      const i = magnet.querySelector("i");
      if (i == null ? void 0 : i.classList.contains("mdi")) {
        i.className = `mdi ${this.snapping ? "mdi-magnet-on" : "mdi-magnet"}`;
      }
    };
    const magnet = mdi("mdi-magnet-on", "pi-bolt", "Snapping (magnet)", () => {
      this.snapping = !this.snapping;
      paintMagnet();
    });
    magnet.classList.add("on");
    const audioGridBtn = icon(
      "pi-volume-up",
      "Cut grid also respects the soundtrack — turn this on only when the sound is regenerated across the cut. With the sound kept whole, leave it off and Shift reaches every legal cut instead of one in three.",
      () => {
        this.audioGrid = !this.audioGrid;
        audioGridBtn.classList.toggle("on", this.audioGrid);
      }
    );
    this.playBtn = icon(
      "pi-play",
      "Play / pause (Space) — J K L to shuttle",
      () => this.transport.toggle()
    );
    this.maskBtn = icon(
      "pi-eye-slash",
      "Show the mask over the picture (M)",
      () => this.toggleMaskOverlay()
    );
    this.dbBtn = mdi(
      "mdi-sine-wave",
      "pi-chart-line",
      "Waveform scale: linear / logarithmic (dB)",
      () => {
        this.waveDb = !this.waveDb;
        this.dbBtn.classList.toggle("on", this.waveDb);
      }
    );
    const waveBtn = mdi(
      "mdi-waveform",
      "pi-chart-bar",
      "Show each video clip's soundtrack under its filmstrip",
      () => {
        this.showClipWave = !this.showClipWave;
        waveBtn.classList.toggle("on", this.showClipWave);
        this.requestRender();
      }
    );
    waveBtn.classList.toggle("on", this.showClipWave);
    const group = (...els) => {
      const g = document.createElement("div");
      g.className = "nkd-tl-grp";
      g.append(...els.filter((e) => e !== null));
      return g;
    };
    this.bar.append(
      group(
        // transport
        icon("pi-step-backward", "Reverse (J)", () => this.transport.shuttle(-1)),
        this.playBtn,
        icon("pi-step-forward", "Forward (L)", () => this.transport.shuttle(1))
      ),
      group(
        // in / out range
        bracket("[", "Mark in point at the playhead (I)", () => this.setIn(this.playhead)),
        bracket("]", "Mark out point at the playhead (O)", () => this.setOut(this.playhead)),
        mdi(
          "mdi-select-all",
          "pi-clone",
          "Mark clip: fit in/out to the selected clip (X)",
          () => this.markClip()
        )
      ),
      group(
        // view
        icon(
          "pi-search-minus",
          "Zoom out (Ctrl + wheel)",
          () => this.zoomBy(1 / 1.6, this.playhead)
        ),
        icon(
          "pi-search-plus",
          "Zoom in (Ctrl + wheel)",
          () => this.zoomBy(1.6, this.playhead)
        ),
        mdi(
          "mdi-fit-to-screen",
          "pi-window-maximize",
          "Fit the whole timeline (F)",
          () => this.zoomFit()
        )
      ),
      group(
        // material vs range
        mdi(
          "mdi-arrow-collapse-horizontal",
          "pi-arrows-h",
          "Fit the range to the material (no gaps, no mask)",
          () => this.trimToMaterial()
        ),
        // Deliberately NOT another horizontal arrow. Its neighbour above is the exact
        // inverse and was already `mdi-arrow-collapse-horizontal` with a `pi-arrows-h`
        // fallback: two adjacent buttons whose fallbacks were the SAME glyph, told apart
        // only by a tooltip. Neko could not find this one, which is the whole review of
        // that idea. Distinct icon, distinct fallback, and the verb first in the tooltip.
        mdi(
          "mdi-arrow-expand-all",
          "pi-arrows-alt",
          "Show all the material: open the SELECTED clips to their full length (all of them if nothing is selected)",
          () => this.expandToSources()
        ),
        mdi(
          "mdi-content-cut",
          "pi-filter",
          "Crop the material to the in/out range (discards the rest)",
          () => this.cropToInOut()
        )
      ),
      group(
        // toggles
        magnet,
        audioGridBtn,
        // The mask overlay is a picture control: with no monitor there is nothing to lay
        // it over, so it would be a button that does nothing.
        this.audioOnly ? null : this.maskBtn,
        this.dbBtn,
        // In audio-only mode every clip already IS a waveform.
        this.audioOnly ? null : waveBtn
      ),
      group(
        // sources
        icon(
          "pi-sync",
          "Conform: take fps and resolution from the first clip",
          () => this.host.conformToFirstClip()
        ),
        icon(
          "pi-refresh",
          "Reload the connected media (after changing a file)",
          () => this.reloadSources()
        )
      ),
      group(icon("pi-undo", "Undo (Ctrl+Z)", () => this.undo())),
      this.status
    );
  }
  // ── Derived state ───────────────────────────────────────────────────────────
  get tl() {
    return this.host.getTimeline();
  }
  get playhead() {
    return this.tl.ui.playhead;
  }
  /** Everything there is to look at, zoom aside. Never 0, or all the maths divides by it. */
  get contentFrames() {
    const span = timelineSpan(this.tl);
    const end = this.host.getStartFrame() + this.effCount();
    return Math.max(24, span, end);
  }
  /** First visible frame. */
  get viewStart() {
    return viewWindow(this.tl.ui, this.contentFrames).start;
  }
  /** How many frames the visible window spans. */
  get viewFrames() {
    return viewWindow(this.tl.ui, this.contentFrames).frames;
  }
  effCount() {
    return effectiveCount(
      this.tl,
      this.host.getStartFrame(),
      this.host.getFrameCount(),
      this.host.getQuantize(),
      this.host.getQuantizeN()
    );
  }
  get trackCount() {
    if (this.audioOnly) return 0;
    let max = MIN_VIDEO_TRACKS;
    for (const c of this.tl.clips) max = Math.max(max, c.track + 1);
    return Math.min(max, MAX_VIDEO_TRACKS);
  }
  /** The mask lane vanishes with the picture; keeping a 30px empty strip would read as a
   *  broken layout rather than as "there is nothing here". */
  get maskH() {
    return this.audioOnly ? 0 : MASK_H;
  }
  /** One tall lane when the sound is the content, one thin strip when it is a companion
   *  to the picture. The wave needs the height: min/max and RMS are indistinguishable at
   *  34px. */
  get audioLaneH() {
    return this.audioOnly ? AUDIO_ONLY_H : AUDIO_H;
  }
  /**
   * Audio lanes stack only in audio-only mode - the video Timeline has exactly one.
   *
   * Grows to fit what is used, plus ONE SPARE while a clip is being dragged. Without the
   * spare there would be no row to drop onto and the count could never rise past what it
   * already is; with it always on, a single-lane timeline would permanently show an empty
   * second lane. It costs a lane's height for the length of a drag, and only then.
   */
  get audioTrackCount() {
    var _a;
    if (!this.audioOnly) return 1;
    let max = MIN_AUDIO_TRACKS;
    for (const a of this.tl.audio) max = Math.max(max, (a.track ?? 0) + 1);
    const dragging = ((_a = this.drag) == null ? void 0 : _a.hit.kind) === "clip" && this.drag.hit.lane === "audio";
    return Math.min(max + (dragging ? 1 : 0), MAX_AUDIO_TRACKS);
  }
  /** Which audio lane a y coordinate falls on. NOT inverted, unlike the video tracks: an
   *  additive mix has no z-order, so there is no "on top" for the rows to depict. */
  audioTrackOf(y) {
    const row = Math.floor((y - this.audioTop) / this.audioLaneH);
    return Math.max(0, Math.min(this.audioTrackCount - 1, row));
  }
  /** Intrinsic height of the timeline canvas in logical px. */
  get timelineHeight() {
    return RULER_H + this.trackCount * TRACK_H + this.maskH + this.audioTrackCount * this.audioLaneH;
  }
  /**
   * Pin the canvas height in CSS. Without this the canvas has no CSS height, falls back
   * to its `height` attribute, and `syncSize` reading `clientHeight` to size the backing
   * store makes the two feed each other - the canvas grows every frame and spills far
   * below the node.
   */
  applyTimelineHeight() {
    const h = this.timelineHeight;
    if (h === this.lastTimelineH) return false;
    this.lastTimelineH = h;
    this.canvas.style.height = `${h}px`;
    return true;
  }
  get logicalWidth() {
    return Math.max(1, this.canvas.clientWidth);
  }
  xOf(frame) {
    return (frame - this.viewStart) / this.viewFrames * this.logicalWidth;
  }
  frameOf(x) {
    return Math.round(this.viewStart + x / this.logicalWidth * this.viewFrames);
  }
  /** Row for a track. INVERTED on purpose: the highest track number is the topmost
   *  layer, so it must be the topmost ROW too. Drawing track 0 first would put the
   *  bottom layer at the top of the widget and read backwards against every NLE. */
  trackTop(track) {
    return RULER_H + (this.trackCount - 1 - track) * TRACK_H;
  }
  trackOf(y) {
    const row = Math.floor((y - RULER_H) / TRACK_H);
    return Math.max(0, Math.min(this.trackCount - 1, this.trackCount - 1 - row));
  }
  get maskTop() {
    return RULER_H + this.trackCount * TRACK_H;
  }
  get audioTop() {
    return this.maskTop + this.maskH;
  }
  laneOf(lane2) {
    return lane2 === "video" ? this.tl.clips : lane2 === "mask" ? this.tl.masks : this.tl.audio;
  }
  laneTop(lane2, track) {
    return lane2 === "video" ? this.trackTop(track) : lane2 === "mask" ? this.maskTop : this.audioTop + Math.max(0, track) * this.audioLaneH;
  }
  /**
   * Where a level sits inside a clip body.
   *
   * The TOP of the clip is MAX_GAIN, not unity, so the boost half of the range is
   * reachable by dragging rather than only from a menu - which puts unity at mid height,
   * exactly the resting position Resolve draws its volume line at. Linear in amplitude,
   * so a linear fade stays a straight ramp on screen; a dB mapping would bow it and the
   * ramp is the thing the shape has to communicate.
   */
  levelY(level, y, h) {
    return y + h * (1 - Math.max(0, Math.min(MAX_GAIN, level)) / MAX_GAIN);
  }
  /** Inverse of `levelY`, for the drag. */
  levelOf(py, y, h) {
    return Math.max(0, Math.min(MAX_GAIN, (1 - (py - y) / Math.max(1, h)) * MAX_GAIN));
  }
  laneHeight(lane2) {
    return lane2 === "video" ? TRACK_H : lane2 === "mask" ? MASK_H : this.audioLaneH;
  }
  // ── Hit-testing ─────────────────────────────────────────────────────────────
  hitTest(x, y) {
    if (y < RULER_H) {
      if (y >= IO_BAR_TOP - 2) {
        const dIn = Math.abs(x - this.xOf(this.host.getStartFrame()));
        const dOut = Math.abs(x - this.xOf(this.host.getStartFrame() + this.effCount()));
        if (Math.min(dIn, dOut) <= IO_GRAB_PX) {
          return dIn <= dOut ? { kind: "inPoint" } : { kind: "outPoint" };
        }
      }
      return Math.abs(x - this.xOf(this.playhead)) <= HANDLE_PX ? { kind: "playhead" } : { kind: "ruler" };
    }
    const lane2 = y >= this.audioTop ? "audio" : y >= this.maskTop ? "mask" : "video";
    const list = lane2 === "video" ? this.tl.clips.filter((c) => c.track === this.trackOf(y)) : lane2 === "audio" && this.audioOnly ? this.laneOf(lane2).filter((c) => (c.track ?? 0) === this.audioTrackOf(y)) : this.laneOf(lane2);
    if (lane2 !== "mask") {
      for (const right of list) {
        if (Math.abs(x - this.xOf(right.start)) > ROLL_PX) continue;
        const left = list.find((c) => c !== right && c.track === right.track && c.start + c.length === right.start);
        if (!left) continue;
        const fadeTop = this.laneTop(lane2, right.track) + (this.laneHeight(lane2) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
        if (y < fadeTop || y > fadeTop + FADE_BAND_H) {
          return { kind: "roll", left, right, lane: lane2 };
        }
      }
    }
    const nearest = (list2) => list2.sort(
      (p, q) => p.dist - q.dist || Number(q.inside) - Number(p.inside)
    )[0].hit;
    const fades = [];
    const edges = [];
    let bodyHit = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const a = this.xOf(c.start);
      const b = this.xOf(c.start + c.length);
      if (x < a - HANDLE_PX || x > b + HANDLE_PX) continue;
      const muteX = lane2 === "mask" ? null : this.muteCentreX(a, b);
      if (muteX !== null && Math.abs(x - muteX) <= (MUTE_BOX + MUTE_PAD) / 2 && Math.abs(y - this.muteCentreY(lane2, c.track)) <= (MUTE_BOX + MUTE_PAD) / 2) {
        return { kind: "mute", clip: c, lane: lane2 };
      }
      if (lane2 !== "mask" && b - a > 24) {
        const bodyTop = this.laneTop(lane2, c.track) + (this.laneHeight(lane2) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
        if (y >= bodyTop && y <= bodyTop + FADE_BAND_H) {
          const fi = this.xOf(c.start + (c.fadeIn ?? 0));
          const fo = this.xOf(c.start + c.length - (c.fadeOut ?? 0));
          const inside = x >= a && x <= b;
          if (Math.abs(x - fi) <= FADE_GRIP) {
            fades.push({
              hit: { kind: "fade", clip: c, side: "in", lane: lane2 },
              dist: Math.abs(x - fi),
              inside
            });
          }
          if (Math.abs(x - fo) <= FADE_GRIP) {
            fades.push({
              hit: { kind: "fade", clip: c, side: "out", lane: lane2 },
              dist: Math.abs(x - fo),
              inside
            });
          }
        }
      }
      if (lane2 !== "mask" && b - a > 24) {
        const bodyTop = this.laneTop(lane2, c.track) + (this.laneHeight(lane2) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0) + 3;
        const bodyH = this.laneHeight(lane2) - 6 - (this.laneHeight(lane2) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
        const from = a + (c.fadeIn ?? 0) * ((b - a) / Math.max(1, c.length));
        const to = b - (c.fadeOut ?? 0) * ((b - a) / Math.max(1, c.length));
        const ly = this.levelY(c.gain ?? 1, bodyTop, bodyH);
        if (x >= from && x <= to && Math.abs(y - ly) <= LEVEL_GRAB) {
          return { kind: "level", clip: c, lane: lane2 };
        }
      }
      const offer = (edgeX, side) => edges.push({
        hit: { kind: "edge", clip: c, side, lane: lane2 },
        dist: Math.abs(x - edgeX),
        inside: x >= a && x <= b
      });
      let matched = false;
      if (Math.abs(x - a) <= HANDLE_PX && x - a < (b - a) / 2 - HANDLE_CORE) {
        offer(a, "start");
        matched = true;
      }
      if (Math.abs(x - b) <= HANDLE_PX && b - x < (b - a) / 2 - HANDLE_CORE) {
        offer(b, "end");
        matched = true;
      }
      if (!matched && x >= a && x <= b) bodyHit = bodyHit ?? { kind: "clip", clip: c, lane: lane2 };
    }
    if (fades.length) return nearest(fades);
    if (edges.length) return nearest(edges);
    if (bodyHit) return bodyHit;
    return { kind: "none" };
  }
  localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.logicalWidth / Math.max(1, r.width)),
      y: (e.clientY - r.top) * (this.timelineHeight / Math.max(1, r.height))
    };
  }
  openMenu(clientX, clientY, items) {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "nkd-tl-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    for (const it of items) {
      const row = document.createElement("button");
      row.className = "nkd-tl-menu-item";
      row.textContent = it.label;
      if (it.active) row.classList.add("on");
      row.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        it.on();
        this.closeMenu();
        this.requestRender();
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    this.menu = menu;
    setTimeout(() => window.addEventListener("pointerdown", this.closeMenuOnce, true), 0);
  }
  closeMenu() {
    var _a;
    window.removeEventListener("pointerdown", this.closeMenuOnce, true);
    (_a = this.menu) == null ? void 0 : _a.remove();
    this.menu = null;
  }
  select(c) {
    this.selection.clear();
    this.selection.add(c.id);
  }
  // ── Actions ─────────────────────────────────────────────────────────────────
  scrubTo(x) {
    this.seek(this.frameOf(x));
  }
  seek(frame, fromTransport = false) {
    const max = Math.max(0, this.contentFrames - 1);
    this.tl.ui.playhead = Math.max(0, Math.min(max, Math.round(frame)));
    this.host.saveView();
    if (fromTransport) {
      this.requestRender();
      return;
    }
    if (this.transport.rate !== 0) this.transport.reanchor(this.tl.ui.playhead);
    this.requestRender();
    this.host.onSeek();
  }
  /** Requested count BEFORE quantising. In/out edits work on this, never on the
   *  quantised result: feeding a quantised value back in would shrink the range a little
   *  on every pointermove and the out point would crawl left as you drag. */
  rawCount() {
    const explicit = this.host.getFrameCount();
    return explicit > 0 ? explicit : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
  }
  applyIn(frame) {
    const end = this.host.getStartFrame() + this.rawCount();
    const s = Math.max(0, Math.min(Math.round(frame), end - 1));
    this.host.setStartFrame(s);
    this.host.setFrameCount(Math.max(1, end - s));
  }
  applyOut(frame) {
    const s = this.host.getStartFrame();
    this.host.setFrameCount(Math.max(1, Math.round(frame) - s + 1));
  }
  /**
   * Snap in/out to a clip's own extent - Resolve calls it "mark clip".
   *
   * Uses the selection when there is one, otherwise everything under the playhead, the
   * same rule as the trim keys. Saves squinting at frame numbers to render exactly one
   * shot.
   */
  markClip() {
    const at = clipExtent(
      this.tl,
      this.playhead,
      this.selection.size ? this.selection : void 0
    );
    if (!at) return;
    this.pushUndo();
    this.host.setStartFrame(at.start);
    this.host.setFrameCount(Math.max(1, at.end - at.start));
    this.host.commit();
  }
  /**
   * Drop or lift a freeze-frame marker at the playhead - Resolve's M.
   *
   * With a selection it marks those clips, so a marker can be put on a mask or an audio
   * clip too; with nothing selected it takes the TOPMOST picture clip, which is the one
   * whose frame the monitor is actually showing. Marking every layer under the playhead
   * would be pointless: they all resolve to the same output frame anyway.
   */
  toggleMarkerAtPlayhead() {
    const f = this.playhead;
    let targets;
    if (this.selection.size) {
      targets = [this.tl.clips, this.tl.masks, this.tl.audio].flat().filter((c) => this.selection.has(c.id));
    } else {
      targets = clipsAt(this.tl, f).slice(0, 1);
    }
    this.pushUndo();
    let changed = false;
    for (const c of targets) changed = toggleMarker(c, f) || changed;
    if (!changed) {
      this.undoStack.pop();
      return;
    }
    this.host.commit();
    this.requestRender();
  }
  setIn(frame) {
    this.pushUndo();
    this.applyIn(frame);
  }
  setOut(frame) {
    this.pushUndo();
    this.applyOut(frame);
  }
  /**
   * Crop the output range to the material that actually exists, instead of leaving the
   * empty stretches to come out as gaps in `coverage`. The counterpart to letting a gap
   * BE a region to generate: sometimes you just want the excess gone.
   */
  trimToMaterial() {
    const r = materialRange(this.tl);
    if (!r) {
      this.say("No material on the timeline — nothing to fit the range to");
      return;
    }
    this.pushUndo();
    this.host.setStartFrame(r.start);
    this.host.setFrameCount(Math.max(1, r.end - r.start));
  }
  /** Remove the selected clips. Until now there was no way to take one off at all. */
  deleteSelected() {
    if (this.selection.size === 0) return;
    this.pushUndo();
    for (const lane2 of [
      this.tl.clips,
      this.tl.masks,
      this.tl.audio
    ]) {
      const kept = lane2.filter((c) => !this.selection.has(c.id));
      lane2.length = 0;
      lane2.push(...kept);
    }
    this.selection.clear();
    this.host.commit();
  }
  // -- Zoom and pan ------------------------------------------------------------
  /** Zoom keeping `anchorFrame` under the same pixel. Anything else feels like the
   *  timeline jumps away from whatever you were looking at. */
  zoomBy(factor, anchorFrame) {
    const ui = this.tl.ui;
    const before = viewWindow(ui, this.contentFrames);
    const rel = (anchorFrame - before.start) / before.frames;
    ui.zoom = Math.min(MAX_ZOOM, Math.max(1, ui.zoom * factor));
    const after = viewWindow(ui, this.contentFrames);
    ui.scroll = anchorFrame - rel * after.frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }
  panBy(frames) {
    this.tl.ui.scroll += frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }
  /** viewWindow already clamps; store the clamped value so it cannot creep. */
  clampScroll() {
    this.tl.ui.scroll = viewWindow(this.tl.ui, this.contentFrames).start;
  }
  zoomFit() {
    this.tl.ui.zoom = 1;
    this.tl.ui.scroll = 0;
    this.host.commit();
    this.requestRender();
  }
  /**
   * Throw away whatever falls outside the in/out range. The counterpart to fitting the
   * range to the material: here the range is what you decided, and the material gives.
   */
  cropToInOut() {
    const start = this.host.getStartFrame();
    const end = start + this.effCount();
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = cropToRange(this.tl, start, end, fps, (c) => this.rateOf(c));
    const rebase = start > 0 && !this.host.isStartFrameLinked();
    if (!changed && !rebase) {
      this.undoStack.pop();
      this.say("Nothing outside the in/out range — nothing to crop");
      return;
    }
    if (rebase) {
      for (const lane2 of [
        this.tl.clips,
        this.tl.masks,
        this.tl.audio
      ]) {
        for (const c of lane2) c.start -= start;
      }
      this.tl.ui.playhead = Math.max(0, this.tl.ui.playhead - start);
      this.tl.ui.scroll = Math.max(0, this.tl.ui.scroll - start);
      this.host.setStartFrame(0);
    } else if (changed && start > 0) {
      this.say("Cropped — start_frame is linked, so the numbering was kept");
    }
    this.selection.clear();
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }
  /**
   * Bring one edge of a clip to the playhead instead of dragging it there.
   *
   * With a selection it acts only on those clips; with nothing selected it takes
   * everything under the playhead, which is the quick way to make a straight cut across
   * picture and sound at once.
   */
  trimEdgeToPlayhead(side) {
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = trimToPlayhead(
      this.tl,
      this.playhead,
      side,
      fps,
      (c) => this.rateOf(c),
      this.selection.size ? this.selection : void 0
    );
    if (!changed) {
      this.undoStack.pop();
      return;
    }
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }
  /**
   * Re-read everything that is connected.
   *
   * A slot pointing at a DIFFERENT file is picked up on its own (the resolved reference
   * changes), but the same filename with new content is invisible from here - overwrite a
   * render and nothing about the graph changes. Hence the button.
   *
   * Clips keep their positions and trims; they are only pulled back inside the new
   * material when it turns out shorter, so swapping a three-minute track for a ten-second
   * one does not leave a clip reading the last frame forever.
   */
  reloadSources() {
    this.host.reloadSources();
    this.retightenToSources();
    this.requestRender();
  }
  /**
   * Pull every clip back inside the material it points at, if that material turned out
   * shorter. Idempotent, and it only ever SHORTENS, so it is safe to run on the tick.
   *
   * It has to run there and not just from the reload button: swapping the file in an
   * upstream Load Video is detected automatically, but the new length only arrives when
   * the probe lands a tick or two LATER - and until something re-clamps, the clip is
   * longer than its file, which the backend renders as the last frame repeating.
   */
  /**
   * Open clips out to the whole of their source - the button for "show me everything, I
   * will cut it myself". The counterpart to `retightenToSources`.
   *
   * Acts on the SELECTION when there is one. Expanding everything would also unroll a
   * three-minute audio bed nobody asked about and drag the view out with it, which is the
   * usual reason this button gets pressed once and never again.
   */
  expandToSources() {
    const fps = this.host.getFps();
    const ids = this.selection.size ? new Set(this.selection) : void 0;
    this.pushUndo();
    const changed = expandClipsToSources(
      this.tl,
      fps,
      (c) => this.framesOf(c),
      (c) => this.rateOf(c),
      ids
    );
    if (!changed) {
      this.undoStack.pop();
      this.say(ids ? "Nothing to expand in the selection — already at full length (deselect to expand everything)" : "Nothing to expand — every clip already shows its full source (a computed source reports its length after the first run)");
      return;
    }
    this.host.commit();
    this.zoomFit();
    this.requestRender();
  }
  retightenToSources() {
    const fps = this.host.getFps();
    const before = JSON.stringify(this.tl);
    const changed = clampClipsToSources(
      this.tl,
      fps,
      (c) => this.framesOf(c),
      (c) => this.rateOf(c)
    );
    if (!changed || JSON.stringify(this.tl) === before) return false;
    this.pushUndo();
    this.host.commit();
    return true;
  }
  /**
   * Blade at the playhead - the razor every NLE has.
   *
   * Acts on the selection when there is one, otherwise on everything the playhead crosses
   * in every lane, which is the same rule as Q/E and X. Cutting picture and sound in one
   * keystroke is the point: cutting only the topmost clip would desync them.
   */
  bladeAtPlayhead() {
    const fps = this.host.getFps();
    const at = this.playhead;
    const made = [];
    this.pushUndo();
    for (const lane2 of [
      this.tl.clips,
      this.tl.masks,
      this.tl.audio
    ]) {
      for (const c of [...lane2]) {
        if (this.selection.size && !this.selection.has(c.id)) continue;
        const right = splitClip(c, at, this.rateOf(c), fps);
        if (right) {
          lane2.push(right);
          made.push(right);
        }
      }
    }
    if (!made.length) return;
    sortClips(this.tl);
    this.selection.clear();
    for (const c of made) this.selection.add(c.id);
    this.host.commit();
    this.requestRender();
  }
  /** True when this clip lives on the audio lane. Identity, not `src`: the same file can
   *  legitimately sit on both lanes at once. */
  isAudioClip(c) {
    return this.tl.audio.includes(c);
  }
  /**
   * The cadence a clip's `trimIn` and `length` are counted in.
   *
   * For the AUDIO lane that is the timeline's rate, always — sound has no cadence of its
   * own, which is exactly what `player.ts` encodes as `sourceRate: false` and what
   * `drawWaveform` takes as `trimRate`.
   *
   * This used to read the SOURCE's rate for every lane and got away with it, because the
   * audio lane only ever held audio FILES and their probe reports no frame rate — so the
   * `??` quietly handed back the timeline's and every ratio came out 1. The moment a VIDEO
   * was allowed onto that lane the probe started answering, and every conversion below
   * began scaling a trim that was never in source frames to begin with. Blading a clip
   * then moved the second half to the wrong place in the file.
   */
  rateOf(c) {
    var _a, _b;
    if (this.isAudioClip(c)) return this.host.getFps();
    return ((_b = (_a = this.host.sourceFor(c.src)) == null ? void 0 : _a.info) == null ? void 0 : _b.fps) ?? this.host.getFps();
  }
  /** How much material a clip has behind it, in the cadence `rateOf` reports. An audio
   *  clip is bounded by the DECODED SOUND, not by the video's frame count. */
  framesOf(c) {
    return this.isAudioClip(c) ? this.host.audioFramesFor(c.src) : this.host.srcFramesFor(c.src);
  }
  toggleMaskOverlay() {
    this.maskOverlay = !this.maskOverlay;
    this.maskBtn.classList.toggle("on", this.maskOverlay);
    this.maskBtn.innerHTML = `<i class="pi ${this.maskOverlay ? "pi-eye" : "pi-eye-slash"}"></i>`;
    this.requestRender();
  }
  /**
   * Warn when the chosen model grid does not match the timeline rate.
   *
   * A frame count on the right grid but at the wrong rate still renders - it just comes
   * out at the wrong speed, which is the kind of mistake you only notice after the run.
   * Only fires for families whose rate ComfyUI core actually documents, and only when the
   * pair CHANGES, so it never nags while you scrub.
   */
  /**
   * Warn when the output size is off the model's own canvas.
   *
   * The twin of the fps warning, and the same kind of mistake: it still renders. It just
   * makes the model re-scale every single frame itself on its way in, for a cost nothing
   * on screen attributes to the size widgets. Only fires for a family whose canvas core
   * states outright, and only when the
   * triple CHANGES, so it never nags while you drag.
   */
  checkCanvasAgainstModel() {
    const mode = this.host.getQuantize();
    const spec = canvasFor(mode);
    const [w, h] = this.host.getOutSize();
    const stamp = `${mode}|${w}x${h}`;
    if (stamp === this.lastCanvasWarning) return;
    this.lastCanvasWarning = stamp;
    if (!spec || w <= 0 || h <= 0) return;
    const offGrid = w % spec.multiple !== 0 || h % spec.multiple !== 0;
    const tooBig = w * h > spec.maxPixels;
    if (!offGrid && !tooBig) return;
    const [aw, ah] = adaptCanvas(w, h, spec);
    this.host.notify(
      "Output size is off the model's canvas",
      `${mode.replace(/\s*\(.*\)$/, "")} works on a ${spec.shortEdge}px short edge in steps of ${spec.multiple}, capped at ${spec.maxPixels.toLocaleString()} pixels. ${w}x${h} ${tooBig ? "is over that cap" : "is off the step"}, so the model will re-scale every frame itself. For this shape it wants ${aw}x${ah}.`,
      "warn"
    );
  }
  checkFpsAgainstModel() {
    const mode = this.host.getQuantize();
    const want = nativeFpsFor(mode);
    const fps = this.host.getFps();
    const stamp = `${mode}|${fps}`;
    if (stamp === this.lastFpsWarning) return;
    this.lastFpsWarning = stamp;
    if (want === null || Math.abs(want - fps) < 0.01) return;
    this.host.notify(
      "Frame rate does not match the model",
      `${mode.replace(/\s*\(.*\)$/, "")} is trained at ${want} fps, but the timeline runs at ${fps}. The frame count will be valid, yet the result will play at the wrong speed. Set fps to ${want}, or switch the quantise preset.`,
      "warn"
    );
  }
  /**
   * Warn when the material is far bigger than the output it is being rendered to.
   *
   * A seek costs however many pixels have to be decoded from the last keyframe, and the
   * browser cannot be asked to decode a `<video>` at reduced resolution - that knob simply
   * does not exist. So a big source into a small output decodes far more pixels than it
   * needs on every scrub step, per layer, and nothing downstream can claw that back - at
   * which point the monitor is limited by the decoder, not by the drawing.
   *
   * This is the cheapest possible fix for it: SAY SO. The user can conform the material
   * and get both a usable preview and a much faster render, but only if anyone tells them
   * the ratio, which until now nothing did.
   */
  checkSourceScale() {
    var _a;
    const [ow, oh] = this.host.getOutSize();
    const outPx = Math.max(1, ow * oh);
    let worst = null;
    const seen = /* @__PURE__ */ new Set();
    for (const c of [...this.tl.clips, ...this.tl.masks]) {
      if (seen.has(c.src)) continue;
      seen.add(c.src);
      const info = (_a = this.host.sourceFor(c.src)) == null ? void 0 : _a.info;
      if (!(info == null ? void 0 : info.width) || !info.height) continue;
      const ratio = info.width * info.height / outPx;
      if (!worst || ratio > worst.ratio) {
        worst = { src: c.src, w: info.width, h: info.height, ratio };
      }
    }
    const stamp = worst ? `${worst.src}|${worst.w}x${worst.h}|${ow}x${oh}` : "";
    if (stamp === this.lastScaleWarning) return;
    this.lastScaleWarning = stamp;
    if (!worst || worst.ratio < SCALE_WARN_RATIO) return;
    this.host.notify(
      "Material much larger than the output",
      `${worst.src} is ${worst.w}x${worst.h} and this timeline renders ${ow}x${oh} - ${Math.round(worst.ratio)}x more pixels than needed. The browser cannot decode a video at reduced size, so every scrub step pays for all of them: the preview will be choppy and each render decodes the same waste. Conforming the source to ${ow}x${oh} costs nothing in quality here, since the timeline scales it to exactly that anyway.`,
      "warn"
    );
  }
  pushUndo() {
    this.undoStack.push(JSON.stringify(this.tl));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  applySnapshot(json) {
    const t = JSON.parse(json);
    const live = this.tl;
    live.clips = t.clips;
    live.audio = t.audio;
    live.ui = t.ui;
    this.host.commit();
  }
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(prev);
    this.requestRender();
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(next);
    this.requestRender();
  }
  /** Place a freshly connected slot, following the node's import mode. */
  addClipForSlot(src, frames, lane2 = "video", sync) {
    if (slotInUse(this.tl, src)) return;
    const list = this.laneOf(lane2);
    this.pushUndo();
    const mode = lane2 === "audio" && !this.audioOnly ? "append" : this.host.getImportMode();
    const at = sync ?? placementFor(this.tl, list, mode);
    list.push({
      id: newId(),
      src,
      track: lane2 === "video" || lane2 === "audio" && this.audioOnly ? at.track ?? 0 : 0,
      start: at.start,
      trimIn: sync ? sync.trimIn : 0,
      length: Math.max(1, Math.round(sync ? sync.length : frames)),
      ...lane2 === "audio" ? { gain: 1 } : {}
    });
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }
  /** Drop clips whose slot no longer has anything connected. Returns true if it changed
   *  anything, so the caller knows whether to commit. */
  pruneToSlots(live) {
    let changed = false;
    for (const lane2 of [
      this.tl.clips,
      this.tl.masks,
      this.tl.audio
    ]) {
      const kept = lane2.filter((c) => live.has(c.src));
      if (kept.length !== lane2.length) {
        lane2.length = 0;
        lane2.push(...kept);
        changed = true;
      }
    }
    return changed;
  }
  infoFor(c) {
    var _a;
    return ((_a = this.host.sourceFor(c.src)) == null ? void 0 : _a.info) ?? null;
  }
  // ── Render ──────────────────────────────────────────────────────────────────
  requestRender() {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }
  /**
   * Size the backing store for a known LOGICAL height. The logical height is passed in,
   * never read back from the element, so there is no feedback loop.
   */
  syncSize(cv, ctx, logicalH) {
    var _a, _b, _c;
    const w = cv.clientWidth;
    if (w < 1 || logicalH < 1) return false;
    const graphScale = ((_c = (_b = (_a = window.app) == null ? void 0 : _a.canvas) == null ? void 0 : _b.ds) == null ? void 0 : _c.scale) ?? 1;
    const s = Math.min(
      3,
      Math.max(1, window.devicePixelRatio || 1) * Math.max(1, graphScale)
    );
    const bw = Math.round(w * s);
    const bh = Math.round(logicalH * s);
    if (Math.abs(cv.width - bw) > 2 || Math.abs(cv.height - bh) > 2) {
      cv.width = bw;
      cv.height = bh;
    }
    ctx.setTransform(cv.width / w, 0, 0, cv.height / logicalH, 0, 0);
    return true;
  }
  render() {
    var _a;
    if (this.disposed) return;
    if (this.applyTimelineHeight()) (_a = this.onHeightChange) == null ? void 0 : _a.call(this);
    this.drawPreview();
    if (!this.syncSize(this.canvas, this.ctx, this.timelineHeight)) return;
    const ctx = this.ctx;
    const W = this.logicalWidth;
    const H = this.timelineHeight;
    const fps = this.host.getFps();
    const start = this.host.getStartFrame();
    const count = this.effCount();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    this.drawRuler(ctx, W, fps);
    for (let t = 0; t < this.trackCount; t++) {
      const y = this.trackTop(t);
      ctx.fillStyle = t % 2 ? C.trackAlt : C.trackBg;
      ctx.fillRect(0, y, W, TRACK_H);
      ctx.fillStyle = C.gridLine;
      ctx.fillRect(0, y, W, 1);
      const blend = trackBlend(this.tl, t);
      if (blend !== "normal") {
        ctx.fillStyle = C.hover;
        ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(blend, W - 4, y + 3);
        ctx.textAlign = "left";
      }
    }
    const bands = [[this.maskTop, this.maskH]];
    for (let t = 0; t < this.audioTrackCount; t++) {
      bands.push([this.audioTop + t * this.audioLaneH, this.audioLaneH]);
    }
    for (const [top, h] of bands) {
      if (h <= 0) continue;
      ctx.fillStyle = C.trackAlt;
      ctx.fillRect(0, top, W, h);
      ctx.fillStyle = C.gridLine;
      ctx.fillRect(0, top, W, 1);
    }
    this.drawGaps(ctx, start, count);
    for (const c of this.tl.clips) this.drawClip(ctx, c, "video");
    for (const m of this.tl.masks) this.drawClip(ctx, m, "mask");
    for (const a of this.tl.audio) this.drawClip(ctx, a, "audio");
    this.drawRollHint(ctx);
    this.drawOutside(ctx, W, H, start, count);
    this.drawPlayhead(ctx, H);
    this.updateStatus(fps, count);
    this.checkFpsAgainstModel();
    this.checkCanvasAgainstModel();
    this.checkSourceScale();
  }
  drawRuler(ctx, W, fps) {
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, 0, W, RULER_H);
    const steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920, 4800];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (s / this.viewFrames * W >= 60) {
        step = s;
        break;
      }
    }
    ctx.strokeStyle = C.faint;
    ctx.fillStyle = C.dim;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    const from = Math.floor(this.viewStart / step) * step;
    for (let f = from; f <= this.viewStart + this.viewFrames; f += step) {
      const x = Math.round(this.xOf(f)) + 0.5;
      if (x < -40 || x > W + 40) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      const secs = f / (fps || 1);
      const label = step >= 24 ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}` : String(f);
      ctx.fillText(label, x + 3, RULER_H / 2 - 1);
    }
    const mode = this.host.getQuantize();
    if (mode !== QUANTIZE_FREE) {
      const start = this.host.getStartFrame();
      const span = this.contentFrames - start;
      const tick = (frames, h, colour) => {
        ctx.strokeStyle = colour;
        for (const s of frames) {
          const x = Math.round(this.xOf(start + s)) + 0.5;
          if (x < 0 || x > W) continue;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      };
      const cuts = cutStops(span, mode, this.audioGrid);
      if (cuts.length > 1 && this.xOf(start + cuts[1]) - this.xOf(start + cuts[0]) >= 5) {
        tick(cuts, 3, "rgba(74,180,255,0.28)");
      }
      tick(quantizeStops(span, mode, this.host.getQuantizeN()), 5, "rgba(74,180,255,0.55)");
    }
    this.drawInOutBar(ctx, W);
  }
  /**
   * The in/out range as a draggable bar along the bottom of the ruler, with `[` and `]`
   * brackets as the grab handles - the same idiom as an NLE's work-area bar, so the range
   * can be set by dragging instead of only from the buttons.
   */
  /**
   * Light the junction when the pointer is on it, so a roll announces itself.
   *
   * `col-resize` against `ew-resize` is a real distinction but a subtle one, and this is
   * the newest of the three edits - the one nobody is looking for. Two arrows pointing
   * apart say "this moves both of them" in a way no cursor can.
   */
  drawRollHint(ctx) {
    var _a;
    const h = this.hover;
    const d = (_a = this.drag) == null ? void 0 : _a.hit;
    const hit = (d == null ? void 0 : d.kind) === "roll" ? d : h.kind === "roll" ? h : null;
    if (!hit) return;
    const x = Math.round(this.xOf(hit.right.start)) + 0.5;
    const top = this.laneTop(hit.lane, hit.right.track);
    const bot = top + this.laneHeight(hit.lane);
    ctx.save();
    ctx.strokeStyle = C.accent;
    ctx.fillStyle = C.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bot);
    ctx.stroke();
    const my = Math.round((top + bot) / 2);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + dir * 9, my);
      ctx.lineTo(x + dir * 3, my - 4);
      ctx.lineTo(x + dir * 3, my + 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  drawInOutBar(ctx, W) {
    var _a;
    const a = this.xOf(this.host.getStartFrame());
    const b = this.xOf(this.host.getStartFrame() + this.effCount());
    const y = IO_BAR_TOP;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, y, W, IO_BAR_H);
    ctx.fillStyle = this.host.getQuantize() === QUANTIZE_FREE ? "rgba(74,180,255,0.85)" : "rgba(255,209,102,0.85)";
    ctx.fillRect(a, y, Math.max(1, b - a), IO_BAR_H);
    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    const drawBracket = (x, glyph, hot) => {
      ctx.fillStyle = hot ? C.hover : "#f2f6fa";
      ctx.textAlign = glyph === "[" ? "left" : "right";
      ctx.fillText(glyph, glyph === "[" ? x - 1 : x + 1, y + IO_BAR_H / 2);
    };
    const dragging = (_a = this.drag) == null ? void 0 : _a.hit.kind;
    drawBracket(a, "[", this.hover.kind === "inPoint" || dragging === "inPoint");
    drawBracket(b, "]", this.hover.kind === "outPoint" || dragging === "outPoint");
    ctx.textAlign = "left";
  }
  /**
   * Amber shading over the stretches with NO material inside the output range.
   *
   * By merged intervals, not frame by frame: a 10 000 frame timeline would mean 10 000
   * iterations (each filtering and sorting every clip) on EVERY render and the scrub would
   * stutter. Merging the covered spans and inverting them is O(C log C).
   */
  drawGaps(ctx, start, count) {
    const top = RULER_H;
    const h = this.trackCount * TRACK_H;
    if (h <= 0) return;
    const end = start + count;
    const spans = this.tl.clips.filter((c) => !c.audioOnly).map((c) => [Math.max(c.start, start), Math.min(c.start + c.length, end)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
    let cursor = start;
    const paint = (a, b) => {
      if (b <= a) return;
      const xa = this.xOf(a);
      const xb = this.xOf(b);
      ctx.fillStyle = C.gap;
      ctx.fillRect(xa, top, xb - xa, h);
      if (xb - xa > 46) {
        ctx.fillStyle = "rgba(255,209,102,0.6)";
        ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("generate", (xa + xb) / 2, top + h / 2);
        ctx.textAlign = "left";
      }
    };
    for (const [a, b] of spans) {
      if (a > cursor) paint(cursor, a);
      cursor = Math.max(cursor, b);
    }
    paint(cursor, end);
  }
  drawClip(ctx, c, lane2) {
    var _a;
    const x = this.xOf(c.start);
    const w = Math.max(2, this.xOf(c.start + c.length) - x);
    const y = this.laneTop(lane2, c.track) + 3;
    const h = this.laneHeight(lane2) - 6;
    const isHover = (this.hover.kind === "clip" || this.hover.kind === "edge") && this.hover.clip === c;
    const isDrag = this.drag && (this.drag.hit.kind === "clip" || this.drag.hit.kind === "edge" || this.drag.hit.kind === "fade") && this.drag.hit.clip === c;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 2);
    const soundOnly = !!c.audioOnly && lane2 !== "audio";
    ctx.fillStyle = lane2 === "audio" || soundOnly ? C.audioFill : lane2 === "mask" ? C.maskFill : C.clipFill;
    ctx.fill();
    ctx.clip();
    const selected = this.selection.has(c.id);
    if (h > CLIP_HEAD_H + 4) {
      ctx.fillStyle = selected ? C.accent : lane2 === "audio" || soundOnly ? C.audioHead : lane2 === "mask" ? C.maskHead : C.clipHead;
      ctx.fillRect(x, y, w, CLIP_HEAD_H);
    }
    const src = this.host.sourceFor(c.src);
    const body = y + (h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
    const bodyH = y + h - body;
    if (src && bodyH > 6) {
      if (lane2 === "audio") {
        this.drawWaveform(ctx, c, src.ref, x, body, w, bodyH, this.host.getFps());
      } else if (soundOnly) {
        this.drawWaveform(
          ctx,
          c,
          src.ref,
          x,
          body,
          w,
          bodyH,
          ((_a = src.info) == null ? void 0 : _a.fps) || this.host.getFps()
        );
      } else if (src.info) {
        this.drawFilmstrip(ctx, c, src.ref, src.info, x, body, w, bodyH);
        if (this.showClipWave && lane2 === "video" && bodyH > 24) {
          const wh = Math.max(18, Math.round(bodyH * 0.5));
          const wy = body + bodyH - wh;
          ctx.fillStyle = "rgba(6,12,18,0.55)";
          ctx.fillRect(x, wy, w, wh);
          this.drawWaveform(
            ctx,
            c,
            src.ref,
            x,
            wy,
            w,
            wh,
            src.info.fps || this.host.getFps()
          );
        }
      }
    }
    if (soundOnly) this.drawHatch(ctx, x, y, w, h);
    if (lane2 !== "mask" && bodyH > 6) this.drawFades(ctx, c, x, body, w, bodyH);
    if (w > 26) {
      ctx.fillStyle = selected ? "#0d1b24" : src ? C.clipName : C.dim;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const label = ((src == null ? void 0 : src.label) ?? `${c.src} (no source)`) + (soundOnly && w > 150 ? "  ·  audio only" : "");
      ctx.fillText(this.ellipsise(ctx, label, w - 12), x + 5, y + CLIP_HEAD_H / 2);
    }
    const info = src == null ? void 0 : src.info;
    const fps = this.host.getFps();
    ctx.textBaseline = "alphabetic";
    if (info && Math.abs(info.fps - fps) > 0.01 && w > 66) {
      ctx.fillStyle = C.hover;
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillText(`${info.fps.toFixed(2)} → ${fps.toFixed(2)} fps`, x + 5, y + h - 5);
    } else if (!info && src && w > 66) {
      ctx.fillStyle = C.faint;
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillText("probing…", x + 5, y + h - 5);
    }
    if (lane2 !== "mask" && h > CLIP_HEAD_H) {
      const mx = this.muteCentreX(x, x + w);
      if (mx !== null) {
        this.drawSpeaker(ctx, mx, this.muteCentreY(lane2, c.track), !!c.muted, isHover);
      }
    }
    this.drawMarkers(ctx, c, y, h);
    if (selected) {
      ctx.fillStyle = "rgba(74,180,255,0.16)";
      ctx.fillRect(x, y, w, h);
    }
    if (isHover && w > 14) {
      ctx.fillStyle = C.hover;
      ctx.fillRect(x, y, 3, h);
      ctx.fillRect(x + w - 3, y, 3, h);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 2);
    ctx.strokeStyle = isDrag ? C.active : selected ? C.accent : isHover ? C.hover : C.clipEdge;
    ctx.lineWidth = isDrag || selected || isHover ? 2 : 1;
    ctx.stroke();
  }
  /**
   * Freeze-frame markers: a pennant on the clip's head band plus a hairline down the body,
   * so a marked frame is findable at any zoom without hunting for a 1px tick.
   *
   * Called from inside `drawClip`'s clip region, so a marker never bleeds past its clip.
   */
  drawMarkers(ctx, c, y, h) {
    var _a;
    if (!((_a = c.markers) == null ? void 0 : _a.length)) return;
    const head = h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : h;
    for (const m of c.markers) {
      const mx = Math.round(this.xOf(c.start + m)) + 0.5;
      ctx.fillStyle = C.markerLine;
      ctx.fillRect(mx, y + head, 1, h - head);
      ctx.fillStyle = C.marker;
      ctx.beginPath();
      ctx.moveTo(mx - 4, y);
      ctx.lineTo(mx + 4, y);
      ctx.lineTo(mx, y + Math.min(7, head));
      ctx.closePath();
      ctx.fill();
    }
  }
  /**
   * Tile stills along the clip so you can read the shot without playing it.
   *
   * Each tile shows the frame at ITS OWN position in the source, honouring trimIn and the
   * timeline/source rate difference - so trimming or slipping the clip re-reads the strip
   * and you see the change immediately.
   */
  drawFilmstrip(ctx, c, ref, info, x, y, w, h) {
    ensureThumbnails(ref, info, () => this.requestRender());
    const probe2 = thumbnailAt(ref, 0);
    if (!probe2) return;
    const tileW = Math.max(8, probe2.width / probe2.height * h);
    const fps = this.host.getFps();
    const srcFps = info.fps || fps;
    ctx.globalAlpha = 0.95;
    for (let tx = x; tx < x + w; tx += tileW) {
      const f = c.start + (tx - x) / Math.max(1, w) * c.length;
      const still = thumbnailAt(ref, sourceFrame(c, f, srcFps, fps) / (srcFps || 1));
      if (!still) break;
      ctx.drawImage(still, tx, y, Math.min(tileW, x + w - tx), h);
    }
    ctx.globalAlpha = 1;
  }
  /**
   * The clip's level envelope, drawn as the line every NLE draws: HEIGHT IS LEVEL. A fade
   * in rises from the floor at the head; a fade out falls to it at the tail; the shading
   * is what has been taken away, ABOVE the line.
   *
   * The vertices come from `gainAt` - the same function the transport schedules and Python
   * mirrors - rather than from geometry written out again here. The first version did
   * write it again, and drew both ramps upside down: it shaded the ATTENUATION as if that
   * were the shape, so a fade in sloped downwards. Deriving the picture from the curve
   * makes that class of mistake impossible rather than merely fixed.
   *
   * The grips are painted even at zero, or a clip with no fade offers no clue it can have
   * one.
   */
  drawFades(ctx, c, x, y, w, h) {
    var _a;
    const pxPerFrame = w / Math.max(1, c.length);
    const fi = c.fadeIn ?? 0;
    const fo = c.fadeOut ?? 0;
    const g = c.gain ?? 1;
    const onClip = (this.hover.kind === "clip" || this.hover.kind === "edge" || this.hover.kind === "fade" || this.hover.kind === "level") && this.hover.clip === c;
    const touched = fi > 0 || fo > 0 || g !== 1 || !!c.muted;
    if (touched || onClip) {
      const pt = ([off, lvl]) => [x + off * pxPerFrame, this.levelY(lvl, y, h)];
      const stops = levelStops(c).map(pt);
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (const p of stops) ctx.lineTo(...p);
      ctx.lineTo(x + w, y);
      ctx.closePath();
      ctx.fillStyle = "rgba(6,12,18,0.5)";
      ctx.fill();
      if (touched || onClip) {
        const uy = Math.round(this.levelY(1, y, h)) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, uy);
        ctx.lineTo(x + w, uy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const hotLevel = this.hover.kind === "level" && this.hover.clip === c || ((_a = this.drag) == null ? void 0 : _a.hit.kind) === "level" && this.drag.hit.clip === c;
      ctx.beginPath();
      stops.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p));
      ctx.strokeStyle = hotLevel ? C.accent : "rgba(255,255,255,0.7)";
      ctx.lineWidth = hotLevel ? 2 : 1;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    const grip = (gx, side) => {
      var _a2;
      const hot = this.hover.kind === "fade" && this.hover.clip === c && this.hover.side === side || ((_a2 = this.drag) == null ? void 0 : _a2.hit.kind) === "fade" && this.drag.hit.clip === c && this.drag.hit.side === side;
      const r = hot ? 5 : onClip ? 4.5 : 3;
      ctx.beginPath();
      ctx.arc(gx, y + r + 1, r, 0, Math.PI * 2);
      ctx.fillStyle = hot ? C.accent : "rgba(255,255,255,0.9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(6,12,18,0.8)";
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    grip(x + fi * pxPerFrame, "in");
    grip(x + w - fo * pxPerFrame, "out");
    if (g !== 1 && w > 60) {
      ctx.fillStyle = C.hover;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(
        `${(20 * Math.log10(Math.max(1e-4, g))).toFixed(1)} dB`,
        x + w - 42,
        y + h - 3
      );
    }
  }
  /** The clip's own trimmed span of the wave, so trimming re-reads it.
   *
   * @param trimRate  fps that `c.trimIn` is counted in. An audio clip trims in TIMELINE
   *   frames, a video clip in SOURCE frames - passing the timeline rate for a video whose
   *   source runs at another cadence slides the whole wave off the picture it belongs to.
   */
  drawWaveform(ctx, c, ref, x, y, w, h, trimRate) {
    ensureAudio(ref, () => this.requestRender());
    const env = peaksFor(ref);
    const buf = audioBufferFor(ref);
    if (!env || !buf) return;
    const fromSec = c.trimIn / Math.max(1, trimRate);
    const toSec = fromSec + c.length / this.host.getFps();
    drawWave(
      ctx,
      buf,
      env,
      fromSec,
      toSec,
      x,
      y,
      w,
      h,
      WAVE_COLORS,
      this.waveDb,
      0,
      this.logicalWidth
    );
  }
  /** Amber diagonals, the same colour the `generate` wash uses: this stretch produces no
   *  picture. Called inside `drawClip`'s clip region, so it never bleeds past the block. */
  drawHatch(ctx, x, y, w, h) {
    const step = 8;
    ctx.save();
    ctx.strokeStyle = "rgba(255,209,102,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -h; i < w; i += step) {
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
    }
    ctx.stroke();
    ctx.restore();
  }
  /**
   * Where the speaker sits horizontally, or null when the clip is too narrow for it.
   *
   * The CENTRE of the clip rather than a corner, because a corner is the contested pixel:
   * every edge, junction and fade grip lives there, and an icon parked on top of them was
   * the whole reason they could not be grabbed. In the middle it fights nothing.
   *
   * Centred on the VISIBLE slice, not on the whole clip: zoomed in, a long clip's true
   * centre is off screen and the button would simply not exist. Clamped so it never drifts
   * back into either edge's grab zone, which is the thing this is escaping.
   */
  muteCentreX(a, b) {
    const half = (MUTE_BOX + MUTE_PAD) / 2;
    const lo = a + MUTE_INSET + half;
    const hi = b - MUTE_INSET - half;
    if (hi < lo) return null;
    const seen = (Math.max(a, 0) + Math.min(b, this.logicalWidth)) / 2;
    return Math.round(Math.max(lo, Math.min(hi, seen)));
  }
  /** Where the speaker sits vertically: in the clip BODY, out of the title band. One
   *  definition, so the drawing and the hit box can never drift apart. */
  muteCentreY(lane2, track) {
    const top = this.laneTop(lane2, track);
    const h = this.laneHeight(lane2);
    const bodyTop = top + (h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
    return Math.round((bodyTop + top + h) / 2);
  }
  drawSpeaker(ctx, cx, cy, muted, hot) {
    const s = MUTE_BOX;
    ctx.save();
    const bs = s + MUTE_PAD;
    const bx = Math.round(cx - bs / 2);
    const by = Math.round(cy - bs / 2);
    ctx.beginPath();
    ctx.roundRect(bx, by, bs, bs, 2);
    ctx.fillStyle = hot ? "rgba(10,12,16,0.88)" : "rgba(10,12,16,0.62)";
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(bx + 0.5, by + 0.5, bs - 1, bs - 1, 2);
    ctx.strokeStyle = hot ? C.hover : "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = muted ? C.active : hot ? C.hover : "rgba(255,255,255,0.9)";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    const gx = cx - 1;
    ctx.beginPath();
    ctx.moveTo(gx - 4, cy - 2);
    ctx.lineTo(gx - 2, cy - 2);
    ctx.lineTo(gx + 1, cy - 5);
    ctx.lineTo(gx + 1, cy + 5);
    ctx.lineTo(gx - 2, cy + 2);
    ctx.lineTo(gx - 4, cy + 2);
    ctx.closePath();
    ctx.fill();
    if (muted) {
      ctx.beginPath();
      ctx.moveTo(gx - 5, cy + 5);
      ctx.lineTo(gx + 5, cy - 5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(gx + 2, cy, 4, -0.9, 0.9);
      ctx.stroke();
    }
    ctx.restore();
  }
  /** Truncate to fit, with an ellipsis - a name spilling out of its clip reads as a bug. */
  ellipsise(ctx, text, maxW) {
    if (maxW <= 0) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : "";
  }
  /** Dim whatever falls outside [start_frame, start_frame+count). */
  drawOutside(ctx, W, H, start, count) {
    const a = this.xOf(start);
    const b = this.xOf(start + count);
    ctx.fillStyle = C.outside;
    if (a > 0) ctx.fillRect(0, RULER_H, a, H - RULER_H);
    if (b < W) ctx.fillRect(b, RULER_H, W - b, H - RULER_H);
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1;
    for (const x of [a, b]) {
      const px = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, RULER_H);
      ctx.lineTo(px, H);
      ctx.stroke();
    }
  }
  drawPlayhead(ctx, H) {
    const x = Math.round(this.xOf(this.playhead)) + 0.5;
    ctx.strokeStyle = C.active;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillStyle = C.active;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }
  /**
   * Top pane: the frame under the playhead, composed EXACTLY as the backend will compose
   * it - the canvas is the output frame, and `fit` is applied live. Changing contain /
   * cover / stretch is visible immediately instead of only after a run.
   */
  drawPreview() {
    var _a;
    const [ow, oh] = this.host.getOutSize();
    this.preview.style.aspectRatio = `${Math.max(1, ow)} / ${Math.max(1, oh)}`;
    this.preview.style.maxWidth = `${Math.round(PREVIEW_MAX_H$1 * (Math.max(1, ow) / Math.max(1, oh)))}px`;
    const h = this.preview.clientHeight;
    if (!this.syncSize(this.preview, this.pctx, h)) return;
    const w = this.preview.clientWidth;
    const ctx = this.pctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const stack = clipsAt(this.tl, this.playhead).reverse();
    if (stack.length === 0) {
      ctx.fillStyle = C.dim;
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("gap — region to generate", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    let painted = false;
    for (const clip of stack) {
      const src = this.host.sourceFor(clip.src);
      if (!src) continue;
      const srcFps = ((_a = src.info) == null ? void 0 : _a.fps) ?? this.host.getFps();
      const sf = sourceFrame(clip, this.playhead, srcFps, this.host.getFps());
      const at = sf / (srcFps || 1);
      const img = this.pool.pictureAt(src.ref, at, this.transport.rate === 1);
      if (!img) continue;
      const iw = img.videoWidth || img.width;
      const ih = img.videoHeight || img.height;
      if (!iw || !ih) continue;
      const r = fitRect(iw, ih, w, h, this.host.getFit());
      const blend = trackBlend(this.tl, clip.track);
      ctx.globalCompositeOperation = painted && blend !== "normal" ? blend : "source-over";
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      painted = true;
    }
    if (this.maskOverlay) this.drawMaskOverlay(ctx, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }
  /**
   * Tint the mask lane over the picture, so what the mask actually covers is visible
   * without wiring a preview node.
   *
   * The mask is drawn to a scratch canvas and multiplied with red - black stays black,
   * white becomes red - then screened over the monitor, so it lights up the covered area
   * and leaves the rest alone.
   *
   * Only file-backed mask clips can be shown: a MASK arriving as a tensor from another
   * node has no file for the browser to read. That is the same limit as clip lengths, and
   * the execute-time metadata push is what lifts it.
   */
  drawMaskOverlay(ctx, w, h) {
    var _a;
    const top = this.tl.masks.filter((c) => this.playhead >= c.start && this.playhead < c.start + c.length).sort((a, b) => b.track - a.track)[0];
    if (!top) return;
    const src = this.host.sourceFor(top.src);
    if (!src) return;
    const srcFps = ((_a = src.info) == null ? void 0 : _a.fps) ?? this.host.getFps();
    const at = sourceFrame(top, this.playhead, srcFps, this.host.getFps()) / (srcFps || 1);
    const img = this.pool.pictureAt(src.ref, at, this.transport.rate === 1);
    if (!img) return;
    const iw = img.videoWidth || img.width;
    const ih = img.videoHeight || img.height;
    if (!iw || !ih) return;
    const tc = this.tintCanvas;
    if (tc.width !== Math.round(w) || tc.height !== Math.round(h)) {
      tc.width = Math.max(1, Math.round(w));
      tc.height = Math.max(1, Math.round(h));
    }
    const tctx = tc.getContext("2d");
    tctx.globalCompositeOperation = "source-over";
    tctx.clearRect(0, 0, tc.width, tc.height);
    tctx.fillStyle = "#000";
    tctx.fillRect(0, 0, tc.width, tc.height);
    const r = fitRect(iw, ih, tc.width, tc.height, this.host.getFit());
    tctx.drawImage(img, r.x, r.y, r.w, r.h);
    tctx.globalCompositeOperation = "multiply";
    tctx.fillStyle = "#ff3b30";
    tctx.fillRect(0, 0, tc.width, tc.height);
    tctx.globalCompositeOperation = "source-over";
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.65;
    ctx.drawImage(tc, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  /** Show `text` in the status bar for a few seconds, then fall back to the readout. */
  say(text) {
    this.notice = { text, until: performance.now() + 4e3 };
    window.setTimeout(() => this.requestRender(), 4100);
    this.requestRender();
  }
  updateStatus(fps, count) {
    var _a, _b;
    if (this.notice) {
      if (performance.now() < this.notice.until) {
        this.status.textContent = this.notice.text;
        return;
      }
      this.notice = null;
    }
    const rate = this.transport.rate;
    const playing2 = rate !== 0;
    if (this.playBtnPlaying !== playing2) {
      this.playBtnPlaying = playing2;
      this.playBtn.innerHTML = `<i class="pi ${playing2 ? "pi-pause" : "pi-play"}"></i>`;
      this.playBtn.classList.toggle("on", playing2);
    }
    const secs = count / (fps || 1);
    const mode = this.host.getQuantize();
    const raw = this.host.getFrameCount() > 0 ? this.host.getFrameCount() : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
    const q = mode !== QUANTIZE_FREE && raw !== count ? ` (${raw}→${count})` : "";
    const shuttle = Math.abs(rate) > 1 || rate < 0 ? ` · ${rate > 0 ? "" : "-"}${Math.abs(rate)}x` : "";
    const sel = this.selection.size ? ` · ${this.selection.size} selected` : "";
    const start = this.host.getStartFrame();
    const marks = markerFrames(this.tl).filter((f) => f >= start && f < start + count).length;
    const mk = marks ? ` · ${marks} marker${marks > 1 ? "s" : ""}` : "";
    if (this.hover.kind === "fade") {
      const c = this.hover.clip;
      const len = (this.hover.side === "in" ? c.fadeIn : c.fadeOut) ?? 0;
      this.status.textContent = `Fade ${this.hover.side} · ${len} frames (${(len / (fps || 1)).toFixed(2)}s) · drag sideways to set, Shift snaps to the grid`;
      return;
    }
    if (this.hover.kind === "level" || ((_a = this.drag) == null ? void 0 : _a.hit.kind) === "level") {
      const c = ((_b = this.drag) == null ? void 0 : _b.hit.kind) === "level" ? this.drag.hit.clip : this.hover.clip;
      const g = c.gain ?? 1;
      const db = g <= 1e-4 ? "-inf" : (20 * Math.log10(g)).toFixed(1);
      this.status.textContent = `Volume · ${db} dB · drag up and down, Shift snaps to ${GAIN_DB_STEP} dB, Ctrl for fine`;
      return;
    }
    this.status.textContent = `f ${this.playhead}${shuttle}${sel}${mk} · ${count} frames${q} · ${secs.toFixed(2)}s @ ${fps} fps`;
  }
  destroy() {
    this.disposed = true;
    this.closeMenu();
    this.transport.destroy();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onHover);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.root.removeEventListener("keydown", this.onKey);
    this.root.remove();
    this.pool.releaseAll();
  }
}
const STYLE_ID = "nkd-timeline-styles";
const CSS = `
.nkd-tl {
  display: flex; flex-direction: column; gap: 4px;
  width: 100%; box-sizing: border-box;
  font: 12px system-ui, sans-serif; color: #c8d0e0;
  outline: none;
  container-type: inline-size;
}
.nkd-tl-preview {
  /* max-width is set from JS (height cap x aspect) and margin auto centres it, so
     widening the node stretches the TIMELINE rather than the monitor. */
  width: 100%; display: block; margin: 0 auto;
  background: #000; border: 1px solid #3a3d46; border-radius: 6px;
  min-height: 60px;
}
.nkd-tl-canvas {
  width: 100%; display: block;
  background: #111318; border: 1px solid #3a3d46; border-radius: 6px;
  touch-action: none;   /* the drag is ours, not the browser's scroll */
}
.nkd-tl-bar {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 6px;
  padding: 4px 6px;
}
/* Button families. The rule is drawn by the ADJACENT-sibling selector so it only ever
   falls BETWEEN two groups: a separator element of its own would survive into a wrapped
   line and hang there with nothing to its left. */
.nkd-tl-grp { display: flex; align-items: center; gap: 4px; }
.nkd-tl-grp + .nkd-tl-grp {
  border-left: 1px solid #3a3d46; padding-left: 7px; margin-left: 3px;
}
.nkd-tl-btn {
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; cursor: pointer;
  padding: 3px 7px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
.nkd-tl-btn:hover { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-tl-btn.on { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-tl-btn .pi { font-size: 12px; color: inherit; }
/* ComfyUI loads the MDI font but its stylesheet only sets the glyph content, not the
   family - so it has to be named here or every MDI button renders as a tofu box.
   (No backticks in this file: the CSS lives in a template literal.) */
.nkd-tl-btn .mdi {
  font-family: "Material Design Icons"; font-size: 14px; color: inherit;
  line-height: 1; font-style: normal;
}
/* In/out brackets: monochrome text, sized in the button so the box does not depend on
   the host's base font. Matches the [ ] drawn on the ruler. */
.nkd-tl-brk {
  font: bold 13px ui-monospace, monospace; color: inherit;
  display: block; width: 12px; line-height: 12px;
}
.nkd-tl-status {
  margin-left: auto; color: rgba(255,255,255,0.45);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* Right-click menu. Lives on <body>, not inside the node: within the graph canvas it
   would be clipped by the node box and scaled by the canvas zoom transform. */
.nkd-tl-menu {
  position: fixed; z-index: 10000; min-width: 170px;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 6px;
  padding: 4px; box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  font: 12px system-ui, sans-serif;
}
.nkd-tl-menu-item {
  display: block; width: 100%; text-align: left;
  background: none; border: 0; border-radius: 4px;
  color: #c8d0e0; padding: 5px 8px; cursor: pointer;
}
.nkd-tl-menu-item:hover { background: #252830; color: #4ab4ff; }
.nkd-tl-menu-item.on { color: #4ab4ff; }
.nkd-tl-menu-item.on::after { content: " ✓"; }
/* Container query, not a media query: the node resizes, the window does not. */
@container (max-width: 330px) { .nkd-tl-status { display: none; } }

/* 😺NKD Video Viewer. Shares .nkd-tl-bar/-btn/-status above rather than restating them. */
.nkd-vid-stage {
  /* aspect-ratio gives the height; max-width is set from JS so widening the node does not
     grow the picture (a portrait clip would otherwise turn the node into a column). */
  width: 100%; margin: 0 auto; position: relative;
  background: #000; border: 1px solid #3a3d46; border-radius: 6px;
  overflow: hidden;
}
.nkd-vid-el {
  position: absolute; inset: 0;
  width: 100%; height: 100%; object-fit: contain; display: block;
}
.nkd-vid-scrub {
  width: 100%; height: 44px; display: block;
  border: 1px solid #3a3d46; border-radius: 6px;
  cursor: pointer; touch-action: none;   /* the drag is ours, not the browser's scroll */
}
.nkd-vid a.nkd-tl-btn { text-decoration: none; }
.nkd-vid-path {
  font: 11px ui-monospace, monospace; color: rgba(255,255,255,0.40);
  padding: 0 2px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nkd-vid-path:hover { color: #4ab4ff; }
.nkd-vid-path:empty { display: none; }
/* A/B compare. The reference is a second <video> stacked on top and clipped back, so the
   composite is the browser's, not an approximation. */
.nkd-vid-ref { z-index: 1; pointer-events: none; }
.nkd-vid-divider {
  position: absolute; top: 0; bottom: 0; width: 2px; z-index: 2;
  background: #4ab4ff; box-shadow: 0 0 6px rgba(0,0,0,0.6);
  pointer-events: none;
}
.nkd-vid-divider::before, .nkd-vid-divider::after {
  content: ""; position: absolute; left: 50%; transform: translateX(-50%);
  border: 5px solid transparent;
}
.nkd-vid-divider::before { top: 50%; margin-top: -14px; border-bottom-color: #4ab4ff; }
.nkd-vid-divider::after { top: 50%; margin-top: 4px; border-top-color: #4ab4ff; }

/* Full screen: the whole widget goes, so the transport and the compare controls come with
   it. The picture takes whatever is left and letterboxes itself.
   !important is not decoration here - max-width and aspect-ratio are written INLINE from
   JS (the height cap that stops a wide node growing the monitor), and inline wins over a
   plain rule. In full screen that cap is exactly what has to go. */
.nkd-vid:fullscreen {
  display: flex; flex-direction: column; gap: 6px;
  width: 100vw; height: 100vh; box-sizing: border-box;
  padding: 8px; background: #000;
}
.nkd-vid:fullscreen .nkd-vid-stage {
  flex: 1 1 auto; min-height: 0;
  max-width: none !important; aspect-ratio: auto !important;
  border: 0; border-radius: 0;
}
.nkd-vid:fullscreen .nkd-vid-scrub { flex: 0 0 auto; }
.nkd-vid:fullscreen .nkd-tl-bar { flex: 0 0 auto; }

/* Stand-in left in the node while the viewer is off in its own window. Without it the
   widget row collapses and the node just looks broken. */
.nkd-vid-away {
  display: flex; align-items: center; justify-content: center;
  min-height: 90px; border: 1px dashed #3a3d46; border-radius: 6px;
  color: rgba(255,255,255,0.35); font: 12px system-ui, sans-serif;
}

/* Project chip + its picker. Reuses .nkd-tl-btn and .nkd-tl-menu so a chip in the video
   viewer, in the popup node and in a menu all read as the same control. */
.nkd-proj-chip { gap: 5px; max-width: 190px; font: 11px system-ui, sans-serif; }
.nkd-proj-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nkd-proj-head {
  padding: 6px 8px 3px; color: rgba(255,255,255,0.35);
  font: 10px system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.06em;
}
.nkd-proj-modal {
  position: fixed; inset: 0; z-index: 10001;
  background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center;
}
.nkd-proj-box {
  display: flex; flex-direction: column; gap: 6px;
  width: min(460px, 92vw); padding: 14px;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.6);
  font: 12px system-ui, sans-serif; color: #c8d0e0;
}
.nkd-proj-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.nkd-proj-lab { color: rgba(255,255,255,0.45); font-size: 11px; margin-top: 4px; }
.nkd-proj-area, .nkd-proj-input {
  background: #111318; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; padding: 6px 8px; font: 12px ui-monospace, monospace;
  resize: vertical;
}
.nkd-proj-area { min-height: 96px; }
.nkd-proj-area-sm { min-height: 56px; }
.nkd-proj-row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }

/* 😺NKD Popup Preview, in-node panel: same bar, same buttons, same path line as the video
   viewer - two nodes in one pack should not speak two different dialects.
   No thumbnail of its own: ComfyUI already renders the node's preview from nodeOutputs,
   so one was the same pixels twice and a taller node for nothing.
   (No backticks in this file: the CSS lives in a template literal.) */
.nkd-pp-bar {
  flex-wrap: nowrap;       /* the buttons must never drop to a second line */
  width: max-content;      /* content-sized, so offsetWidth is the intrinsic row width */
  max-width: none;
}
`;
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el2 = document.createElement("style");
  el2.id = STYLE_ID;
  el2.textContent = CSS;
  document.head.appendChild(el2);
}
const ROW_SAFETY = 2;
const MAX_INSET = 48;
const findW = (node, name) => {
  var _a;
  return (_a = node.widgets) == null ? void 0 : _a.find((w) => w.name === name);
};
function hideWidget(w) {
  var _a;
  if (!w) return;
  w.hidden = true;
  if (w.options) w.options.hidden = true;
  w.computeSize = () => [0, -4];
  w.draw = () => {
  };
  if ((_a = w.element) == null ? void 0 : _a.style) w.element.style.display = "none";
}
function setWidgetVisible(node, name, visible) {
  const w = findW(node, name);
  if (!w) return;
  w.hidden = !visible;
  if (w.options) w.options.hidden = !visible;
  if (visible) delete w.computeSize;
  else w.computeSize = () => [0, -4];
}
function keepDomWidgetSized(node, container, minW) {
  const mw = () => typeof minW === "function" ? minW() : minW;
  const MAX_MARGIN = 40;
  let enforcing = false;
  let goodMargin = 15;
  const vueMode = () => {
    var _a;
    return !!((_a = window.LiteGraph) == null ? void 0 : _a.vueNodesMode);
  };
  const clamp = () => {
    var _a, _b;
    if (enforcing) return;
    if (vueMode()) {
      if (container.style.width) container.style.width = "";
      const el2 = document.querySelector(`[data-node-id="${node.id}"]`);
      const want = `${mw()}px`;
      if (el2 && el2.style.minWidth !== want) el2.style.minWidth = want;
      return;
    }
    const nodeW = (_a = node.size) == null ? void 0 : _a[0];
    if (!nodeW) return;
    const hostW = ((_b = container.parentElement) == null ? void 0 : _b.clientWidth) ?? 0;
    const broken = hostW > 0 && (hostW > nodeW * 1.2 || hostW < nodeW * 0.7);
    if (!broken) {
      if (container.style.width) {
        enforcing = true;
        container.style.width = "";
        requestAnimationFrame(() => {
          enforcing = false;
        });
      }
      const cw = container.clientWidth;
      if (cw > 0 && cw <= nodeW && cw >= nodeW - MAX_MARGIN) goodMargin = nodeW - cw;
      return;
    }
    const ref = Math.round(nodeW - goodMargin);
    if (ref > 0 && Math.abs(container.clientWidth - ref) > 2) {
      enforcing = true;
      container.style.boxSizing = "border-box";
      container.style.width = `${ref}px`;
      requestAnimationFrame(() => {
        enforcing = false;
      });
    }
  };
  clamp();
  const ro = new ResizeObserver(clamp);
  ro.observe(container);
  const origResize = node.onResize;
  node.onResize = function(...args) {
    origResize == null ? void 0 : origResize.apply(this, args);
    clamp();
  };
  const iv = window.setInterval(clamp, 250);
  return {
    release: () => {
      ro.disconnect();
      clearInterval(iv);
    },
    margin: () => goodMargin
  };
}
function mountDomWidget(node, opts) {
  const container = document.createElement("div");
  container.style.width = "100%";
  const wantWidth = () => {
    var _a;
    return Math.max(opts.minWidth, Math.ceil(((_a = opts.minWidthOf) == null ? void 0 : _a.call(opts)) ?? 0));
  };
  container.style.minWidth = `${wantWidth()}px`;
  container.appendChild(opts.root);
  let measured = 0;
  let inset = 0;
  const heightFor = () => (measured > 0 ? measured : opts.estimate()) + ROW_SAFETY + inset;
  node.addDOMWidget(opts.name, opts.type, container, {
    getValue: opts.getValue ?? (() => ""),
    setValue: opts.setValue ?? (() => {
    }),
    serialize: false,
    hideOnZoom: false,
    getMinHeight: heightFor,
    getMaxHeight: heightFor,
    getHeight: heightFor
  });
  const widthKeeper = keepDomWidgetSized(node, container, wantWidth);
  const minNodeWidth = () => wantWidth() + widthKeeper.margin();
  const resizeToContent = () => {
    container.style.minWidth = `${wantWidth()}px`;
    node.setSize([Math.max(node.size[0], minNodeWidth()), node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
  };
  let settling = false;
  const calibrate = () => {
    var _a;
    const hostH = ((_a = container.parentElement) == null ? void 0 : _a.clientHeight) ?? 0;
    if (hostH < 1) return false;
    const gap = Math.min(MAX_INSET, Math.max(0, Math.round(heightFor() - hostH)));
    if (Math.abs(gap - inset) <= 1) return false;
    inset = gap;
    return true;
  };
  const ro = new ResizeObserver(() => {
    var _a;
    if (settling) return;
    if ((_a = document.fullscreenElement) == null ? void 0 : _a.contains(opts.root)) return;
    if (opts.root.ownerDocument !== document) return;
    const h = opts.root.offsetHeight;
    if (h < 1) return;
    const grew = Math.abs(h - measured) > 1;
    if (grew) measured = h;
    if (!calibrate() && !grew) return;
    settling = true;
    resizeToContent();
    requestAnimationFrame(() => {
      settling = false;
    });
  });
  ro.observe(opts.root);
  const origResize = node.onResize;
  node.onResize = function(size) {
    var _a;
    origResize == null ? void 0 : origResize.apply(this, arguments);
    const min = minNodeWidth();
    if (size[0] < min) size[0] = min;
    size[1] = this.computeSize(size[0])[1];
    (_a = opts.onResize) == null ? void 0 : _a.call(opts);
  };
  const origComputeSize = node.computeSize.bind(node);
  node.computeSize = function() {
    const sz = origComputeSize();
    const needed = heightFor();
    if (sz[1] < needed) sz[1] = needed;
    const min = minNodeWidth();
    if (sz[0] < min) sz[0] = min;
    return sz;
  };
  let tries = 0;
  const settleInitial = () => {
    measured = opts.root.offsetHeight || 0;
    resizeToContent();
    if (measured < 1 && tries++ < 30) requestAnimationFrame(settleInitial);
  };
  requestAnimationFrame(settleInitial);
  return {
    container,
    resizeToContent,
    minNodeWidth,
    release: () => {
      ro.disconnect();
      widthKeeper.release();
    }
  };
}
const PROP = "nkdSchema";
function guardWidgetOrder(nodeType, nodeName, version) {
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function() {
    const r = origCreated == null ? void 0 : origCreated.apply(this, arguments);
    this.properties = this.properties || {};
    this.properties[PROP] = version;
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function(info) {
    var _a, _b, _c, _d, _e;
    const r = origConfigure == null ? void 0 : origConfigure.apply(this, arguments);
    const named = info == null ? void 0 : info.widgets_values_named;
    if (named && typeof named === "object" && !Array.isArray(named)) {
      for (const [name, val] of Object.entries(named)) {
        const w = findW(this, name);
        if (w && w.value !== val) {
          w.value = val;
          (_a = w.callback) == null ? void 0 : _a.call(w, val);
        }
      }
    } else if (version > 1 && ((_b = info == null ? void 0 : info.properties) == null ? void 0 : _b[PROP]) !== version && Array.isArray(info == null ? void 0 : info.widgets_values) && info.widgets_values.length) {
      (_e = (_d = (_c = app.extensionManager) == null ? void 0 : _c.toast) == null ? void 0 : _d.add) == null ? void 0 : _e.call(_d, {
        severity: "warn",
        summary: `😺${nodeName}`,
        detail: `"${this.title ?? nodeName}" was saved before a widget reorder: its values may have loaded into the wrong widgets. Delete and re-add the node, then re-check its settings.`,
        life: 12e3
      });
    }
    return r;
  };
}
const FREEZE_NODE = "NKDFreezeFrames";
const FIXED_OUTPUTS = 2;
const MAX_FRAME_OUTPUTS = 16;
const widgetValue = (node, name) => {
  var _a, _b;
  return (_b = (_a = node == null ? void 0 : node.widgets) == null ? void 0 : _a.find((w) => w.name === name)) == null ? void 0 : _b.value;
};
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
function markerPlanOf(timelineNode) {
  const tl = parseTimeline(widgetValue(timelineNode, "timeline"));
  const start = Math.max(0, num(widgetValue(timelineNode, "start_frame"), 0));
  const count = effectiveCount(
    tl,
    start,
    Math.max(0, num(widgetValue(timelineNode, "frame_count"), 0)),
    // The widget is named `model` since 2026-08-09: what you pick IS the model, and the
    // frame grid follows from it.
    String(widgetValue(timelineNode, "model") ?? ""),
    num(widgetValue(timelineNode, "quantize_n"), 8)
  );
  const inRange = (f) => f >= start && f < start + count;
  const labels = [];
  if (widgetValue(timelineNode, "clip_markers") === true) {
    clipBoundFrames(tl).forEach((f, i) => {
      if (inRange(f)) labels.push(`clip ${Math.floor(i / 2) + 1} ${i % 2 ? "out" : "in"}`);
    });
  }
  markerFrames(tl).filter(inRange).forEach((_, i) => labels.push(`ref ${i + 1}`));
  return { count: labels.length, labels };
}
const TIMELINE_NODE = "NKDTimeline";
function findMarkerSource(node, slotName, depth = 0) {
  var _a, _b, _c, _d, _e;
  if (!node || depth > 4) return null;
  const slot = (_a = node.inputs) == null ? void 0 : _a.find((i) => i.name === slotName);
  if (!slot || slot.link == null) return null;
  const link = (_b = node.graph) == null ? void 0 : _b.getLink(slot.link);
  const origin = link && ((_c = node.graph) == null ? void 0 : _c.getNodeById(link.origin_id));
  if (!origin) return null;
  if (origin.type === TIMELINE_NODE && ((_e = (_d = origin.outputs) == null ? void 0 : _d[link.origin_slot]) == null ? void 0 : _e.name) === "markers") {
    return origin;
  }
  for (const inp of origin.inputs ?? []) {
    if (inp.link == null) continue;
    const up = findMarkerSource(origin, inp.name, depth + 1);
    if (up) return up;
  }
  return null;
}
function wantedFrames(node) {
  var _a;
  const slot = (_a = node.inputs) == null ? void 0 : _a.find((i) => i.name === "frames");
  if ((slot == null ? void 0 : slot.link) != null) {
    const timeline = findMarkerSource(node, "frames");
    return timeline ? markerPlanOf(timeline) : null;
  }
  const text = widgetValue(node, "frames");
  if (typeof text !== "string") return null;
  return { count: (text.match(/-?\d+/g) ?? []).length, labels: null };
}
function linkedDepth(node) {
  var _a;
  let depth = 0;
  (_a = node.outputs) == null ? void 0 : _a.forEach((o, i) => {
    var _a2;
    if (i >= FIXED_OUTPUTS && ((_a2 = o == null ? void 0 : o.links) == null ? void 0 : _a2.length)) depth = Math.max(depth, i + 1);
  });
  return depth;
}
function syncFreezeOutputs(node) {
  var _a;
  if (!(node == null ? void 0 : node.outputs)) return;
  const plan = wantedFrames(node);
  if (plan === null) return;
  const want = FIXED_OUTPUTS + Math.min(MAX_FRAME_OUTPUTS, Math.max(1, plan.count));
  const target = Math.max(want, linkedDepth(node));
  let dirty = node.outputs.length !== target;
  while (node.outputs.length > target) node.removeOutput(node.outputs.length - 1);
  while (node.outputs.length < target) {
    node.addOutput(`frame_${node.outputs.length - FIXED_OUTPUTS + 1}`, "IMAGE");
  }
  node.outputs.forEach((o, i) => {
    var _a2;
    if (i < FIXED_OUTPUTS || !o) return;
    const label = (_a2 = plan.labels) == null ? void 0 : _a2[i - FIXED_OUTPUTS];
    if ((o.label ?? void 0) !== label) {
      o.label = label;
      dirty = true;
    }
  });
  if (dirty) (_a = node.setDirtyCanvas) == null ? void 0 : _a.call(node, true, true);
}
function syncAllFreezeNodes() {
  var _a;
  for (const n of ((_a = app.graph) == null ? void 0 : _a._nodes) ?? []) {
    if (n.type === FREEZE_NODE) syncFreezeOutputs(n);
  }
}
function registerFreezeFrames() {
  app.registerExtension({
    name: "NKD.FreezeFrames",
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if ((nodeData == null ? void 0 : nodeData.name) !== FREEZE_NODE) return;
      if (nodeType.prototype.__nkdFreezeWrapped) return;
      nodeType.prototype.__nkdFreezeWrapped = true;
      guardWidgetOrder(nodeType, FREEZE_NODE, 1);
      const origCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        var _a;
        const r = origCreated == null ? void 0 : origCreated.apply(this, arguments);
        const w = (_a = this.widgets) == null ? void 0 : _a.find((x) => x.name === "frames");
        if (w) {
          const origCb = w.callback;
          w.callback = (...args) => {
            const out = origCb == null ? void 0 : origCb.apply(w, args);
            syncFreezeOutputs(this);
            return out;
          };
        }
        setTimeout(() => syncFreezeOutputs(this), 0);
        return r;
      };
      const origConn = nodeType.prototype.onConnectionsChange;
      nodeType.prototype.onConnectionsChange = function() {
        const r = origConn == null ? void 0 : origConn.apply(this, arguments);
        syncFreezeOutputs(this);
        return r;
      };
      const origConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function() {
        const r = origConfigure == null ? void 0 : origConfigure.apply(this, arguments);
        setTimeout(() => syncFreezeOutputs(this), 0);
        return r;
      };
    }
  });
}
const el$1 = (tag, cls, parent) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  parent == null ? void 0 : parent.appendChild(node);
  return node;
};
let cache = null;
let inflight = null;
const listeners = /* @__PURE__ */ new Set();
function onProjectChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function announce(cfg) {
  cache = cfg;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
    }
  }
  return cfg;
}
async function post(route, body) {
  const res = await api.fetchApi(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return announce(await res.json());
}
function config() {
  return cache;
}
async function loadConfig(force = false) {
  if (cache && !force) return cache;
  if (!inflight || force) {
    inflight = api.fetchApi("/nkd/project/config").then((r) => r.json()).then(announce).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
const setActive = (project, category) => post("/nkd/project/active", { project, category });
const saveConfig = (cfg) => post("/nkd/project/save", cfg);
function activeLabel() {
  if (!cache) return "…";
  return `${cache.active.project} · ${cache.active.category}`;
}
let availability = null;
function revealAvailable() {
  return availability ?? (availability = api.fetchApi("/nkd/open").then((r) => r.json()).then((j) => !!j.available).catch(() => false));
}
async function reveal(ref) {
  const q = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output"
  });
  await api.fetchApi(`/nkd/open?${q}`);
}
const LS_VERSIONING = "nkd_save_versioning";
function saveVersioning() {
  return localStorage.getItem(LS_VERSIONING) === "off" ? "off" : "auto";
}
function setSaveVersioning(v) {
  localStorage.setItem(LS_VERSIONING, v);
}
async function saveToProject(ref, prefix) {
  const res = await api.fetchApi("/nkd/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...ref, prefix, versioning: saveVersioning() })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
let openMenuEl = null;
function closeMenu() {
  window.removeEventListener("pointerdown", closeMenuOnce, true);
  openMenuEl == null ? void 0 : openMenuEl.remove();
  openMenuEl = null;
}
const closeMenuOnce = (e) => {
  if (openMenuEl && e.target instanceof Node && openMenuEl.contains(e.target)) return;
  closeMenu();
};
function openMenu(x, y, items) {
  ensureStyles();
  closeMenu();
  const menu = el$1("div", "nkd-tl-menu", document.body);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const it of items) {
    if (it.header) {
      const h = el$1("div", "nkd-proj-head", menu);
      h.textContent = it.label;
      continue;
    }
    const row = el$1("button", "nkd-tl-menu-item", menu);
    row.textContent = it.label;
    if (it.active) row.classList.add("on");
    row.addEventListener("pointerdown", (ev) => {
      var _a;
      ev.preventDefault();
      ev.stopPropagation();
      (_a = it.on) == null ? void 0 : _a.call(it);
      closeMenu();
    });
  }
  openMenuEl = menu;
  setTimeout(() => window.addEventListener("pointerdown", closeMenuOnce, true), 0);
}
function openPicker(x, y) {
  const cfg = cache;
  if (!cfg) return;
  const items = [{ label: "Project", header: true }];
  for (const p of cfg.projects) {
    items.push({
      label: p.path ? `${p.name}  →  ${p.path}` : p.name,
      active: p.name === cfg.active.project,
      on: () => void setActive(p.name, void 0)
    });
  }
  items.push({ label: "Category", header: true });
  for (const c of cfg.categories) {
    items.push({
      label: c,
      active: c === cfg.active.category,
      on: () => void setActive(void 0, c)
    });
  }
  items.push({ label: "Versioning", header: true });
  const mode = saveVersioning();
  items.push({
    label: "off (counter)",
    active: mode === "off",
    on: () => setSaveVersioning("off")
  });
  items.push({
    label: "auto (next version)",
    active: mode === "auto",
    on: () => setSaveVersioning("auto")
  });
  items.push({ label: " ", header: true });
  items.push({ label: "⚙ Manage projects…", on: () => openManager() });
  openMenu(x, y, items);
}
function projectChip(parent) {
  const btn = el$1("button", "nkd-tl-btn nkd-proj-chip", parent);
  btn.title = "Active project and category — where renders land. Shared by every NKD node.";
  const icon = el$1("i", "pi pi-folder", btn);
  const label = el$1("span", "nkd-proj-label", btn);
  const paint = () => {
    label.textContent = activeLabel();
  };
  paint();
  void loadConfig().then(paint);
  const off = onProjectChange(paint);
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!cache) {
      void loadConfig(true).then(paint);
      return;
    }
    const r = btn.getBoundingClientRect();
    openPicker(r.left, r.bottom + 4);
  });
  btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  return { el: btn, destroy: () => {
    off();
    icon.remove();
  } };
}
function openManager() {
  const cfg = cache;
  if (!cfg) return;
  ensureStyles();
  const back = el$1("div", "nkd-proj-modal", document.body);
  const box = el$1("div", "nkd-proj-box", back);
  el$1("div", "nkd-proj-title", box).textContent = "NKD projects";
  el$1("label", "nkd-proj-lab", box).textContent = "Projects — one per line, `Name = folder/path` to point it somewhere else";
  const projects = el$1("textarea", "nkd-proj-area", box);
  projects.value = cfg.projects.map((p) => p.path ? `${p.name} = ${p.path}` : p.name).join("\n");
  el$1("label", "nkd-proj-lab", box).textContent = "Categories — one per line";
  const cats = el$1("textarea", "nkd-proj-area nkd-proj-area-sm", box);
  cats.value = cfg.categories.join("\n");
  el$1("label", "nkd-proj-lab", box).textContent = "Where a saved still goes (tokens: %project% %category% %node% %date:yyyy-MM-dd%)";
  const prefix = el$1("input", "nkd-proj-input", box);
  prefix.value = cfg.image_prefix;
  const row = el$1("div", "nkd-proj-row", box);
  const close = () => back.remove();
  const cancel = el$1("button", "nkd-tl-btn", row);
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  const ok = el$1("button", "nkd-tl-btn on", row);
  ok.textContent = "Save";
  ok.addEventListener("click", () => {
    const parsed = [];
    for (const line of projects.value.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf("=");
      if (i < 0) {
        parsed.push({ name: t });
        continue;
      }
      const name = t.slice(0, i).trim();
      const path = t.slice(i + 1).trim();
      if (name) parsed.push(path ? { name, path } : { name });
    }
    void saveConfig({
      ...cfg,
      projects: parsed,
      categories: cats.value.split("\n").map((s) => s.trim()).filter(Boolean),
      image_prefix: prefix.value.trim() || cfg.image_prefix
    }).then(close);
  });
  back.addEventListener("pointerdown", (ev) => {
    if (ev.target === back) close();
  });
}
function openPickerAt(anchor) {
  const r = anchor == null ? void 0 : anchor.getBoundingClientRect();
  const x = r ? r.left : window.innerWidth / 2 - 90;
  const y = r ? r.bottom + 6 : 80;
  void loadConfig().then(() => openPicker(x, y));
}
function registerProjectTopbar() {
  const button2 = () => ({
    icon: "pi pi-folder",
    label: activeLabel(),
    tooltip: "Active NKD project and category — where renders land",
    onClick: (ev) => openPickerAt(ev == null ? void 0 : ev.currentTarget)
  });
  const ext = {
    name: "NKD.Projects",
    actionBarButtons: [button2()],
    commands: [{
      id: "NKD.Projects.Pick",
      label: "NKD: pick project and category",
      function: () => openPickerAt(
        document.querySelector('[data-testid="action-bar-buttons"] button')
      )
    }]
  };
  app.registerExtension(ext);
  onProjectChange(() => {
    ext.actionBarButtons = [button2()];
    const host = document.querySelector('[data-testid="action-bar-buttons"]');
    for (const span of (host == null ? void 0 : host.querySelectorAll("button span")) ?? []) {
      if (span.textContent && span.textContent.includes("·")) span.textContent = activeLabel();
    }
  });
  void loadConfig();
}
function revealButton(parent, getRef) {
  void revealAvailable().then((ok) => {
    if (!ok) return;
    const btn = el$1("button", "nkd-tl-btn", parent);
    btn.title = "Show in the file manager";
    el$1("i", "pi pi-folder-open", btn);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ref = getRef();
      if (ref) void reveal(ref);
    });
  });
}
const TRACKED_PROP = "nkdTracked";
const VIEWER = "NKDVideoViewer";
const tracked = (node) => {
  var _a;
  return Array.isArray((_a = node == null ? void 0 : node.properties) == null ? void 0 : _a[TRACKED_PROP]) ? node.properties[TRACKED_PROP] : [];
};
function entries() {
  var _a;
  const out = [];
  for (const n of ((_a = app.graph) == null ? void 0 : _a._nodes) ?? []) {
    for (const name of tracked(n)) out.push({ node: n, name });
  }
  return out;
}
const chips = /* @__PURE__ */ new Set();
const repaintChips = () => chips.forEach((p) => p());
function resolveMark(node, widget, depth = 0) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  if (depth > 4 || typeof node.isSubgraphNode !== "function" || !node.isSubgraphNode()) {
    return [String(node.id), widget];
  }
  const sg = node.subgraph;
  const inp = (_a = sg == null ? void 0 : sg.inputs) == null ? void 0 : _a.find((i) => i.name === widget);
  const linkId = (_b = inp == null ? void 0 : inp.linkIds) == null ? void 0 : _b[0];
  const link = linkId != null ? ((_c = sg.getLink) == null ? void 0 : _c.call(sg, linkId)) ?? ((_e = (_d = sg.links) == null ? void 0 : _d.get) == null ? void 0 : _e.call(_d, linkId)) ?? ((_f = sg.links) == null ? void 0 : _f[linkId]) : null;
  const tgt = link ? sg.getNodeById(link.target_id) : null;
  if (!tgt) return [String(node.id), widget];
  const name = ((_h = (_g = tgt.inputs) == null ? void 0 : _g[link.target_slot]) == null ? void 0 : _h.name) ?? widget;
  const inner = resolveMark(tgt, name, depth + 1);
  return [`${node.id}:${inner[0]}`, inner[1]];
}
function syncLabelWidgets() {
  var _a, _b, _c, _d;
  const nodes = ((_a = app.graph) == null ? void 0 : _a._nodes) ?? [];
  const list = [];
  for (const n of nodes) {
    for (const name of tracked(n)) list.push(resolveMark(n, name));
  }
  const json = list.length ? JSON.stringify(list) : "";
  for (const n of nodes) {
    if (n.comfyClass !== VIEWER) continue;
    const w = (_b = n.widgets) == null ? void 0 : _b.find((x) => x.name === "labels");
    if (w && w.value !== json) {
      w.value = json;
      (_c = w.callback) == null ? void 0 : _c.call(w, json);
    }
    setWidgetVisible(n, "labeled_copy", list.length > 0);
    (_d = n.setDirtyCanvas) == null ? void 0 : _d.call(n, true, true);
  }
  repaintChips();
}
function toggleTrack(node, name) {
  var _a;
  const cur = tracked(node);
  node.properties = node.properties || {};
  node.properties[TRACKED_PROP] = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
  syncLabelWidgets();
  (_a = node.setDirtyCanvas) == null ? void 0 : _a.call(node, true, true);
}
const listable = (w) => !!(w == null ? void 0 : w.name) && !w.hidden && ["string", "number", "boolean"].includes(typeof w.value);
function registerTrackedWidgets() {
  app.registerExtension({
    name: "NKD.TrackedWidgets",
    getNodeMenuItems(node) {
      var _a, _b;
      const widgets = (node.widgets ?? []).filter(listable);
      if (!widgets.length || node.comfyClass === VIEWER) return [];
      const cur = tracked(node);
      const items = [];
      const under = (_b = (_a = app.canvas) == null ? void 0 : _a.getWidgetAtCursor) == null ? void 0 : _b.call(_a);
      if (under && widgets.includes(under)) {
        const on = cur.includes(under.name);
        items.push({
          content: `🏷 ${on ? "Untrack" : "Track"} '${under.name}' in labels`,
          callback: () => toggleTrack(node, under.name)
        });
      }
      items.push({
        content: "🏷 Track widgets…",
        submenu: {
          options: widgets.map((w) => ({
            content: `${cur.includes(w.name) ? "✓ " : " "}${w.name}`,
            callback: () => toggleTrack(node, w.name)
          }))
        }
      });
      if (cur.length) {
        items.push({
          content: `🏷 Untrack all (${cur.length})`,
          callback: () => {
            var _a2;
            node.properties[TRACKED_PROP] = [];
            syncLabelWidgets();
            (_a2 = node.setDirtyCanvas) == null ? void 0 : _a2.call(node, true, true);
          }
        });
      }
      return items;
    },
    nodeCreated(node) {
      const orig = node.onDrawForeground;
      node.onDrawForeground = function(ctx) {
        var _a;
        const r = orig == null ? void 0 : orig.apply(this, arguments);
        if (!((_a = this.flags) == null ? void 0 : _a.collapsed) && tracked(this).length) {
          ctx.save();
          ctx.font = "12px sans-serif";
          ctx.textAlign = "right";
          ctx.fillText("🏷", this.size[0] - 6, -9);
          ctx.restore();
        }
        return r;
      };
    },
    // A saved workflow can carry a stale list (a tracked node deleted since, marks made
    // while no viewer existed): recompute once the graph is fully restored.
    afterConfigureGraph() {
      syncLabelWidgets();
    }
  });
}
function liveValue(node, name) {
  var _a, _b;
  const v = (_b = (_a = node.widgets) == null ? void 0 : _a.find((w) => w.name === name)) == null ? void 0 : _b.value;
  const s = v === void 0 ? "(linked)" : String(v).replace(/\s+/g, " ").trim();
  return s.length > 40 ? s.slice(0, 39) + "…" : s;
}
function trackedChip(parent) {
  const btn = document.createElement("button");
  btn.className = "nkd-tl-btn";
  btn.title = "Tracked widgets — burned into the _labeled review copy. Click to manage.";
  parent.appendChild(btn);
  const icon = document.createElement("i");
  icon.className = "pi pi-tags";
  btn.appendChild(icon);
  const count = document.createElement("span");
  count.className = "nkd-proj-label";
  btn.appendChild(count);
  const paint = () => {
    const n = entries().length;
    count.textContent = String(n);
    btn.style.display = n ? "" : "none";
  };
  paint();
  chips.add(paint);
  btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const items = [{ label: "Tracked widgets — click to untrack", header: true }];
    for (const { node, name } of entries()) {
      items.push({
        label: `${node.title ?? node.type} · ${name}: ${liveValue(node, name)}`,
        active: true,
        on: () => toggleTrack(node, name)
      });
    }
    items.push({
      label: "✕ Clear all",
      on: () => {
        var _a, _b;
        for (const { node } of entries()) node.properties[TRACKED_PROP] = [];
        syncLabelWidgets();
        (_b = (_a = app.graph) == null ? void 0 : _a.setDirtyCanvas) == null ? void 0 : _b.call(_a, true, true);
      }
    });
    const r = btn.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, items);
  });
  return { el: btn, destroy: () => {
    chips.delete(paint);
  } };
}
function adoptStyles(target) {
  const baseTag = target.createElement("base");
  baseTag.href = document.baseURI;
  target.head.appendChild(baseTag);
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    target.head.appendChild(node.cloneNode(true));
  }
  const base = target.createElement("style");
  base.textContent = "html,body{margin:0;padding:0;height:100%;background:#16181d;overflow:hidden}.nkd-vid{height:100%;box-sizing:border-box;padding:6px;display:flex;flex-direction:column;gap:6px}.nkd-vid .nkd-vid-stage{flex:1 1 auto;min-height:0;max-width:none!important;aspect-ratio:auto!important}";
  target.head.appendChild(base);
}
async function openPopout(root, title, onMoved) {
  const home = root.parentElement;
  if (!home) return null;
  const placeholder = document.createElement("div");
  placeholder.className = "nkd-vid-away";
  placeholder.textContent = "playing in a floating window";
  const width = Math.max(480, Math.round(root.clientWidth) || 640);
  const height = Math.max(360, Math.round(root.offsetHeight) || 480);
  let win = null;
  const pip = window.documentPictureInPicture;
  try {
    win = pip ? await pip.requestWindow({ width, height }) : null;
  } catch {
    win = null;
  }
  if (!win) {
    win = window.open(
      "",
      "nkd-video-viewer",
      `popup=yes,width=${width},height=${height}`
    );
  }
  if (!win) return null;
  const doc = win.document;
  adoptStyles(doc);
  doc.title = title;
  home.appendChild(placeholder);
  doc.body.appendChild(root);
  root.focus();
  onMoved();
  let open = true;
  const closeOnExit = () => {
    try {
      win == null ? void 0 : win.close();
    } catch {
    }
  };
  const goHome = () => {
    if (!open) return;
    open = false;
    window.removeEventListener("beforeunload", closeOnExit);
    home.appendChild(root);
    placeholder.remove();
    onMoved();
  };
  win.addEventListener("pagehide", goHome);
  win.addEventListener("beforeunload", goHome);
  window.addEventListener("beforeunload", closeOnExit);
  return {
    close: () => {
      try {
        win == null ? void 0 : win.close();
      } catch {
      }
      goHome();
    },
    isOpen: () => open
  };
}
const COMPARE_ORDER = ["off", "wipe", "difference"];
const REF_DRIFT_S = 0.25;
const PREVIEW_MAX_H = 260;
const SCRUB_H = 44;
const SHUTTLE = [1, 2, 4, 8];
const el = (tag, cls, parent) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  parent == null ? void 0 : parent.appendChild(node);
  return node;
};
function button(parent, icon, title, onClick) {
  const b = el("button", "nkd-tl-btn", parent);
  b.title = title;
  b.appendChild(el("i", icon));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
const humanSize = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
class VideoViewer {
  constructor(state) {
    __publicField(this, "root");
    __publicField(this, "stage");
    __publicField(this, "video");
    __publicField(this, "still");
    // GIF has no seekable stream; show it as-is
    __publicField(this, "scrub");
    __publicField(this, "status");
    __publicField(this, "playBtn");
    __publicField(this, "loopBtn");
    __publicField(this, "muteBtn");
    __publicField(this, "link");
    __publicField(this, "pathLine");
    __publicField(this, "chip");
    __publicField(this, "labelsChip");
    __publicField(this, "ref", null);
    /** What the stage is actually showing: the render, or the `_labeled` review copy. The
     *  download link and the path line stay on `ref` — the labeled copy is display only. */
    __publicField(this, "shown", null);
    __publicField(this, "info", null);
    __publicField(this, "raf", 0);
    __publicField(this, "dragging", false);
    /** Coalesced seek target in seconds, -1 when nothing is pending. See `applySeek`. */
    __publicField(this, "want", -1);
    __publicField(this, "seeking", false);
    __publicField(this, "guard", 0);
    /** Pre-rendered filmstrip. Only the playhead moves while scrubbing, so rebuilding the
     *  strip on every pointermove is pure waste - and it is the expensive half of a draw. */
    __publicField(this, "strip", document.createElement("canvas"));
    __publicField(this, "stripKey", "");
    /** The before/after layer: a second `<video>` stacked over the first. */
    __publicField(this, "refVideo");
    __publicField(this, "divider");
    __publicField(this, "compareBtn");
    __publicField(this, "compare", "off");
    __publicField(this, "wipe", 0.5);
    // 0..1, how much of the reference is showing
    __publicField(this, "holding", false);
    // hold B: reference full-frame
    __publicField(this, "hasRef", false);
    /** The reference wired into the node. It BEATS the global slot: a connection is a
     *  statement about this node, the slot is whatever happened to run last. */
    __publicField(this, "wired", null);
    /** Bound once so it can be removed again: a viewer deleted from the graph must not keep
     *  answering the api's events. */
    __publicField(this, "onPromptDone", () => {
      if (!this.wired) void this.loadReference();
    });
    __publicField(this, "popout", null);
    /** Showing the `_labeled` review copy instead of the clean render. Display only: the
     *  download button and the path line keep pointing at the render. */
    __publicField(this, "showLabels", false);
    __publicField(this, "labelsBtn");
    /** Persisted on the node, not in a widget: what the viewer is doing does not change what
     *  the graph produces, and an input would re-encode the video on every toggle. */
    __publicField(this, "onState", null);
    __publicField(this, "onHeightChange", null);
    this.root = el("div", "nkd-tl nkd-vid");
    this.root.tabIndex = 0;
    this.stage = el("div", "nkd-vid-stage", this.root);
    this.video = el("video", "nkd-vid-el", this.stage);
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.loop = (state == null ? void 0 : state.loop) !== false;
    this.video.muted = !!(state == null ? void 0 : state.muted);
    this.still = el("img", "nkd-vid-el", this.stage);
    this.still.style.display = "none";
    this.refVideo = el("video", "nkd-vid-el nkd-vid-ref", this.stage);
    this.refVideo.playsInline = true;
    this.refVideo.muted = true;
    this.refVideo.preload = "auto";
    this.divider = el("div", "nkd-vid-divider", this.stage);
    this.compare = (state == null ? void 0 : state.compare) ?? "off";
    if (typeof (state == null ? void 0 : state.wipe) === "number") this.wipe = state.wipe;
    this.scrub = el("canvas", "nkd-vid-scrub", this.root);
    const bar = el("div", "nkd-tl-bar", this.root);
    this.playBtn = button(bar, "pi pi-play", "Play / pause (Space)", () => this.toggle());
    button(bar, "pi pi-step-backward", "Previous frame (←)", () => this.step(-1));
    button(bar, "pi pi-step-forward", "Next frame (→)", () => this.step(1));
    this.loopBtn = button(bar, "pi pi-replay", "Loop", () => {
      this.video.loop = !this.video.loop;
      this.syncButtons();
      this.pushState();
    });
    this.muteBtn = button(bar, "pi pi-volume-up", "Mute", () => {
      this.video.muted = !this.video.muted;
      this.syncButtons();
      this.pushState();
    });
    button(bar, "pi pi-window-maximize", "Full screen (F)", () => this.toggleFullscreen());
    button(
      bar,
      "pi pi-external-link",
      "Float in its own window — drag it to a second monitor",
      () => void this.togglePopout()
    );
    this.compareBtn = button(
      bar,
      "pi pi-arrows-h",
      "Compare against the reference: off / wipe / difference (C). Hold B to see it whole.",
      () => this.cycleCompare()
    );
    button(bar, "pi pi-bookmark", "Use this render as the reference", () => {
      void this.setAsReference();
    });
    this.showLabels = !!(state == null ? void 0 : state.labels);
    this.labelsBtn = button(
      bar,
      "pi pi-tag",
      "Show the labeled review copy (tracked widget values burned in)",
      () => {
        this.showLabels = !this.showLabels;
        this.pushState();
        if (this.ref && this.info) this.setSource(this.ref, this.info);
      }
    );
    this.labelsBtn.style.display = "none";
    this.link = el("a", "nkd-tl-btn", bar);
    this.link.title = "Save a copy";
    this.link.appendChild(el("i", "pi pi-download"));
    revealButton(bar, () => this.ref);
    this.chip = projectChip(bar);
    this.labelsChip = trackedChip(bar);
    this.status = el("div", "nkd-tl-status", bar);
    this.status.textContent = "no video yet";
    this.pathLine = el("div", "nkd-vid-path", this.root);
    this.pathLine.title = "Click to copy the full path";
    this.pathLine.addEventListener("click", () => {
      var _a;
      void ((_a = navigator.clipboard) == null ? void 0 : _a.writeText(this.pathLine.dataset.full || ""));
      const was = this.pathLine.textContent;
      this.pathLine.textContent = "copied";
      window.setTimeout(() => {
        this.pathLine.textContent = was;
      }, 900);
    });
    this.syncButtons();
    if (this.compare !== "off") void this.loadReference();
    else this.applyCompare();
    this.wire();
  }
  // ── Source ──────────────────────────────────────────────────────────────────
  setSource(ref, info) {
    var _a;
    this.ref = ref;
    this.info = info;
    this.stripKey = "";
    this.want = -1;
    this.seeking = false;
    window.clearTimeout(this.guard);
    const labeled = info.labeled ?? null;
    this.labelsBtn.style.display = labeled ? "" : "none";
    this.labelsBtn.classList.toggle("on", this.showLabels && !!labeled);
    this.shown = this.showLabels && labeled ? labeled : ref;
    const url = viewUrl(this.shown);
    this.link.href = viewUrl(ref);
    this.link.setAttribute("download", ref.filename);
    const aspect = info.width / Math.max(1, info.height);
    this.stage.style.aspectRatio = `${info.width} / ${info.height}`;
    this.stage.style.maxWidth = `${Math.round(PREVIEW_MAX_H * aspect)}px`;
    if (this.playable) {
      this.still.style.display = "none";
      this.video.style.display = "";
      if (this.video.src !== url) this.video.src = url;
      ensureThumbnails(this.shown, {
        fps: info.fps,
        frame_count: info.frame_count,
        duration: info.frame_count / Math.max(1e-6, info.fps),
        width: info.width,
        height: info.height
      }, () => this.draw());
    } else {
      this.video.removeAttribute("src");
      this.video.load();
      this.video.style.display = "none";
      this.still.style.display = "";
      this.still.src = info.poster ? viewUrl({ ...ref, filename: info.poster }) : url;
    }
    const shown = ref.filename;
    this.link.setAttribute("download", shown);
    const where = `${ref.type}/${ref.subfolder ? ref.subfolder + "/" : ""}${shown}`;
    this.pathLine.textContent = where;
    this.pathLine.dataset.full = info.path || where;
    this.syncButtons();
    this.draw();
    this.wired = info.reference ?? null;
    if (this.wired) this.showReference(this.wired);
    else if (this.compare !== "off") void this.loadReference();
    (_a = this.onHeightChange) == null ? void 0 : _a.call(this);
  }
  // ── Compare ─────────────────────────────────────────────────────────────────
  /** Point the "before" layer at a file. */
  showReference(ref) {
    const url = viewUrl(ref);
    if (this.refVideo.src !== url) this.refVideo.src = url;
    this.hasRef = true;
    this.applyCompare();
  }
  /** Fetch whatever the global reference slot currently points at. */
  async loadReference() {
    if (this.wired) {
      this.showReference(this.wired);
      return;
    }
    try {
      const r = await api.fetchApi("/nkd/ref/get_video");
      if (!r.ok) {
        this.hasRef = false;
        this.applyCompare();
        return;
      }
      this.showReference(await r.json());
      return;
    } catch {
      this.hasRef = false;
    }
    this.applyCompare();
  }
  /** Nominate the render on screen as the reference, so the next run can be wiped
   *  against it. Without this you would have to re-queue the graph through a Reference
   *  node just to nominate the thing you are already looking at. */
  async setAsReference() {
    if (!this.ref) return;
    try {
      await api.fetchApi("/nkd/ref/set_video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.ref)
      });
      await this.loadReference();
      this.flash(this.wired ? "set for other viewers (this one is wired)" : "reference set");
    } catch {
      this.flash("could not set reference");
    }
  }
  cycleCompare() {
    const next = COMPARE_ORDER[(COMPARE_ORDER.indexOf(this.compare) + 1) % COMPARE_ORDER.length];
    this.compare = next;
    const done = () => {
      this.applyCompare();
      if (next !== "off" && !this.hasRef) {
        this.flash("no reference — wire `reference`, or run an NKD Reference node");
      }
    };
    if (next !== "off" && !this.hasRef) void this.loadReference().then(done);
    else done();
    this.pushState();
  }
  applyCompare() {
    const on = this.compare !== "off" && this.hasRef;
    const showing = on || this.holding && this.hasRef;
    this.refVideo.style.display = showing ? "" : "none";
    this.refVideo.style.mixBlendMode = on && this.compare === "difference" ? "difference" : "normal";
    const clip = this.holding || this.compare === "difference" ? "none" : `inset(0 ${(1 - this.wipe) * 100}% 0 0)`;
    this.refVideo.style.clipPath = clip;
    this.divider.style.display = on && this.compare === "wipe" && !this.holding ? "" : "none";
    this.divider.style.left = `${this.wipe * 100}%`;
    this.compareBtn.classList.toggle("on", this.compare !== "off");
    this.compareBtn.firstElementChild.className = this.compare === "difference" ? "pi pi-clone" : "pi pi-arrows-h";
    if (showing) this.syncReference(true);
  }
  /**
   * Keep the reference on the same MOMENT as the current clip.
   *
   * Driven from the main element rather than bound to it: matched by time, corrected only
   * past the drift threshold, and told to play or pause alongside. Seeking it every frame
   * is what would turn a smooth comparison into a slideshow.
   */
  syncReference(force = false) {
    if (this.refVideo.style.display === "none" || this.refVideo.readyState < 1) return;
    const t = this.video.currentTime;
    if (force || Math.abs(this.refVideo.currentTime - t) > REF_DRIFT_S) {
      try {
        this.refVideo.currentTime = t;
      } catch {
      }
    }
    if (this.video.paused && !this.refVideo.paused) this.refVideo.pause();
    else if (!this.video.paused && this.refVideo.paused) {
      this.refVideo.playbackRate = this.video.playbackRate;
      void this.refVideo.play().catch(() => {
      });
    }
  }
  /**
   * Full screen takes the WHOLE widget, not just the picture.
   *
   * Sending only the stage is what left the transport, the scrub bar and the compare
   * controls behind on the page - a full-screen player you cannot scrub is a wallpaper. The
   * root also carries the key handler, so it has to be focused once it is up or Space and
   * the arrows would go to the page instead.
   */
  toggleFullscreen() {
    var _a, _b, _c;
    if (document.fullscreenElement === this.root) {
      void ((_a = document.exitFullscreen) == null ? void 0 : _a.call(document).catch(() => {
      }));
      return;
    }
    void ((_c = (_b = this.root).requestFullscreen) == null ? void 0 : _c.call(_b).then(() => {
      this.root.focus();
      this.draw();
    }).catch(() => {
    }));
  }
  /**
   * Send the viewer to its own window, or bring it back.
   *
   * The `<video>` survives the move but does not keep playing across it, so the position
   * and the play state are carried over by hand - landing back at frame 0 after popping out
   * would lose the shot you were looking at.
   */
  async togglePopout() {
    var _a;
    if ((_a = this.popout) == null ? void 0 : _a.isOpen()) {
      this.popout.close();
      this.popout = null;
      return;
    }
    const at = this.video.currentTime;
    const wasPlaying = !this.video.paused;
    const restore = () => {
      this.stripKey = "";
      this.want = at;
      this.seeking = false;
      this.applySeek();
      if (wasPlaying) void this.video.play().catch(() => {
      });
      this.draw();
    };
    this.popout = await openPopout(this.root, "😺NKD Video Viewer", restore);
    if (!this.popout) this.flash("the browser refused a floating window");
  }
  flash(text) {
    const was = this.pathLine.textContent;
    this.pathLine.textContent = text;
    window.setTimeout(() => {
      this.pathLine.textContent = was;
    }, 1200);
  }
  // ── Transport ───────────────────────────────────────────────────────────────
  get fps() {
    var _a;
    return Math.max(1e-6, ((_a = this.info) == null ? void 0 : _a.fps) ?? 24);
  }
  /** Where the playhead IS, or where it is heading while a seek is in flight.
   *
   *  Reading `currentTime` alone made the readout and the playhead lag a drag by however
   *  long the decode took; the pending target is what the user actually asked for. */
  get frame() {
    const t = this.want >= 0 ? this.want : this.video.currentTime;
    return Math.floor(t * this.fps + 1e-4);
  }
  seekFrame(f) {
    var _a;
    const last = Math.max(0, (((_a = this.info) == null ? void 0 : _a.frame_count) ?? 1) - 1);
    const clamped = Math.max(0, Math.min(last, f));
    this.want = (clamped + 0.5) / this.fps;
    this.applySeek();
  }
  /**
   * Ask for the pending time, but only one seek at a time.
   *
   * Assigning `currentTime` on every pointermove is what makes a scrub lag: dozens of
   * requests a second land on an element that can service exactly one, and an h264 seek is
   * expensive. Coalescing means the element always works towards the LATEST position and
   * the intermediate ones are simply dropped - the same trick `media.ts` uses for the
   * timeline, which is why that one scrubs smoothly.
   *
   * Two guards that are not optional:
   * - `readyState < 1`: assigning `currentTime` before metadata is IGNORED silently, so no
   *   `seeked` ever fires. Setting `seeking = true` around that wedges the element for the
   *   rest of the session. `loadedmetadata` retries instead.
   * - the watchdog: one lost `seeked` must not make every later seek short-circuit forever.
   */
  applySeek() {
    if (this.seeking || this.want < 0) return;
    if (this.video.readyState < 1) return;
    this.seeking = true;
    try {
      this.video.currentTime = this.want;
    } catch {
      this.seeking = false;
      return;
    }
    window.clearTimeout(this.guard);
    this.guard = window.setTimeout(() => {
      this.seeking = false;
      this.applySeek();
    }, 2e3);
  }
  step(delta) {
    if (!this.playable) return;
    this.video.pause();
    this.seekFrame(this.frame + delta);
    this.syncButtons();
  }
  toggle() {
    if (!this.playable) return;
    if (this.video.paused) {
      this.video.playbackRate = 1;
      void this.video.play().catch(() => {
      });
    } else {
      this.video.pause();
    }
    this.syncButtons();
  }
  /** J and L walk the shuttle speeds. Reverse is not offered: no browser plays a stream
   *  backwards, and faking it with a seek per frame is what makes a preview stutter. */
  shuttle(dir) {
    if (!this.playable) return;
    if (dir < 0) {
      this.step(-1);
      return;
    }
    const i = SHUTTLE.indexOf(this.video.playbackRate);
    this.video.playbackRate = SHUTTLE[Math.min(SHUTTLE.length - 1, i + 1)] ?? 1;
    if (this.video.paused) void this.video.play().catch(() => {
    });
    this.syncButtons();
  }
  /**
   * Can THIS browser actually play it?
   *
   * Not a property of the file. h265 is patent-encumbered, so browsers ship no software
   * decoder and defer to the GPU: the same mp4 plays here and shows nothing on the next
   * machine. Asking `canPlayType` is the only honest answer, and it costs nothing - so the
   * backend states the codec and this decides.
   */
  get playable() {
    var _a, _b;
    if (this.showLabels && ((_a = this.info) == null ? void 0 : _a.labeled)) {
      return this.video.canPlayType('video/mp4; codecs="avc1.42E01E"') !== "";
    }
    if (((_b = this.info) == null ? void 0 : _b.preview) !== "video") return false;
    const mime = this.info.mime;
    if (!mime) return true;
    return this.video.canPlayType(mime) !== "";
  }
  // ── Wiring ──────────────────────────────────────────────────────────────────
  pushState() {
    var _a;
    (_a = this.onState) == null ? void 0 : _a.call(this, {
      loop: this.video.loop,
      muted: this.video.muted,
      compare: this.compare,
      wipe: this.wipe,
      labels: this.showLabels
    });
  }
  wire() {
    const tick = () => {
      this.draw();
      this.syncReference();
      this.raf = this.video.paused ? 0 : requestAnimationFrame(tick);
    };
    this.video.addEventListener("play", () => {
      this.want = -1;
      this.syncButtons();
      if (!this.raf) this.raf = requestAnimationFrame(tick);
    });
    this.video.addEventListener("pause", () => {
      this.syncButtons();
      this.draw();
    });
    this.video.addEventListener("seeked", () => {
      window.clearTimeout(this.guard);
      this.seeking = false;
      if (this.want >= 0 && Math.abs(this.want - this.video.currentTime) > 1e-3) {
        this.applySeek();
      } else {
        this.want = -1;
      }
      this.draw();
      this.syncReference(true);
    });
    this.video.addEventListener("loadedmetadata", () => {
      this.applySeek();
      this.draw();
    });
    const at = (e) => {
      var _a;
      const r = this.scrub.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      this.seekFrame(Math.round(t * ((((_a = this.info) == null ? void 0 : _a.frame_count) ?? 1) - 1)));
      this.draw();
    };
    this.scrub.addEventListener("pointerdown", (e) => {
      if (!this.playable) return;
      this.dragging = true;
      this.scrub.setPointerCapture(e.pointerId);
      this.video.pause();
      at(e);
    });
    this.scrub.addEventListener("pointermove", (e) => {
      if (this.dragging) at(e);
    });
    this.scrub.addEventListener("pointerup", (e) => {
      this.dragging = false;
      this.scrub.releasePointerCapture(e.pointerId);
    });
    let wiping = false;
    const setWipe = (e) => {
      const r = this.stage.getBoundingClientRect();
      this.wipe = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      this.applyCompare();
    };
    this.stage.addEventListener("pointerdown", (e) => {
      if (this.compare !== "wipe" || !this.hasRef) return;
      wiping = true;
      this.stage.setPointerCapture(e.pointerId);
      setWipe(e);
    });
    this.stage.addEventListener("pointermove", (e) => {
      if (wiping) setWipe(e);
    });
    this.stage.addEventListener("pointerup", (e) => {
      if (!wiping) return;
      wiping = false;
      this.stage.releasePointerCapture(e.pointerId);
      this.pushState();
    });
    this.root.addEventListener("keyup", (e) => {
      if (e.key.toLowerCase() === "b" && this.holding) {
        this.holding = false;
        this.applyCompare();
      }
    });
    this.root.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (k === "b") {
        if (!e.repeat) {
          if (!this.hasRef) void this.loadReference();
          this.holding = true;
          this.applyCompare();
        }
        handled();
        return;
      }
      if (k === "c") {
        this.cycleCompare();
        handled();
        return;
      }
      if (k === "f") {
        this.toggleFullscreen();
        handled();
        return;
      }
      if (k === " ") {
        this.toggle();
        handled();
      } else if (k === "arrowleft") {
        this.step(e.shiftKey ? -10 : -1);
        handled();
      } else if (k === "arrowright") {
        this.step(e.shiftKey ? 10 : 1);
        handled();
      } else if (k === "l") {
        this.shuttle(1);
        handled();
      } else if (k === "j") {
        this.shuttle(-1);
        handled();
      } else if (k === "k") {
        this.video.pause();
        this.syncButtons();
        handled();
      } else if (k === "home") {
        this.seekFrame(0);
        handled();
      } else if (k === "end") {
        this.seekFrame(Number.MAX_SAFE_INTEGER);
        handled();
      }
    });
    api.addEventListener("execution_success", this.onPromptDone);
    new ResizeObserver(() => this.draw()).observe(this.scrub);
    document.addEventListener("fullscreenchange", () => {
      this.stripKey = "";
      requestAnimationFrame(() => this.draw());
    });
  }
  syncButtons() {
    const icon = this.playBtn.firstElementChild;
    icon.className = this.video.paused ? "pi pi-play" : "pi pi-pause";
    this.loopBtn.classList.toggle("on", this.video.loop);
    this.muteBtn.firstElementChild.className = this.video.muted ? "pi pi-volume-off" : "pi pi-volume-up";
    this.muteBtn.classList.toggle("on", this.video.muted);
  }
  // ── Scrub bar ───────────────────────────────────────────────────────────────
  /** Height the widget needs, so the node can wrap around it before anything is measured. */
  estimateHeight(width) {
    const aspect = this.info ? this.info.width / Math.max(1, this.info.height) : 16 / 9;
    return Math.min(Math.round((width - 24) / aspect), PREVIEW_MAX_H) + SCRUB_H + 40;
  }
  /**
   * The filmstrip, rendered once and reused.
   *
   * Rebuilt only when the width, the source or the number of available stills changes -
   * `thumbnailAt` scans the whole strip for every column, so doing this per pointermove was
   * the other half of the scrub lag. The count is in the key because stills arrive
   * progressively: the strip fills in as they land, then stops changing.
   */
  buildStrip(w, dpr) {
    const info = this.info;
    const duration = info.frame_count / this.fps;
    const step = 48;
    const columns = Math.ceil(w / step);
    let have = 0;
    for (let i = 0; i < columns; i++) {
      if (thumbnailAt(this.shown, (i + 0.5) / columns * duration)) have++;
    }
    const key = `${this.shown.filename}|${Math.round(w)}|${dpr}|${have}`;
    if (key === this.stripKey) return this.strip;
    this.stripKey = key;
    this.strip.width = Math.max(1, Math.round(w * dpr));
    this.strip.height = Math.round(SCRUB_H * dpr);
    const sctx = this.strip.getContext("2d");
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.fillStyle = "#111318";
    sctx.fillRect(0, 0, w, SCRUB_H);
    for (let x = 0; x < w; x += step) {
      const thumb = thumbnailAt(this.shown, (x + step / 2) / w * duration);
      if (!thumb) continue;
      const tw = Math.min(step, w - x);
      sctx.drawImage(
        thumb,
        0,
        0,
        thumb.width * (tw / step),
        thumb.height,
        x,
        0,
        tw,
        SCRUB_H
      );
    }
    sctx.fillStyle = "rgba(0,0,0,0.35)";
    sctx.fillRect(0, 0, w, SCRUB_H);
    return this.strip;
  }
  draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.scrub.clientWidth || 1;
    if (this.scrub.width !== Math.round(w * dpr)) {
      this.scrub.width = Math.round(w * dpr);
      this.scrub.height = Math.round(SCRUB_H * dpr);
    }
    const ctx = this.scrub.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, SCRUB_H);
    ctx.fillStyle = "#111318";
    ctx.fillRect(0, 0, w, SCRUB_H);
    const info = this.info;
    if (!info) {
      this.status.textContent = "no video yet";
      return;
    }
    if (this.shown && this.playable) {
      ctx.drawImage(this.buildStrip(w, dpr), 0, 0, w, SCRUB_H);
      const px = this.frame / Math.max(1, info.frame_count - 1) * w;
      ctx.fillStyle = "rgba(74,180,255,0.20)";
      ctx.fillRect(0, 0, px, SCRUB_H);
      ctx.fillStyle = "#4ab4ff";
      ctx.fillRect(Math.round(px) - 1, 0, 2, SCRUB_H);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        info.preview === "image" ? `${info.format} — plays, but has no seekable stream` : `${info.format} — no browser preview, showing the first frame`,
        w / 2,
        SCRUB_H / 2 + 4
      );
      ctx.textAlign = "left";
    }
    const rate = this.video.playbackRate !== 1 && !this.video.paused ? ` · ${this.video.playbackRate}x` : "";
    this.status.textContent = this.playable ? `f ${this.frame} / ${info.frame_count - 1} · ${info.fps.toFixed(2)} fps · ${info.width}x${info.height} · ${humanSize(info.size)}${rate}` : `${info.frame_count} frames · ${info.width}x${info.height} · ${humanSize(info.size)}`;
  }
  destroy() {
    api.removeEventListener("execution_success", this.onPromptDone);
    this.chip.destroy();
    this.labelsChip.destroy();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.video.removeAttribute("src");
    this.video.load();
  }
}
const NODE_NAME$1 = "NKDVideoViewer";
const MIN_W$1 = 320;
const SCHEMA_VERSION = 2;
const STATE_PROP = "nkdVideoView";
const NAMING_TEMPLATES = [
  ["Project (versioned)", "%project%/%category%", "%node%_v%v###%"],
  ["Project (flat)", "%project%/%category%", "%node%"],
  ["Project + dated folder", "%project%/%category%/%date:yyyy-MM-dd%", "%node%_v%v###%"],
  ["Simple (dated folder)", "video/%date:yyyy-MM-dd%/%node%", ""],
  ["Versioned (Nuke layout)", "video/%node%/v%v###%", "%node%_v%v###%"],
  ["Flat", "video/%node%", ""]
];
function applyTemplate(node, folder, name) {
  var _a, _b, _c;
  const prefix = findW(node, "filename_prefix");
  if (!prefix) return;
  prefix.value = folder;
  (_a = prefix.callback) == null ? void 0 : _a.call(prefix, folder);
  const file = findW(node, "filename");
  if (file) {
    file.value = name;
    (_b = file.callback) == null ? void 0 : _b.call(file, name);
  }
  const tpl = `${folder}/${name}`;
  const versioning = findW(node, "versioning");
  if (versioning && tpl.includes("%v#") && versioning.value === "off") {
    versioning.value = "auto (next free)";
    (_c = versioning.callback) == null ? void 0 : _c.call(versioning, versioning.value);
  }
  node.setDirtyCanvas(true, true);
}
function wireNaming(node) {
  const versioning = findW(node, "versioning");
  const syncVersion = () => {
    const mode = (versioning == null ? void 0 : versioning.value) ?? "off";
    setWidgetVisible(node, "version", mode === "manual");
    setWidgetVisible(node, "numbering", mode === "off");
    node.setDirtyCanvas(true, true);
  };
  if (versioning) {
    const orig = versioning.callback;
    versioning.callback = function() {
      const r = orig == null ? void 0 : orig.apply(this, arguments);
      syncVersion();
      return r;
    };
  }
  syncVersion();
}
function registerVideoViewer() {
  app.registerExtension({
    name: "NKD.PreviewTools.Video",
    getNodeMenuItems(node) {
      if (node.comfyClass !== NODE_NAME$1) return [];
      return NAMING_TEMPLATES.map(([label, folder, name]) => ({
        content: `⎘ Name: ${label}`,
        callback: () => applyTemplate(node, folder, name)
      }));
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if ((nodeData == null ? void 0 : nodeData.name) !== NODE_NAME$1) return;
      if (nodeType.prototype.__nkdVideoWrapped) return;
      nodeType.prototype.__nkdVideoWrapped = true;
      guardWidgetOrder(nodeType, "NKD Video Viewer", SCHEMA_VERSION);
      const origCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        var _a;
        const result = origCreated == null ? void 0 : origCreated.apply(this, arguments);
        ensureStyles();
        const node = this;
        wireNaming(node);
        hideWidget(findW(node, "labels"));
        requestAnimationFrame(syncLabelWidgets);
        const viewer = new VideoViewer((_a = node.properties) == null ? void 0 : _a[STATE_PROP]);
        viewer.onState = (s) => {
          node.properties = node.properties || {};
          node.properties[STATE_PROP] = s;
        };
        const mounted = mountDomWidget(node, {
          name: "nkd_video",
          type: "NKD_VIDEO",
          root: viewer.root,
          minWidth: MIN_W$1,
          estimate: () => {
            var _a2;
            return viewer.estimateHeight(Math.max(((_a2 = node.size) == null ? void 0 : _a2[0]) ?? MIN_W$1, MIN_W$1));
          },
          onResize: () => viewer.draw()
        });
        viewer.onHeightChange = () => requestAnimationFrame(mounted.resizeToContent);
        const adopt = (message) => {
          var _a2, _b;
          const ref = (_a2 = message == null ? void 0 : message.nkd_video) == null ? void 0 : _a2[0];
          const info = (_b = message == null ? void 0 : message.nkd_meta) == null ? void 0 : _b[0];
          if (!ref || !info) return;
          viewer.setSource(ref, info);
        };
        const origExecuted = node.onExecuted;
        node.onExecuted = function(message) {
          origExecuted == null ? void 0 : origExecuted.apply(this, arguments);
          adopt(message);
        };
        const origRemoved = node.onRemoved;
        node.onRemoved = function() {
          viewer.destroy();
          mounted.release();
          origRemoved == null ? void 0 : origRemoved.apply(this, arguments);
        };
        return result;
      };
    }
  });
}
const NODE_NAME = "NKDTimeline";
const EXT_NAME = "NKD.PreviewTools.Timeline";
const AUDIO_NODE_NAME = "NKDAudioTimeline";
const AUDIO_EXT_NAME = "NKD.PreviewTools.AudioTimeline";
const MIN_W = 380;
const SLOT_RE = /(?:^|\.)(media_\d+)$/;
const TENSOR_DEFAULT_FRAMES = 24;
const KEY_SETTINGS = [
  {
    action: "trimHead",
    id: "NKD.Timeline.Key.TrimHead",
    label: "Trim head to playhead",
    def: "q"
  },
  {
    action: "trimTail",
    id: "NKD.Timeline.Key.TrimTail",
    label: "Trim tail to playhead",
    def: "e"
  },
  { action: "markIn", id: "NKD.Timeline.Key.MarkIn", label: "Mark in", def: "i" },
  { action: "markOut", id: "NKD.Timeline.Key.MarkOut", label: "Mark out", def: "o" },
  {
    action: "markClip",
    id: "NKD.Timeline.Key.MarkClip",
    label: "Mark clip (fit in/out to the clip)",
    def: "x"
  },
  {
    action: "marker",
    id: "NKD.Timeline.Key.Marker",
    label: "Freeze-frame marker at playhead (Shift+M toggles the mask overlay)",
    def: "m"
  },
  {
    action: "blade",
    id: "NKD.Timeline.Key.Blade",
    label: "Blade: split at the playhead",
    def: "w"
  },
  { action: "zoomFit", id: "NKD.Timeline.Key.ZoomFit", label: "Fit timeline", def: "f" }
];
const KEY_SETTING_BY_ACTION = new Map(KEY_SETTINGS.map((k) => [k.action, k.id]));
function readSetting(id, fallback) {
  var _a, _b, _c;
  try {
    const v = (_c = (_b = (_a = app.extensionManager) == null ? void 0 : _a.setting) == null ? void 0 : _b.get) == null ? void 0 : _c.call(_b, id);
    return typeof v === "string" && v.length ? v.toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}
console.log("[NKD Timeline] rev 3.10.2");
const VIEW_PROP = "nkdView";
function restoreView(node, tl) {
  var _a;
  const v = (_a = node.properties) == null ? void 0 : _a[VIEW_PROP];
  if (!v || typeof v !== "object") return;
  if (Number.isFinite(Number(v.zoom))) tl.ui.zoom = Number(v.zoom);
  if (Number.isFinite(Number(v.scroll))) tl.ui.scroll = Number(v.scroll);
  if (Number.isFinite(Number(v.playhead))) tl.ui.playhead = Number(v.playhead);
}
function makeHost(node, state, pool, audioOnly = false) {
  const numW = (name, def) => {
    var _a;
    const v = Number((_a = findW(node, name)) == null ? void 0 : _a.value);
    return Number.isFinite(v) ? v : def;
  };
  const setW = (name, value) => {
    var _a;
    const w = findW(node, name);
    if (!w || w.value === value) return;
    w.value = value;
    (_a = w.callback) == null ? void 0 : _a.call(w, value);
  };
  const srcCache = /* @__PURE__ */ new Map();
  const strips = /* @__PURE__ */ new Map();
  let reported = null;
  const host = {
    getTimeline: () => state.tl,
    commit() {
      const w = findW(node, "timeline");
      if (w) w.value = serialiseTimeline(state.tl);
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
    isStartFrameLinked: () => {
      var _a;
      return ((_a = node.inputs) == null ? void 0 : _a.some((i) => i.name === "start_frame" && i.link != null)) ?? false;
    },
    getFrameCount: () => Math.max(0, Math.round(numW("frame_count", 0))),
    setFrameCount: (v) => setW("frame_count", Math.max(0, Math.round(v))),
    getQuantize: () => {
      var _a;
      return ((_a = findW(node, "model")) == null ? void 0 : _a.value) ?? "free";
    },
    getQuantizeN: () => Math.max(1, Math.round(numW("quantize_n", 8))),
    getFit: () => {
      var _a;
      return ((_a = findW(node, "fit")) == null ? void 0 : _a.value) ?? "contain";
    },
    getImportMode: () => {
      var _a;
      return ((_a = findW(node, "import_mode")) == null ? void 0 : _a.value) ?? "stack";
    },
    getKey: (action, fallback) => readSetting(KEY_SETTING_BY_ACTION.get(action) ?? "", fallback),
    srcFramesFor(src) {
      var _a;
      const info = (_a = host.sourceFor(src)) == null ? void 0 : _a.info;
      if (info == null ? void 0 : info.frame_count) return info.frame_count;
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
    audioFramesFor(src) {
      var _a;
      const ref = (_a = host.sourceFor(src)) == null ? void 0 : _a.ref;
      const buf = ref && audioBufferFor(ref);
      return buf ? Math.round(buf.duration * host.getFps()) : null;
    },
    reloadSources() {
      pool().bust();
      srcCache.clear();
      node.setDirtyCanvas(true, true);
    },
    notify(summary, detail, severity = "info") {
      var _a, _b, _c;
      (_c = (_b = (_a = app.extensionManager) == null ? void 0 : _a.toast) == null ? void 0 : _b.add) == null ? void 0 : _c.call(_b, {
        severity,
        summary,
        detail,
        life: 8e3
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
    getOutSize() {
      var _a, _b, _c;
      const firstClip = state.tl.clips[0] ?? state.tl.masks[0];
      const srcInfo = firstClip ? (_a = srcCache.get(firstClip.src)) == null ? void 0 : _a.info : null;
      const [w, h] = resolveResolution(
        String(((_b = findW(node, "aspect_ratio")) == null ? void 0 : _b.value) ?? ASPECT_CUSTOM),
        numW("megapixels", 1),
        Math.round(numW("width", 0)),
        Math.round(numW("height", 0)),
        numW("size_multiple", 16),
        (srcInfo == null ? void 0 : srcInfo.width) ?? 0,
        (srcInfo == null ? void 0 : srcInfo.height) ?? 0
      );
      if (w > 0 && h > 0) return [w, h];
      if (reported && reported.width > 0 && reported.height > 0) {
        return [reported.width, reported.height];
      }
      const first = state.tl.clips[0];
      const info = first ? (_c = srcCache.get(first.src)) == null ? void 0 : _c.info : null;
      return info ? [info.width, info.height] : [16, 9];
    },
    sourceFor(src) {
      const strip = strips.get(src);
      if (strip) return strip;
      const hit = srcCache.get(src);
      if (hit) {
        if (!hit.info) hit.info = cachedInfo(hit.ref) ?? null;
        return hit;
      }
      const kind = slotKind(node, src);
      const ref = resolveSource(node, src, kind === "image" || kind === "mask" ? 0 : 6);
      if (!ref) return null;
      const entry = { ref, info: cachedInfo(ref) ?? null, label: ref.filename };
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
      const out = { video: [], image: [], mask: [], audio: [] };
      for (const inp of node.inputs ?? []) {
        const m = SLOT_RE.exec(inp.name ?? "");
        if (!m || inp.link == null) continue;
        const kind = slotKind(node, m[1]);
        if (kind) out[kind].push(m[1]);
      }
      if (audioOnly) {
        return {
          videos: [],
          images: [],
          masks: [],
          audios: [...out.audio, ...out.video, ...out.image, ...out.mask]
        };
      }
      return {
        videos: out.video,
        images: out.image,
        masks: out.mask,
        audios: out.audio
      };
    },
    conformToFirstClip(from) {
      var _a;
      const first = state.tl.clips[0];
      const info = from ?? (first ? (_a = host.sourceFor(first.src)) == null ? void 0 : _a.info : null);
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
        if (!(t == null ? void 0 : t.filename) || !(t.tiles > 0)) continue;
        const prev = strips.get(slot);
        if ((prev == null ? void 0 : prev.ref.filename) === t.filename) continue;
        if (prev) pool().forget(prev.ref);
        const ref = {
          filename: t.filename,
          subfolder: t.subfolder ?? "",
          type: t.type ?? "temp"
        };
        const info = {
          fps: t.fps,
          frame_count: t.frame_count,
          duration: t.duration,
          width: t.width,
          height: t.height
        };
        strips.set(slot, { ref, info, label: `${slot} · computed` });
        adoptStrip(ref, info, t.tiles, Math.max(1, t.cols || t.tiles), onReady);
        changed = true;
      }
      return changed;
    },
    pruneStrips(live) {
      for (const slot of [...strips.keys()]) {
        if (live.has(slot)) continue;
        pool().forget(strips.get(slot).ref);
        strips.delete(slot);
      }
    },
    /** Read the cache WITHOUT resolving, so the swap detector can compare against it. */
    peekSource: (src) => srcCache.get(src),
    dropSource: (src) => {
      srcCache.delete(src);
    }
  };
  return host;
}
function registerTimelineNode(v) {
  app.registerExtension({
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
      tooltip: `Single key, lower-case. Default: ${k.def}`
    })),
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if ((nodeData == null ? void 0 : nodeData.name) !== v.node) return;
      if (nodeType.prototype[v.flag]) return;
      nodeType.prototype[v.flag] = true;
      guardWidgetOrder(nodeType, v.node, 1);
      const origCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        var _a;
        const result = origCreated == null ? void 0 : origCreated.apply(this, arguments);
        ensureStyles();
        const node = this;
        const dataW = findW(node, "timeline");
        hideWidget(dataW);
        const ghost = (_a = node.inputs) == null ? void 0 : _a.findIndex((i) => i.name === "timeline");
        if (ghost >= 0) node.removeInput(ghost);
        const state = { tl: parseTimeline(dataW == null ? void 0 : dataW.value) };
        restoreView(node, state.tl);
        let editor;
        const host = makeHost(node, state, () => editor.pool, v.audioOnly);
        editor = new TimelineEditor(host, { audioOnly: v.audioOnly });
        const container = document.createElement("div");
        container.style.width = "100%";
        container.style.minWidth = `${MIN_W}px`;
        container.appendChild(editor.root);
        let measured = 0;
        let inset = 0;
        const estimate = () => {
          var _a2;
          if (v.audioOnly) return editor.timelineHeight + 40;
          const w = Math.max(((_a2 = node.size) == null ? void 0 : _a2[0]) ?? MIN_W, MIN_W);
          const [ow, oh] = host.getOutSize();
          return Math.min(Math.round((w - 24) * (oh / Math.max(1, ow))), PREVIEW_MAX_H$1) + editor.timelineHeight + 40;
        };
        const heightFor = () => (measured > 0 ? measured : estimate()) + ROW_SAFETY + inset;
        node.addDOMWidget("nkd_timeline", "NKD_TIMELINE", container, {
          getValue: () => (dataW == null ? void 0 : dataW.value) ?? "",
          setValue: (v2) => {
            if (dataW) dataW.value = v2;
            state.tl = parseTimeline(v2);
            restoreView(node, state.tl);
            editor.requestRender();
          },
          serialize: false,
          hideOnZoom: false,
          getMinHeight: heightFor,
          getMaxHeight: heightFor,
          getHeight: heightFor
        });
        const widthKeeper = keepDomWidgetSized(node, container, MIN_W);
        const minNodeWidth = () => MIN_W + widthKeeper.margin();
        const resizeToContent = () => {
          node.setSize([Math.max(node.size[0], minNodeWidth()), node.computeSize()[1]]);
          node.setDirtyCanvas(true, true);
        };
        let settling = false;
        const calibrate = () => {
          var _a2;
          const hostH = ((_a2 = container.parentElement) == null ? void 0 : _a2.clientHeight) ?? 0;
          if (hostH < 1) return false;
          const gap = Math.min(MAX_INSET, Math.max(0, Math.round(heightFor() - hostH)));
          if (Math.abs(gap - inset) <= 1) return false;
          inset = gap;
          return true;
        };
        const ro = new ResizeObserver(() => {
          if (settling) return;
          const h = editor.root.offsetHeight;
          if (h < 1) return;
          const grew = Math.abs(h - measured) > 1;
          if (grew) measured = h;
          if (!calibrate() && !grew) return;
          settling = true;
          resizeToContent();
          requestAnimationFrame(() => {
            settling = false;
          });
        });
        ro.observe(editor.root);
        editor.onHeightChange = () => requestAnimationFrame(resizeToContent);
        const origResize = node.onResize;
        node.onResize = function(size) {
          origResize == null ? void 0 : origResize.apply(this, arguments);
          const min = minNodeWidth();
          if (size[0] < min) size[0] = min;
          size[1] = this.computeSize(size[0])[1];
          editor.requestRender();
        };
        const origComputeSize = node.computeSize.bind(node);
        node.computeSize = function() {
          const sz = origComputeSize();
          const needed = heightFor();
          if (sz[1] < needed) sz[1] = needed;
          const min = minNodeWidth();
          if (sz[0] < min) sz[0] = min;
          return sz;
        };
        const setAutoFrameCount = () => {
          var _a2;
          const w = findW(node, "frame_count");
          if (!w) return;
          w.value = 0;
          (_a2 = w.callback) == null ? void 0 : _a2.call(w, 0);
          syncQuantumStep();
          node.setDirtyCanvas(true, true);
        };
        const syncQuantumStep = () => {
          var _a2;
          const w = findW(node, "frame_count");
          if (!(w == null ? void 0 : w.options)) return;
          const grid = quantizeGrid(host.getQuantize(), host.getQuantizeN());
          const value = Number(w.value) || 0;
          const [min, step] = !grid ? [0, 1] : value <= 0 ? [0, firstStop(grid[0], grid[1])] : [firstStop(grid[0], grid[1]), grid[0]];
          if (w.options.step2 === step && w.options.min === min) return;
          w.options.min = min;
          w.options.step2 = step;
          w.options.step = step * 10;
          const snapped = quantizeCount(value, host.getQuantize(), host.getQuantizeN());
          if (snapped > 0 && snapped !== value) {
            w.value = snapped;
            (_a2 = w.callback) == null ? void 0 : _a2.call(w, snapped);
          }
        };
        const clipMarkersW = findW(node, "clip_markers");
        if (clipMarkersW) {
          const origClipMarkersCb = clipMarkersW.callback;
          clipMarkersW.callback = (...args) => {
            const out = origClipMarkersCb == null ? void 0 : origClipMarkersCb.apply(clipMarkersW, args);
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
        const twinOf = (slot) => {
          var _a2, _b, _c, _d;
          const origin = (_a2 = resolveSource(node, slot, 6)) == null ? void 0 : _a2.filename;
          if (!origin) return void 0;
          const fps = host.getFps();
          for (const c of [...state.tl.clips, ...state.tl.masks]) {
            if (((_b = resolveSource(node, c.src, 6)) == null ? void 0 : _b.filename) !== origin) continue;
            const srcFps = ((_d = (_c = host.sourceFor(c.src)) == null ? void 0 : _c.info) == null ? void 0 : _d.fps) || fps;
            return {
              start: c.start,
              trimIn: Math.max(0, Math.round(c.trimIn * (fps / srcFps))),
              length: c.length
            };
          }
          return void 0;
        };
        const syncSlots = () => {
          host.clearSourceCache();
          const { videos, images, masks, audios } = host.connectedSlots();
          const live = /* @__PURE__ */ new Set([...videos, ...images, ...masks, ...audios]);
          host.pruneStrips(live);
          if (editor.pruneToSlots(live)) host.commit();
          for (const slot of videos) {
            if (slotInUse(state.tl, slot)) continue;
            const src = host.sourceFor(slot);
            if (!src) continue;
            const place = (info) => {
              if (!info) return;
              if (state.tl.clips.length === 0 && state.tl.masks.length === 0) {
                host.conformToFirstClip(info);
              }
              const fps = host.getFps();
              editor.addClipForSlot(
                slot,
                Math.round(info.frame_count * (fps / (info.fps || fps))),
                "video"
              );
            };
            if (src.info) place(src.info);
            else void probe(src.ref).then(place);
          }
          const fallback = Math.max(1, host.getFrameCount() || TENSOR_DEFAULT_FRAMES);
          for (const slot of images) {
            if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "video");
          }
          for (const slot of masks) {
            if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "mask");
          }
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
          const refs = [...state.tl.clips, ...state.tl.masks, ...state.tl.audio].map((c) => {
            var _a2;
            return (_a2 = host.sourceFor(c.src)) == null ? void 0 : _a2.ref;
          }).filter(Boolean);
          editor.pool.releaseUnused(refs);
          editor.requestRender();
        };
        const origConn = node.onConnectionsChange;
        node.onConnectionsChange = function(...args) {
          const r = origConn == null ? void 0 : origConn.apply(this, args);
          requestAnimationFrame(syncSlots);
          return r;
        };
        const origConfigure = node.onConfigure;
        node.onConfigure = function(...args) {
          const r = origConfigure == null ? void 0 : origConfigure.apply(this, args);
          requestAnimationFrame(() => {
            var _a2;
            state.tl = parseTimeline((_a2 = findW(node, "timeline")) == null ? void 0 : _a2.value);
            restoreView(node, state.tl);
            syncSlots();
            resizeToContent();
            editor.requestRender();
          });
          return r;
        };
        const onMeta = (e) => {
          const d = e == null ? void 0 : e.detail;
          if (!d || String(d.node) !== String(node.id)) return;
          const gotStrips = host.applyStrips(d.tensors, () => {
            editor.retightenToSources();
            editor.requestRender();
          });
          const gotSize = host.applyMeta(d);
          if (!gotStrips && !gotSize) return;
          if (gotSize) resizeToContent();
          editor.requestRender();
        };
        api.addEventListener("nkd-timeline-meta", onMeta);
        const detectSourceSwaps = () => {
          for (const slot of new Set(
            [...state.tl.clips, ...state.tl.masks, ...state.tl.audio].map((c) => c.src)
          )) {
            const cached = host.peekSource(slot);
            if (!cached) continue;
            const now = resolveSource(node, slot);
            if (!now || now.filename === cached.ref.filename) continue;
            editor.pool.forget(cached.ref);
            host.dropSource(slot);
            editor.requestRender();
          }
        };
        let lastAspect = null;
        let lastModel = null;
        const syncAspectWidgets = () => {
          var _a2, _b;
          if (v.audioOnly) return;
          const aspect = String(((_a2 = findW(node, "aspect_ratio")) == null ? void 0 : _a2.value) ?? ASPECT_CUSTOM);
          const model = String(((_b = findW(node, "model")) == null ? void 0 : _b.value) ?? "");
          if (aspect === lastAspect && model === lastModel) return;
          lastAspect = aspect;
          lastModel = model;
          const custom = aspect === ASPECT_CUSTOM;
          setWidgetVisible(node, "width", custom);
          setWidgetVisible(node, "height", custom);
          setWidgetVisible(node, "megapixels", !custom);
          setWidgetVisible(node, "size_multiple", !custom);
          setWidgetVisible(node, "quantize_n", model === QUANTIZE_CUSTOM);
          if (Array.isArray(node.widgets)) node.widgets = [...node.widgets];
          resizeToContent();
          editor.requestRender();
        };
        const tick = window.setInterval(() => {
          syncAspectWidgets();
          syncQuantumStep();
          detectSourceSwaps();
          editor.retightenToSources();
          editor.requestRender();
        }, 300);
        const origMenu = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function(canvas, options) {
          const r = origMenu == null ? void 0 : origMenu.apply(this, [canvas, options]);
          const w = findW(node, "frame_count");
          if (w && Number(w.value) > 0) {
            options.push({
              content: "Frame count: auto (to the end of the last clip)",
              callback: setAutoFrameCount
            });
          }
          return r;
        };
        const origRemoved = node.onRemoved;
        node.onRemoved = function(...args) {
          window.clearInterval(tick);
          ro.disconnect();
          widthKeeper.release();
          api.removeEventListener("nkd-timeline-meta", onMeta);
          editor.destroy();
          origRemoved == null ? void 0 : origRemoved.apply(this, args);
        };
        requestAnimationFrame(syncSlots);
        return result;
      };
    }
  });
}
registerTimelineNode({
  node: NODE_NAME,
  ext: EXT_NAME,
  flag: "__nkdTimelineWrapped",
  audioOnly: false
});
registerTimelineNode({
  node: AUDIO_NODE_NAME,
  ext: AUDIO_EXT_NAME,
  flag: "__nkdAudioTimelineWrapped",
  audioOnly: true
});
registerFreezeFrames();
registerVideoViewer();
registerTrackedWidgets();
registerProjectTopbar();
export {
  config,
  ensureStyles,
  loadConfig,
  mountDomWidget,
  projectChip,
  reveal,
  revealAvailable,
  revealButton,
  saveToProject
};
