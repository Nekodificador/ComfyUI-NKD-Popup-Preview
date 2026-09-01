/**
 * NKD Timeline - data model and frame maths.
 *
 * PURE module: no DOM, no ComfyUI, no canvas. Everything that can go wrong silently lives
 * here so `tests/timeline_model.mjs` can exercise it under plain node.
 *
 * ALGORITHM PARITY - `quantizeCount`, `quantizeStops` and `sourceFrame` must behave
 * EXACTLY like `quantize_count`, `quantize_stops` and `source_frame` in `nkd_timeline.py`,
 * and QUANTIZE_MODES must match its list string for string (the combo value is what gets
 * serialised and sent to the backend). Touch one, touch the other: a divergence here means
 * the editor's ruler lies about what the backend will render, which is the worst class of
 * bug this tool can have.
 */

export type Clip = {
  id: string;
  src: string;      // "video_0" - the Autogrow slot key
  track: number;    // higher track sits on top, and is drawn on a HIGHER row
  start: number;    // frame on the timeline
  trimIn: number;   // frame inside the source
  length: number;   // duration in timeline frames
  /** Silences this clip's own audio. Only meaningful where there is any. */
  muted?: boolean;
  /**
   * Picture off, sound on: the clip contributes its audio and NOTHING to the image, so its
   * span reads as a gap - a region to generate - while the sound plays straight through.
   *
   * This is what makes "cut out the middle and let the model refill it, keeping the audio"
   * work without a separate audio lane for it. Deleting the middle clip outright would take
   * its sound with it, and re-adding that sound would mean pointing an audio-lane clip at a
   * video slot, which costs a second full video decode just to reach the audio track.
   */
  audioOnly?: boolean;
  /**
   * Level for this clip's own sound, 0..2. Absent means 1 - the way it always behaved.
   *
   * A VIDEO clip carries audio too (the backend has always mixed it), so the level and the
   * fades below live on the base clip rather than only on the audio lane. That plus the
   * blade is what "mute this stretch and ease out of the cut" needs: split, then drop or
   * fade the piece.
   */
  gain?: number;
  /** Ramp from silence over this many TIMELINE frames from the clip's head. Anchored to
   *  the CLIP, so moving or blading it carries the ramp along. */
  fadeIn?: number;
  /** Ramp to silence over this many TIMELINE frames into the clip's tail. */
  fadeOut?: number;
  /**
   * Freeze-frame markers, as offsets from `start` in TIMELINE frames, sorted and unique.
   *
   * Anchored to the CLIP, not to the timeline: the point of a marker is "this exact frame
   * of this material", so moving the clip carries them along and the frozen picture does
   * not change. Trimming and slipping adjust them for the same reason - see
   * `shiftMarkers`/`pruneMarkers`.
   */
  markers?: number[];
};

export type AudioClip = {
  id: string;
  src: string;      // "audio_0"
  /** Lane to sit on. Always 0 in the video Timeline, which has one audio lane; the Audio
   *  Timeline stacks them so two beds can overlap for a crossfade. Unlike a video track
   *  this carries NO z-order - the mix is additive, so nothing covers anything. */
  track: number;
  start: number;
  trimIn: number;
  length: number;
  gain: number;
  muted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
};

/** `zoom` is how many times the content extent is magnified (1 = everything fits).
 *  `scroll` is the first visible frame. Both persist, so a workflow reopens where it was. */
export type TimelineUI = { zoom: number; scroll: number; playhead: number };

const int = (v: unknown, d = 0): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const MAX_ZOOM = 400;

/** Visible window, given the full content extent. Clamped so the view can never sit
 *  outside the content or magnify past MAX_ZOOM. */
export function viewWindow(ui: TimelineUI, contentFrames: number):
    { start: number; frames: number } {
  // Coerce through a finite check, NOT `ui.zoom || 1`: a non-numeric string is truthy, so
  // `||` lets it through and `Math.max(1, "x")` is NaN - which would then poison every
  // frame-to-pixel mapping in the editor.
  const zoom = Math.min(MAX_ZOOM, Math.max(1, num(ui.zoom, 1)));
  const content = Math.max(2, num(contentFrames, 2));
  const frames = Math.max(2, content / zoom);
  const start = Math.max(0, Math.min(num(ui.scroll, 0), content - frames));
  return { start, frames };
}

/**
 * How a track composites onto what is already under it.
 *
 * These four are exactly the ones a canvas can do natively via
 * `globalCompositeOperation`, so the preview shows the real result rather than an
 * approximation of it. `difference` is the one that earns its place: stack a before and an
 * after and anything non-black is what changed.
 */
export const BLEND_MODES = ["normal", "screen", "multiply", "difference"] as const;
export type BlendMode = typeof BLEND_MODES[number];

export type TrackState = { blend: BlendMode };

/** How a newly connected source lands on the timeline. */
export const IMPORT_MODES = ["stack", "append"] as const;
export type ImportMode = typeof IMPORT_MODES[number];

/** `masks` is the mask lane. Its clips may point at ANY slot - a real MASK, an image
 *  sequence or even a video - and whatever they point at is read as luminance. */
export type Timeline = {
  v: 1; clips: Clip[]; masks: Clip[]; audio: AudioClip[];
  /** Per video track, indexed by track number. Sparse: missing means normal. */
  tracks: TrackState[];
  ui: TimelineUI;
};

export const emptyTimeline = (): Timeline => ({
  v: 1, clips: [], masks: [], audio: [], tracks: [],
  ui: { zoom: 1, scroll: 0, playhead: 0 },
});

export function trackBlend(t: Timeline, track: number): BlendMode {
  return t.tracks[track]?.blend ?? "normal";
}

export function setTrackBlend(t: Timeline, track: number, blend: BlendMode): void {
  while (t.tracks.length <= track) t.tracks.push({ blend: "normal" });
  t.tracks[track].blend = blend;
}

let idCounter = 0;
/** Stable unique ids. LTX Director documents that a clip without an id breaks dragging
 *  after a reload; a counter is deterministic and cannot collide. */
export function newId(): string {
  idCounter += 1;
  return `c${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── Frame-count quantisation (parity with Python) ─────────────────────────────
// Video models only accept certain frame counts. Presets are named after the model
// families rather than the bare formula, because "which of these is Wan" is the actual
// question at the moment of choosing. Values come from ComfyUI core's EmptyLatent nodes.

export const QUANTIZE_FREE = "free";
export const QUANTIZE_CUSTOM = "custom (multiple of N)";

/** mode -> [step, offset]; a valid count is `offset + step*k`. */
export const QUANTIZE_PRESETS: Record<string, [number, number]> = {
  // Split per MODEL, not per grid: Wan and Hunyuan share 4n+1 but were trained at
  // different frame rates, so one grouped entry could not carry an honest expected fps.
  "Wan (4n+1)": [4, 1],
  "Hunyuan (4n+1)": [4, 1],
  "LTX (8n+1)": [8, 1],
  "Cosmos (8n+1)": [8, 1],
  "Mochi (6n+1)": [6, 1],
  // NOT an Nn+1 family: MiniMax H3 walks up until `n % 17 == 5`.
  "MiniMax H3 (17n+5)": [17, 5],
};

/**
 * Frame rate each family was trained at, ONLY where ComfyUI core states it outright:
 *   Wan        16  comfy_extras/nodes_wan.py:526 ("model trained with 16 fps")
 *   LTX        25  comfy_extras/nodes_lt.py:549 (LTXVConditioning frame_rate default)
 *   MiniMax H3 24  comfy_extras/nodes_minimax_h3.py:29 (FPS = 24)
 * Hunyuan, Cosmos and Mochi are absent on purpose: the repo documents no rate for them,
 * and a guess would produce a confident warning that might simply be wrong.
 */
export const QUANTIZE_NATIVE_FPS: Record<string, number> = {
  "Wan (4n+1)": 16,
  "LTX (8n+1)": 25,
  "MiniMax H3 (17n+5)": 24,
};

/** The rate this preset expects, or null when nobody documented one. */
export function nativeFpsFor(mode: QuantizeMode): number | null {
  return QUANTIZE_NATIVE_FPS[mode] ?? null;
}

/**
 * WHERE A CUT CAN LAND - a different grid from the frame COUNT above.
 *
 * A video VAE groups frames into latents and a latent is denoised whole, so a hole that
 * starts mid-group swallows the group. The count grid says how LONG the render may be;
 * this one says where inside it you may cut.
 *
 * `ratio` frames per latent · `chunk` frames after which the pattern restarts, 0 for
 * none · `audioMultiple` extra divisor once sound is masked too · `cutEvery` / `cutLead`
 * a family that only cuts where material resumes on a whole block, and how many frames
 * before that boundary still work.
 *
 * The values are read off the model, never chosen. Do not add a family by analogy and do
 * not widen a window: both are silent when wrong.
 */
export const TOKEN_GRIDS: Record<string, { ratio: number; chunk: number; audioMultiple?: number;
                                           cutEvery?: number; cutLead?: number }> = {
  "Wan (4n+1)": { ratio: 4, chunk: 0 },
  "Hunyuan (4n+1)": { ratio: 4, chunk: 0 },
  "LTX (8n+1)": { ratio: 8, chunk: 0 },
  "Cosmos (8n+1)": { ratio: 8, chunk: 0 },
  "Mochi (6n+1)": { ratio: 6, chunk: 0 },
  // H3 accepts a cut only where the preserved material RESUMES on a whole block.
  // `cutLead` is how many frames before that boundary are also valid. Do not widen it.
  "MiniMax H3 (17n+5)": { ratio: 4, chunk: 17, audioMultiple: 3, cutEvery: 17, cutLead: 3 },
};

/**
 * Every legal cut position in `[0, max]`, measured from the start of the render.
 *
 * `withAudio` adds the sound's own condition where the preset states one; it is the
 * caller's business whether this timeline actually carries audio, because a picture-only
 * edit should not be held to a grid three times coarser for nothing.
 */
export type CutEdge = "resume" | "end";

export function cutStops(max: number, mode: QuantizeMode, withAudio = false,
                         edge: CutEdge = "resume"): number[] {
  const grid = TOKEN_GRIDS[mode];
  if (!grid || max < 0) return [];
  const { ratio, chunk, audioMultiple, cutEvery, cutLead } = grid;
  if (ratio <= 0) return [];
  // A family whose material has to RESUME on a block boundary. The safe cut is a WINDOW,
  // not a point: anywhere in `[B - cutLead, B]` leaves at least one gap frame inside the
  // block's last token, so that token generates and nothing preserved is left stranded
  // among generated neighbours. All four land the material at B either way - the earliest
  // of them simply leaves real pixels under the regenerated token instead of black, which
  // a leaky masked patch can only benefit from.
  // The block rule applies only to the edge where material RESUMES. The edge where it
  // ENDS wants a plain token boundary, so the `max` does not claim frames it should keep.
  if (cutEvery && edge === "resume") {
    const lead = Math.max(0, cutLead ?? 0);
    const out: number[] = [0];
    for (let b = cutEvery; b <= max; b += cutEvery) {
      for (let f = Math.max(1, b - lead); f <= b; f++) out.push(f);
    }
    const every = withAudio ? (audioMultiple ?? 1) : 1;
    return every > 1 ? out.filter((f) => f % every === 0) : out;
  }
  const span = chunk > 0 ? chunk : max + 1;
  const out: number[] = [];
  for (let base = 0; base <= max; base += span) {
    out.push(base);                                     // the lone single-frame latent
    for (let f = base + 1; f <= max && f < base + span; f += ratio) out.push(f);
  }
  const every = withAudio ? (audioMultiple ?? 1) : 1;
  return every > 1 ? out.filter((f) => f % every === 0) : out;
}

/**
 * The canvas a model wants, ONLY where ComfyUI core states it outright.
 *
 * MiniMax H3 alone for now. Falling off its grid is not cosmetic: the model then re-scales
 * every frame itself, which is slow. Same honesty rule as QUANTIZE_NATIVE_FPS - a family
 * whose canvas the repo does not document stays out rather than being guessed.
 */
export const MODEL_CANVAS: Record<string, { multiple: number; shortEdge: number; maxPixels: number }> = {
  "MiniMax H3 (17n+5)": { multiple: 32, shortEdge: 768, maxPixels: 768 * 1344 },
};

export function canvasFor(mode: QuantizeMode) {
  return MODEL_CANVAS[mode] ?? null;
}

/**
 * The canvas the model would have picked for this shape - a port of `adapt_canvas`.
 *
 * The pixel cap is applied BEFORE the round to `multiple`, so the answer can land a hair
 * OVER the cap (2560x1210 -> 1472x704). That is the core's own order of operations, and
 * matching it is the whole point: tightening it here would recommend a size H3 does not
 * build, which is worse than the overshoot.
 */
export function adaptCanvas(width: number, height: number,
                            spec: { multiple: number; shortEdge: number; maxPixels: number },
                           ): [number, number] {
  const { multiple: m, shortEdge, maxPixels } = spec;
  const ratio = width / height;
  let [w, h] = ratio >= 1 ? [shortEdge * ratio, shortEdge] : [shortEdge, shortEdge / ratio];
  if (w * h > maxPixels) {
    const s = Math.sqrt(maxPixels / (w * h));
    w *= s;
    h *= s;
  }
  const snapAxis = (v: number) => Math.max(m, Math.round(v / m) * m);
  return [snapAxis(w), snapAxis(h)];
}

export const QUANTIZE_MODES = [
  QUANTIZE_FREE, ...Object.keys(QUANTIZE_PRESETS), QUANTIZE_CUSTOM,
];

export type QuantizeMode = string;

export function quantizeGrid(mode: QuantizeMode, k = 8): [number, number] | null {
  if (mode === QUANTIZE_CUSTOM) return [Math.max(1, int(k, 1)), 0];
  return QUANTIZE_PRESETS[mode] ?? null;
}

/**
 * Smallest useful valid count.
 *
 * `offset` alone is arithmetically valid, but for the Nn+1 families that means a single
 * frame, which is never what someone dragging a timeline meant. So the floor is one full
 * group up unless the offset already lands somewhere sensible:
 * 4n+1 -> 5, 8n+1 -> 9, 6n+1 -> 7, 17n+5 -> 5, multiple of N -> N.
 */
export function firstStop(step: number, offset: number): number {
  return offset > 1 ? offset : offset + step;
}

/** Round a frame count DOWN to the nearest valid stop, never below the first one. */
/**
 * Twin of `resolve_resolution` in nkd_timeline.py - same table, same formula, same order
 * as NKD Klein Presampling. Keep the two in step or the monitor previews an aspect the
 * backend will not render. There is a parity table in tests/timeline_model.mjs.
 */
export const ASPECT_CUSTOM = "Custom";
/** Keep the material's own shape, rescaled to the megapixel budget. Klein calls it "As
 *  Reference"; here the reference is the first clip, so the name says source. */
export const ASPECT_SOURCE = "As Source";
export const ASPECT_RATIOS: Record<string, [number, number] | null> = {
  [ASPECT_CUSTOM]: null,
  [ASPECT_SOURCE]: null,
  "1:1": [1, 1],
  "2:3 Vertical": [2, 3], "3:4 Vertical": [3, 4], "3:5 Vertical": [3, 5],
  "4:5 Vertical": [4, 5], "5:7 Vertical": [5, 7], "5:8 Vertical": [5, 8],
  "7:9 Vertical": [7, 9], "9:16 Vertical": [9, 16], "9:19 Vertical": [9, 19],
  "9:21 Vertical": [9, 21], "9:32 Vertical": [9, 32],
  "3:2 Horizontal": [3, 2], "4:3 Horizontal": [4, 3], "5:3 Horizontal": [5, 3],
  "5:4 Horizontal": [5, 4], "7:5 Horizontal": [7, 5], "8:5 Horizontal": [8, 5],
  "9:7 Horizontal": [9, 7], "16:9 Horizontal": [16, 9], "19:9 Horizontal": [19, 9],
  "21:9 Horizontal": [21, 9], "32:9 Horizontal": [32, 9],
};

/** Twin of `scale_to_megapixels`. Four aligned candidates, pick the closest in RATIO -
 *  rounding each axis alone drifts the aspect enough to squash the picture visibly. */
export function scaleToMegapixels(
  width: number, height: number, targetPixels: number, multiple: number,
): [number, number] {
  const m = Math.max(1, Math.round(multiple));
  if (!(width > 0) || !(height > 0)) return [m, m];
  const aspect = width / height;
  const hIdeal = Math.sqrt(targetPixels / aspect);
  const wIdeal = hIdeal * aspect;
  const snap = (v: number, up: boolean) =>
    Math.max(1, Math.trunc(v / m) + (up ? 1 : 0)) * m;
  let best: [number, number, number, number] | null = null;
  for (const wUp of [false, true]) {
    for (const hUp of [false, true]) {
      const cw = snap(wIdeal, wUp);
      const ch = snap(hIdeal, hUp);
      const cand: [number, number, number, number] = [
        Math.abs(cw / ch - aspect) / aspect,
        Math.abs(cw * ch - targetPixels) / Math.max(1, targetPixels), cw, ch];
      if (!best || cand[0] < best[0] || (cand[0] === best[0] && cand[1] < best[1])) {
        best = cand;
      }
    }
  }
  return [best![2], best![3]];
}

export function resolveResolution(
  aspect: string, megapixels: number, width: number, height: number, multiple: number,
  srcW = 0, srcH = 0,
): [number, number] {
  const mp = Number.isFinite(megapixels) && megapixels > 0 ? megapixels : 1;
  if (aspect === ASPECT_SOURCE) {
    return srcW > 0 && srcH > 0
      ? scaleToMegapixels(srcW, srcH, mp * 1048576, multiple)
      : [Math.round(width), Math.round(height)];
  }
  const parts = ASPECT_RATIOS[aspect];
  if (!parts) return [Math.round(width), Math.round(height)];
  const m = Math.max(1, Math.round(multiple));
  const up = (v: number) => Math.max(m, Math.ceil(Math.trunc(v) / m) * m);
  const target = mp * 1048576;
  const [w, h] = parts;
  return [up(Math.sqrt((target * w) / h)), up(Math.sqrt((target * h) / w))];
}

/**
 * Which way a family rounds an invalid count, taken from what the core actually
 * produces rather than from how the formula looks:
 *   Nn+1 families size the latent as `((length - 1) // step) + 1` (nodes_wan.py:44,
 *   nodes_lt.py, nodes_mochi.py) - a FLOOR, so asking for 20 decodes back to 17.
 *   MiniMax H3 is the odd one: `align_frame_count` walks UP until `n % 17 == 5`
 *   (nodes_minimax_h3.py:34), so asking for 20 gives 22.
 * Rounding the wrong way is silent: down where the model goes up throws material away,
 * and a timeline asked for 17 rendered 5 of a 40-frame clip.
 */
export const QUANTIZE_ROUND_UP = new Set(["MiniMax H3 (17n+5)"]);

export function quantizeCount(n: number, mode: QuantizeMode, k = 8): number {
  n = Math.max(0, int(n));
  const grid = quantizeGrid(mode, k);
  if (!grid || n === 0) return n;
  const [step, offset] = grid;
  const low = firstStop(step, offset);
  if (n <= low) return low;
  const groups = (n - offset) / step;
  return offset + (QUANTIZE_ROUND_UP.has(mode) ? Math.ceil(groups) : Math.floor(groups)) * step;
}

/** Every valid stop within [0, max] - what the editor paints on the ruler. */
export function quantizeStops(max: number, mode: QuantizeMode, k = 8): number[] {
  const grid = quantizeGrid(mode, k);
  if (!grid || max <= 0) return [];
  const [step, offset] = grid;
  const stops: number[] = [];
  for (let s = firstStop(step, offset); s <= max; s += step) stops.push(s);
  return stops;
}

// ── Freeze-frame markers ──────────────────────────────────────────────────────

/** Sorted, unique, inside `[0, length)`. The single gatekeeper: everything that touches
 *  markers goes through here, so no other code has to remember the invariant. */
// ── Level and fades ───────────────────────────────────────────────────────────

/** Anything with sound: the base `Clip` (a video carries its own audio) and `AudioClip`. */
type Fadeable = { length: number; gain?: number; fadeIn?: number; fadeOut?: number;
                  muted?: boolean };

/** Parse `fadeIn`/`fadeOut`/`gain` off raw JSON, dropping the ones that mean "default".
 *  Absent throughout means a workflow saved before fades existed loads bit-identically. */
function fadeFields(raw: any, length: number): Partial<Fadeable> {
  const g = num(raw?.gain, 1);
  const c: Fadeable = {
    length,
    fadeIn: Math.max(0, int(raw?.fadeIn)),
    fadeOut: Math.max(0, int(raw?.fadeOut)),
  };
  clampFades(c);
  return {
    ...(g !== 1 ? { gain: Math.max(0, Math.min(MAX_GAIN, g)) } : {}),
    ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
    ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}),
  };
}

/** Ceiling for a clip's level. +6 dB is as much lift as is honest before clipping. */
export const MAX_GAIN = 2;

/**
 * Keep the fades inside the clip after it changed length.
 *
 * Two ramps longer than the clip would overlap and the level would dip in the middle of a
 * stretch the user never touched, so they are scaled down together rather than clipped
 * independently - that preserves the SHAPE the user drew.
 */
export function clampFades(c: Fadeable): void {
  const len = Math.max(0, c.length);
  let fi = Math.max(0, Math.round(c.fadeIn ?? 0));
  let fo = Math.max(0, Math.round(c.fadeOut ?? 0));
  // NOT clamped to `len` one at a time first: doing that flattens a 3:1 shape to 1:1
  // before the joint scale ever sees it.
  if (fi + fo > len) {
    const k = fi + fo ? len / (fi + fo) : 0;
    fi = Math.floor(fi * k);
    fo = Math.floor(fo * k);
  }
  if (fi > 0) c.fadeIn = fi; else delete c.fadeIn;
  if (fo > 0) c.fadeOut = fo; else delete c.fadeOut;
}

/**
 * The clip's level `offset` TIMELINE frames after its head.
 *
 * MIRRORED IN `nkd_timeline.py` (`clip_gain_ramp`). The preview and the render have to
 * agree on the shape or a fade that sounds right while scrubbing lands differently in the
 * file. Linear, because that is what the handle drawn on the clip depicts.
 */
export function gainAt(c: Fadeable, offset: number): number {
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

/** Detent spacing for the volume line under Shift. 3 dB is the step a mixer is marked in,
 *  and it is the smallest move most people can hear on one pass. */
export const GAIN_DB_STEP = 3;
/** Below this the detents stop and the next one down is silence. Snapping in dB never
 *  reaches zero on its own - the scale is logarithmic, so it would step towards -inf
 *  forever and the drag could never be pulled to a true mute. */
const GAIN_DB_FLOOR = -30;

/**
 * The nearest 3 dB detent to `g`, for a Shift-drag on the volume line.
 *
 * In dB rather than in amplitude, because that is the scale the ear and every fader use:
 * even steps of amplitude would be crowded at the top and useless at the bottom.
 */
export function snapGainToDb(g: number): number {
  if (g <= 0) return 0;
  const db = 20 * Math.log10(g);
  if (db < GAIN_DB_FLOOR - GAIN_DB_STEP / 2) return 0;
  const snapped = Math.round(db / GAIN_DB_STEP) * GAIN_DB_STEP;
  return Math.min(MAX_GAIN, 10 ** (snapped / 20));
}

/**
 * The clip's level as a polyline of `[offsetFrames, level]`, in order.
 *
 * The curve is linear between its breakpoints, so these few points describe it EXACTLY at
 * any zoom - no sampling, no resolution to get wrong.
 *
 * It lives here, next to `gainAt` and away from the canvas, because the direction of these
 * ramps is the thing this editor has already got backwards once: the first version drew
 * the ATTENUATION, so a fade in sloped downwards. A pure function can be asserted; a shape
 * buried in a paint call can only be looked at.
 *
 * The last point stops a hair INSIDE the clip: `gainAt` reports silence for an offset that
 * is already past the end, so asking at exactly `length` would end every polyline with a
 * cliff to the floor.
 */
export function levelStops(c: Fadeable): [number, number][] {
  const len = Math.max(0, c.length);
  const eps = Math.min(1e-6, len);
  const offs = [0, c.fadeIn ?? 0, len - (c.fadeOut ?? 0), len - eps]
    .map((o) => Math.max(0, Math.min(len - eps, o)));
  return [...new Set(offs)].sort((a, b) => a - b).map((o) => [o, gainAt(c, o)]);
}

function cleanMarkers(raw: unknown, length: number): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const m of raw) {
    const v = int(m, -1);
    if (v >= 0 && v < length) seen.add(v);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Drop markers that a trim or a source change pushed outside the clip. */
export function pruneMarkers(clip: Clip): void {
  if (!clip.markers) return;
  const kept = cleanMarkers(clip.markers, clip.length);
  if (kept.length) clip.markers = kept;
  else delete clip.markers;
}

/** Slide markers by `delta` clip-local frames, then prune. Used wherever the content
 *  moves under a fixed clip window (head trim, slip) so a marker keeps pointing at the
 *  picture it was put on rather than at a position. */
export function shiftMarkers(clip: Clip, delta: number): void {
  if (!clip.markers || !delta) return;
  clip.markers = clip.markers.map((m) => m - Math.round(delta));
  pruneMarkers(clip);
}

/** Add or remove a marker at absolute timeline frame `f`. False if `f` is off the clip. */
export function toggleMarker(clip: Clip, f: number): boolean {
  const off = Math.round(f) - clip.start;
  if (off < 0 || off >= clip.length) return false;
  const next = (clip.markers ?? []).filter((m) => m !== off);
  if (next.length === (clip.markers?.length ?? 0)) next.push(off);
  clip.markers = next.sort((a, b) => a - b);
  if (!clip.markers.length) delete clip.markers;
  return true;
}

/**
 * Every marker as an ABSOLUTE timeline frame, sorted and deduplicated.
 *
 * Across every lane: a clip reinterpreted as a mask keeps the markers it was given, and
 * two stacked clips marked at the same instant are one output frame, not two.
 */
export function markerFrames(t: Timeline): number[] {
  const out = new Set<number>();
  for (const lane of allLanes(t)) {
    for (const c of lane) for (const m of c.markers ?? []) out.add(c.start + m);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * First and last frame of every picture clip, as ABSOLUTE timeline frames, clip by clip
 * in (start, track) order. Mirror of `clip_bound_indices` in nkd_timeline.py - NOT
 * deduplicated, because each bound is its own Freeze Frames socket. `audioOnly` clips
 * contribute no picture, so they contribute no bounds either.
 */
export function clipBoundFrames(t: Timeline): number[] {
  const out: number[] = [];
  const clips = [...t.clips].sort((a, b) => a.start - b.start || a.track - b.track);
  for (const c of clips) {
    if (c.audioOnly) continue;
    out.push(c.start, c.start + c.length - 1);
  }
  return out;
}

// ── Defensive parsing ─────────────────────────────────────────────────────────

function parseClipList(raw: any): Clip[] {
  const out: Clip[] = [];
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
      ...(c.muted ? { muted: true } : {}),
      ...(c.audioOnly ? { audioOnly: true } : {}),
      ...fadeFields(c, length),
      ...(markers.length ? { markers } : {}),
    });
  }
  return out;
}

/** Never throws. Corrupt JSON degrades to an empty timeline, same as in Python. */
export function parseTimeline(raw: string | null | undefined): Timeline {
  const out = emptyTimeline();
  if (!raw || typeof raw !== "string") return out;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object") return out;

  out.clips = parseClipList(data.clips);
  out.masks = parseClipList(data.masks);
  if (Array.isArray(data.tracks)) {
    out.tracks = data.tracks.map((t: any) => ({
      blend: (BLEND_MODES as readonly string[]).includes(t?.blend)
        ? (t.blend as BlendMode) : "normal",
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
        gain: num(a.gain, 1),
        ...(a.muted ? { muted: true } : {}),
        ...fadeFields(a, length),
      });
    }
  }
  if (data.ui && typeof data.ui === "object") {
    out.ui.zoom = Math.min(MAX_ZOOM, Math.max(1, num(data.ui.zoom, 1)));
    out.ui.scroll = Math.max(0, num(data.ui.scroll, 0));
    out.ui.playhead = Math.max(0, int(data.ui.playhead));
  }
  sortClips(out);
  return out;
}

/** Writes ONLY the persistent fields. Everything transient the editor hangs off a clip
 *  (video elements, thumbnails, blob URLs) lives outside the model precisely so nobody
 *  has to remember to strip it here. */
export function serialiseTimeline(t: Timeline): string {
  const plain = (c: Clip) => ({
    id: c.id, src: c.src, track: c.track,
    start: c.start, trimIn: c.trimIn, length: c.length,
    ...(c.muted ? { muted: true } : {}),   // omitted when false: keeps the JSON small
    ...(c.audioOnly ? { audioOnly: true } : {}),
    ...(c.gain !== undefined && c.gain !== 1 ? { gain: c.gain } : {}),
    ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
    ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}),
    ...(c.markers?.length ? { markers: c.markers } : {}),
  });
  return JSON.stringify({
    v: 1,
    clips: t.clips.map(plain),
    masks: t.masks.map(plain),
    tracks: t.tracks.map((x) => ({ blend: x.blend })),
    audio: t.audio.map((a) => ({
      id: a.id, src: a.src, start: a.start,
      trimIn: a.trimIn, length: a.length, gain: a.gain,
      ...(a.track ? { track: a.track } : {}),
      ...(a.muted ? { muted: true } : {}),
      ...(a.fadeIn ? { fadeIn: a.fadeIn } : {}),
      ...(a.fadeOut ? { fadeOut: a.fadeOut } : {}),
    })),
    // ZOOM, SCROLL AND PLAYHEAD ARE DELIBERATELY ABSENT. This string is a node INPUT,
    // and a widget value goes verbatim into ComfyUI's cache signature
    // (comfy_execution/caching.py:126), so anything written here invalidates the render.
    // The playhead only drives `current_frame` / `current_image` — scrubbing through the
    // preview should never re-render the entire graph. All three live in
    // `node.properties` instead, which persists with the workflow but is not an input.
    ui: {},
  });
}

/** The view state kept OUT of the widget, for the host to park in `node.properties`. */
export function viewState(t: Timeline): { zoom: number; scroll: number; playhead: number } {
  return { zoom: t.ui.zoom, scroll: t.ui.scroll, playhead: t.ui.playhead };
}

export function sortClips(t: Timeline): void {
  const byTrack = (a: Clip, b: Clip) => a.track - b.track || a.start - b.start;
  t.clips.sort(byTrack);
  t.masks.sort(byTrack);
  t.audio.sort((a, b) => a.start - b.start);
}

/**
 * Is this Autogrow slot already placed ANYWHERE on the timeline?
 *
 * Must span every lane, not just the one being filled. A clip reinterpreted as a mask
 * leaves the picture lane, and a per-lane check would then decide the slot was unplaced
 * and add it back as a video - so the same source ends up in both lanes on the next
 * refresh, and the reinterpretation silently undoes itself.
 */
export function slotInUse(t: Timeline, src: string): boolean {
  return allLanes(t).some((lane) => lane.some((c) => c.src === src));
}

/** Every lane, for the operations that do not care which is which. */
export function allLanes(t: Timeline): Clip[][] {
  return [t.clips, t.masks, t.audio as unknown as Clip[]];
}

// ── Frame maths ───────────────────────────────────────────────────────────────

/**
 * Source frame corresponding to timeline frame `f`.
 * With mismatched frame rates this IS the resampling: 30 -> 24 drops, 24 -> 30 repeats.
 */
export function sourceFrame(clip: Clip, f: number, srcFps: number, fps: number): number {
  if (!(fps > 0)) return clip.trimIn;
  return clip.trimIn + Math.round((f - clip.start) * (srcFps / fps));
}

/** Last frame occupied by any track. */
export function timelineSpan(t: Timeline): number {
  let end = 0;
  for (const lane of allLanes(t)) {
    for (const c of lane) end = Math.max(end, c.start + c.length);
  }
  return end;
}

/** First frame covered by any picture lane, and the last. Used by "trim to material",
 *  which crops the output range to what actually exists instead of leaving gaps that
 *  turn into mask. Returns null when there is nothing at all. */
export function materialRange(t: Timeline): { start: number; end: number } | null {
  let start = Infinity;
  let end = 0;
  for (const lane of [t.clips, t.masks]) {
    for (const c of lane) {
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
    }
  }
  return end > 0 && Number.isFinite(start) ? { start, end } : null;
}

/** Clips covering `frame`, topmost first - the one you actually see. */
export function clipsAt(t: Timeline, frame: number): Clip[] {
  return t.clips
    .filter((c) => frame >= c.start && frame < c.start + c.length)
    .sort((a, b) => b.track - a.track);
}

/** The count the backend will actually produce, given the editor's current state. */
export function effectiveCount(
  t: Timeline, startFrame: number, frameCount: number,
  mode: QuantizeMode, k = 8,
): number {
  const raw = frameCount > 0 ? frameCount : Math.max(0, timelineSpan(t) - startFrame);
  return quantizeCount(raw, mode, k);
}

// ── Snapping ──────────────────────────────────────────────────────────────────

/** Nearest candidate within `threshold`, or `value` if none is close enough.
 *  LTX Director duplicates this logic three times; here it is one function. */
export function snap(value: number, candidates: number[], threshold: number): number {
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

/** Every clip edge plus the origin and the playhead: the natural magnets of an edit. */
export function snapCandidates(t: Timeline, extra: number[] = []): number[] {
  const out = [0, t.ui.playhead, ...extra];
  for (const lane of allLanes(t)) {
    for (const c of lane) out.push(c.start, c.start + c.length);
  }
  return out;
}

/**
 * Snap an absolute frame onto the model's quantisation grid, measured FROM `startFrame`.
 *
 * These are the only places a cut can land and still leave the model a frame count it
 * accepts, so holding the modifier while scrubbing lands the playhead exactly on a legal
 * block boundary.
 */
export function snapFrameToGrid(frame: number, startFrame: number,
                                 mode: QuantizeMode, k = 8, withAudio = false,
                                 edge: CutEdge = "resume"): number {
  // The TOKEN grid, not the count grid: a cut lands where a latent begins. Falling back
  // to the count grid for `custom (multiple of N)` and anything without a documented
  // token pattern - there the block size is all we know, and it is better than nothing.
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

// ── Editing ───────────────────────────────────────────────────────────────────

/** Move a clip, without letting it fall off the left edge. */
export function moveClip(clip: Clip, start: number, track: number): void {
  clip.start = Math.max(0, Math.round(start));
  clip.track = Math.max(0, Math.round(track));
}

/** Trim the left edge: moves `start` and `trimIn` together so the content does not slide
 *  under the cut. Respects how much source material lies before it. */
export function trimStart(clip: Clip, newStart: number, srcFps: number, fps: number): void {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const end = clip.start + clip.length;
  const minStart = clip.start - Math.floor(clip.trimIn / (ratio || 1));
  const s = Math.max(0, Math.max(minStart, Math.min(Math.round(newStart), end - 1)));
  const delta = s - clip.start;
  clip.trimIn = Math.max(0, clip.trimIn + Math.round(delta * ratio));
  clip.start = s;
  clip.length = end - s;
  clampFades(clip);
  // The clip's origin moved but its content did not, so every marker is now `delta`
  // frames closer to the head. Without this a head trim would silently slide the freeze
  // frames onto different pictures.
  shiftMarkers(clip, delta);
}

/** Trim the right edge: only the duration changes. */
export function trimEnd(clip: Clip, newEnd: number, srcFrames: number,
                        srcFps: number, fps: number): void {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const maxLen = srcFrames > 0
    ? Math.max(1, Math.floor((srcFrames - clip.trimIn) / (ratio || 1)))
    : Number.MAX_SAFE_INTEGER;
  clip.length = Math.max(1, Math.min(Math.round(newEnd) - clip.start, maxLen));
  clampFades(clip);
  pruneMarkers(clip);   // whatever fell off the tail is gone with it
}

/**
 * Roll edit: move the junction between two butted clips, trimming one and extending the
 * other in the same gesture.
 *
 * The standard NLE gesture, and without it moving a cut is three operations - shove one
 * clip aside to expose the other's handle, trim it, then butt them back together - each of
 * which can leave a one-frame gap that renders as a whole regenerated token.
 *
 * The clamping is the whole job, and it is NOT the two trims' own clamps: applying them
 * independently lets one give way while the other does not, which opens exactly the gap
 * this exists to avoid. So the reachable frame is resolved FIRST, against both limits, and
 * both edges are then moved to it.
 */
export function rollEdit(left: Clip, right: Clip, frame: number, fps: number,
                         srcFramesFor: (c: Clip) => number | null,
                         rateFor: (c: Clip) => number): boolean {
  const lRate = rateFor(left) || fps;
  const rRate = rateFor(right) || fps;
  const lRatio = fps > 0 ? lRate / fps : 1;
  const rRatio = fps > 0 ? rRate / fps : 1;
  const lSrc = srcFramesFor(left);
  // How far right the junction may go: the left clip must not outrun its own material,
  // and the right one must keep at least a frame.
  const lMax = lSrc && lSrc > 0
    ? left.start + Math.max(1, Math.floor((lSrc - left.trimIn) / (lRatio || 1)))
    : Number.MAX_SAFE_INTEGER;
  const hi = Math.min(right.start + right.length - 1, lMax);
  // ...and how far left: the right clip can only reach back through the material its
  // trimIn already skipped.
  const lo = Math.max(left.start + 1, right.start - Math.floor(right.trimIn / (rRatio || 1)));
  const f = Math.max(lo, Math.min(Math.round(frame), hi));
  if (f === right.start || hi < lo) return false;
  trimEnd(left, f, 0, lRate, fps);     // 0: the cap was already applied above
  trimStart(right, f, rRate, fps);
  return true;
}

/**
 * Blade: cut a clip in two at a timeline frame. Returns the new right-hand clip, or null
 * when the frame is not strictly inside it (cutting at an edge is a no-op, not an error).
 *
 * The right half has to advance its `trimIn` by the frames the left half consumed, IN
 * SOURCE CADENCE - a 30 fps source cut 24 timeline frames in has moved 30 source frames -
 * or the second half plays from the wrong place.
 *
 * Markers are offsets from `start`, so they are partitioned: the ones past the cut move to
 * the new clip rebased to ITS origin. Leaving them all on the left half would point them at
 * pictures that half no longer contains.
 */
export function splitClip(clip: Clip, frame: number, srcFps: number, fps: number): Clip | null {
  const at = Math.round(frame);
  if (!(at > clip.start && at < clip.start + clip.length)) return null;
  const ratio = fps > 0 ? srcFps / fps : 1;
  const leftLen = at - clip.start;
  const right: Clip = {
    ...clip,
    id: newId(),
    start: at,
    length: clip.length - leftLen,
    trimIn: Math.max(0, clip.trimIn + Math.round(leftLen * ratio)),
  };
  const marks = clip.markers ?? [];
  const rightMarks = marks.filter((m) => m >= leftLen).map((m) => m - leftLen);
  clip.length = leftLen;
  // Each half keeps the ramp on the side it still has, shrunk to fit. Blading in the
  // middle of a fade-out and leaving both halves fading out is the alternative.
  clampFades(clip);
  clampFades(right);
  clip.markers = cleanMarkers(marks, clip.length);
  if (!clip.markers.length) delete clip.markers;
  right.markers = cleanMarkers(rightMarks, right.length);
  if (!right.markers.length) delete right.markers;
  return right;
}

/** Slip: move the content INSIDE the clip without touching position or duration.
 *  "Same slot, different part of the source" - constant use in video-to-video. */
export function slipClip(clip: Clip, deltaFrames: number, srcFrames: number,
                          srcFps: number, fps: number): void {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const used = Math.ceil(clip.length * ratio);
  const maxTrim = srcFrames > 0 ? Math.max(0, srcFrames - used) : Number.MAX_SAFE_INTEGER;
  const before = clip.trimIn;
  clip.trimIn = Math.max(0, Math.min(maxTrim, clip.trimIn + Math.round(deltaFrames * ratio)));
  // Content slid under a stationary window, so a content-anchored marker slides with it -
  // by the trim actually APPLIED, which the clamps above may have cut short.
  shiftMarkers(clip, (clip.trimIn - before) / (ratio || 1));
}

/**
 * Reinterpret a clip as a mask, or back again.
 *
 * A black-and-white video IS a mask most of the time - it just arrived through a video
 * input. Rather than force a conversion node upstream, the clip moves to the mask lane and
 * the backend reads whatever it points at as luminance.
 */
export function moveClipToLane(t: Timeline, clip: Clip, toMask: boolean): void {
  const from = toMask ? t.clips : t.masks;
  const to = toMask ? t.masks : t.clips;
  const i = from.indexOf(clip);
  if (i < 0) return;
  from.splice(i, 1);
  clip.track = 0;
  to.push(clip);
  sortClips(t);
}

/**
 * Discard everything outside [start, end): clips wholly outside are dropped, clips that
 * straddle an edge are cut back to it.
 *
 * The inverse of `materialRange` + trim-to-material: that one moves the RANGE to fit the
 * material, this one cuts the MATERIAL to fit the range. Frame numbering is deliberately
 * left alone - rebasing to zero would have to rewrite `start_frame`, which can be driven
 * by a link from another node, and the rendered output is identical either way.
 *
 * `rateFor` gives each source native rate: a video clip counts `trimIn` in SOURCE frames,
 * so cutting its head has to advance the trim at that cadence, while audio and tensor
 * clips run at the timeline rate.
 *
 * Returns true if anything changed.
 */
export function cropToRange(t: Timeline, start: number, end: number, fps: number,
                            rateFor: (c: Clip) => number): boolean {
  let changed = false;
  for (const lane of allLanes(t)) {
    const kept: Clip[] = [];
    for (const c of lane) {
      if (c.start + c.length <= start || c.start >= end) {
        changed = true;                      // entirely outside: gone
        continue;
      }
      const rate = rateFor(c) || fps;
      if (c.start + c.length > end) {
        trimEnd(c, end, 0, rate, fps);       // 0 = no source cap; we only ever shorten
        changed = true;
      }
      if (c.start < start) {
        trimStart(c, start, rate, fps);
        changed = true;
      }
      kept.push(c);
    }
    if (kept.length !== lane.length) {
      lane.length = 0;
      lane.push(...kept);
    }
  }
  return changed;
}

/**
 * Pull one edge of a clip up to the playhead - Premiere's trim-to-playhead.
 *
 * The point is not having to find a three-minute clip's edge and drag it all the way
 * back: park the playhead where the cut belongs and the edge comes to you.
 *
 * The playhead must be strictly INSIDE a clip for it to be affected, so this only ever
 * shortens. `only` restricts it to a selection; without it every clip under the playhead
 * in every lane is trimmed, which is what makes it fast when you just want the cut.
 *
 * Returns true if anything changed.
 */
export function trimToPlayhead(t: Timeline, frame: number, side: "start" | "end",
                               fps: number, rateFor: (c: Clip) => number,
                               only?: Set<string>): boolean {
  let changed = false;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      if (only && !only.has(c.id)) continue;
      if (frame <= c.start || frame >= c.start + c.length) continue;
      const rate = rateFor(c) || fps;
      if (side === "start") trimStart(c, frame, rate, fps);
      else trimEnd(c, frame, 0, rate, fps);   // 0 = no source cap; only ever shortens
      changed = true;
    }
  }
  return changed;
}

/**
 * Pull clips back inside the material they point at.
 *
 * A source can change under a clip - swap the file in a Load Audio and the old three
 * minutes may become ten seconds - and a clip left longer than its source would just read
 * its last frame on repeat. Only ever SHORTENS: a source that got longer must not silently
 * undo a trim the user made on purpose.
 *
 * `srcFramesFor` returns the source length in SOURCE frames (null when unknown), and
 * `rateFor` its native rate, because a clip's `trimIn` counts source frames while its
 * `length` counts timeline frames.
 *
 * Returns true if anything changed.
 */
export function clampClipsToSources(t: Timeline, fps: number,
                                    srcFramesFor: (c: Clip) => number | null,
                                    rateFor: (c: Clip) => number): boolean {
  let changed = false;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      const srcFrames = srcFramesFor(c);
      if (srcFrames === null || srcFrames <= 0) continue;
      const ratio = (rateFor(c) || fps) / (fps || 1);
      if (c.trimIn >= srcFrames) {        // the trim itself is now past the end
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

/**
 * The inverse of `clampClipsToSources`: open clips out to the whole of their source.
 *
 * A clip lands at a GUESSED length whenever its real one could not be known when it was
 * placed - a tensor from another node, an IMAGE out of VHS's loader. The true figure only
 * arrives with the execute-time push, and by then hunting the right edge of every clip
 * across a long timeline is busywork. This drops the trim and takes each clip to its full
 * extent in one go, on the understanding that the cuts get made afterwards.
 *
 * `ids` limits it to a selection. That is not a nicety: without it, opening a picture clip
 * to its real length also unrolls a three-minute music bed sitting on the audio lane, and
 * the view zooms out to fit something nobody asked about. (Neko.)
 *
 * `start` is left alone either way: where a clip sits is a decision the user made, and the
 * ask is to see all of the material, not to re-stack the timeline.
 */
export function expandClipsToSources(t: Timeline, fps: number,
                                     srcFramesFor: (c: Clip) => number | null,
                                     rateFor: (c: Clip) => number,
                                     ids?: Set<string>): boolean {
  let changed = false;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      if (ids && !ids.has(c.id)) continue;
      const srcFrames = srcFramesFor(c);
      if (srcFrames === null || srcFrames <= 0) continue;
      const ratio = (rateFor(c) || fps) / (fps || 1);
      const full = Math.max(1, Math.floor(srcFrames / (ratio || 1)));
      if (c.trimIn === 0 && c.length === full) continue;
      // Markers are offsets from `start` and the clip only grows here, so they stay put -
      // except where a dropped trim slides the picture under them.
      if (c.trimIn !== 0) c.markers = [];
      c.trimIn = 0;
      c.length = full;
      changed = true;
    }
  }
  return changed;
}

/**
 * Extent of a set of clips - Resolve's "mark clip" needs exactly this.
 *
 * With `ids` it spans the selection; without, everything covering `frame` in every lane.
 * The union rather than one clip, so marking a picture+sound pair that was cut together
 * gives their shared extent instead of whichever happened to be found first.
 *
 * Returns null when there is nothing to mark.
 */
export function clipExtent(t: Timeline, frame: number, ids?: Set<string>):
    { start: number; end: number } | null {
  let start = Infinity;
  let end = 0;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      const hit = ids
        ? ids.has(c.id)
        : frame >= c.start && frame < c.start + c.length;
      if (!hit) continue;
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
    }
  }
  return end > 0 && Number.isFinite(start) ? { start, end } : null;
}

/** Where a newly connected source should land. `stack` puts each one on its own track
 *  from frame 0, which is what you want when the timeline is being used to compare two
 *  versions rather than to assemble a sequence. */
export function placementFor(t: Timeline, lane: Clip[], mode: ImportMode):
    { start: number; track: number } {
  if (mode === "stack") {
    const track = lane.reduce((m, c) => Math.max(m, c.track + 1), 0);
    return { start: 0, track };
  }
  const start = lane.filter((c) => c.track === 0)
    .reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return { start, track: 0 };
}

// ── Fit (parity with `fit_frames` in Python) ──────────────────────────────────

export type FitMode = "contain" | "cover" | "stretch";

/** Destination rect for drawing a `sw x sh` source into a `dw x dh` output.
 *  The editor's preview uses this so what you scrub is what gets rendered. */
export function fitRect(sw: number, sh: number, dw: number, dh: number, mode: FitMode):
    { x: number; y: number; w: number; h: number } {
  if (sw <= 0 || sh <= 0) return { x: 0, y: 0, w: dw, h: dh };
  if (mode === "stretch") return { x: 0, y: 0, w: dw, h: dh };
  const scale = mode === "cover"
    ? Math.max(dw / sw, dh / sh)   // fill the frame, overflow is cropped
    : Math.min(dw / sw, dh / sh);  // contain: fit whole, remainder is black
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}
