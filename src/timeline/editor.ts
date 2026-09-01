/**
 * NKD Timeline - the canvas editor.
 *
 * Everything is painted into one 2D canvas (ruler + tracks + playhead) and interaction is
 * resolved by hit-testing. The editor knows nothing about ComfyUI: it talks to the node
 * through `TimelineHost`, which is what lets the same component mount both in the node and
 * in a modal later.
 *
 * SIZING - the timeline canvas gets an EXPLICIT CSS height in px. A canvas with no CSS
 * height falls back to its `height` attribute as intrinsic size, so reading `clientHeight`
 * to compute the backing store makes the two chase each other and the canvas grows without
 * bound on every frame. The preview canvas is the other case: its height is driven by
 * `aspect-ratio`, the pattern proven in NKD Sigmas.
 */
import {
  type Clip, type FitMode, type QuantizeMode, type Timeline,
  QUANTIZE_FREE,
  BLEND_MODES, type BlendMode, type ImportMode,
  clampFades, levelStops, snapGainToDb, clipsAt, cropToRange, effectiveCount, fitRect, materialRange, moveClip,
  moveClipToLane, MAX_GAIN,
  type CutEdge,
  adaptCanvas, canvasFor, clampClipsToSources, clipExtent, cutStops, expandClipsToSources,
  nativeFpsFor, newId, rollEdit, slotInUse, splitClip,
  trimToPlayhead,
  placementFor, quantizeStops, setTrackBlend, slipClip, snap, snapCandidates,
  GAIN_DB_STEP, MAX_ZOOM, snapFrameToGrid, sortClips, sourceFrame, timelineSpan, trackBlend, trimEnd,
  trimStart, viewWindow, markerFrames, toggleMarker,
} from "./model";
import {
  type MediaInfo, type MediaRef,
  VideoPool, audioBufferFor, ensureAudio, ensureThumbnails, peaksFor, thumbnailAt,
} from "./media";
import { drawWave, type WaveColors } from "./waveform";
import { Transport } from "./player";

/** Peak outline, RMS body, zero line. The body is the brighter of the two on purpose: it
 *  is the part that reads as loudness, and the outline is the part that reads as risk. */
const WAVE_COLORS: WaveColors = {
  peak: "rgba(120,190,235,0.65)",
  body: "rgba(165,225,255,0.95)",
  zero: "rgba(255,255,255,0.22)",
};

export interface TimelineHost {
  getTimeline(): Timeline;
  /** Persist the JSON into the hidden widget and mark the node dirty. */
  commit(): void;
  getFps(): number;
  getStartFrame(): number;
  setStartFrame(v: number): void;
  getFrameCount(): number;
  setFrameCount(v: number): void;
  /** True when start_frame arrives through a LINK: then it cannot be rewritten, and the
   *  crop keeps the original numbering instead of rebasing to 0. */
  isStartFrameLinked(): boolean;
  getQuantize(): QuantizeMode;
  getQuantizeN(): number;
  getOutSize(): [number, number];
  getFit(): FitMode;
  /** Record for the material wired into an Autogrow slot ("video_0"), if resolvable. */
  sourceFor(src: string): { ref: MediaRef; info: MediaInfo | null; label: string } | null;
  /** Autogrow slots that have something connected, by kind. */
  connectedSlots(): {
    videos: string[]; images: string[]; masks: string[]; audios: string[];
  };
  /** Copy fps / width / height into the node's widgets, from `from` when given (used for
   *  the automatic conform on the first connection) or from the first clip otherwise. */
  conformToFirstClip(from?: MediaInfo): void;
  /** Where newly connected sources land. */
  getImportMode(): ImportMode;
  /** User-rebindable key for an action, lower-case. */
  getKey(action: KeyAction, fallback: string): string;
  /** Surface a message in ComfyUI's own toast area. */
  notify(summary: string, detail: string, severity?: "info" | "warn"): void;
  /** Persist zoom/scroll/playhead to node.properties without touching the widget. */
  saveView(): void;
  /** Called on a manual scrub — the playhead moved but no edit happened. */
  onSeek(): void;
  /** Drop every cached view of the connected media and re-resolve from scratch. */
  reloadSources(): void;
  /** Source length in SOURCE frames, or null while unknown. */
  srcFramesFor(src: string): number | null;
  /** Length of a source's DECODED SOUND in timeline frames, or null until it lands. What
   *  bounds a clip on the audio lane - a video's frame count does not. */
  audioFramesFor(src: string): number | null;
}

// NKD palette for the chrome (see the nkd-node skill); the clips themselves follow the
// NLE convention instead - flat blue blocks, no gradients, which is what an editor's eye
// reads as "a clip" and what keeps a dense timeline legible.
const C = {
  bg: "#16181d",
  trackBg: "#1b1e24",
  trackAlt: "#191c21",
  bar: "#1a1c22",
  border: "#3a3d46",
  gridLine: "#0f1114",
  accent: "#4ab4ff",
  text: "#c8d0e0",
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
  gap: "rgba(255,209,102,0.07)",
} as const;

const RULER_H = 27;
const IO_BAR_H = 7;                       // in/out bar at the bottom of the ruler
const IO_BAR_TOP = RULER_H - IO_BAR_H;
const IO_GRAB_PX = 7;
const CLIP_HEAD_H = 15;                   // name band inside a clip
/**
 * Grab radius of an edge. Raised from 10 once the hit-test started giving the pixel to
 * the NEAREST edge rather than to whichever clip the draw order reached first: while the
 * winner was decided by order, a wider radius only widened the strip the right-hand clip
 * stole. Now the two neighbours split it at the midpoint, so wider is simply easier.
 */
const HANDLE_PX = 16;
/**
 * Grab radius of the JUNCTION, and deliberately much smaller than HANDLE_PX.
 *
 * The roll is tested before the individual edges, so it takes whatever it claims: sharing
 * HANDLE_PX with them meant that once the handles grew, the junction swallowed the lot and
 * trimming ONE side of a cut became impossible. A narrow core is also the convention -
 * roll sits on the cut, and a few pixels either side is the trim of that side.
 *
 * The result is three distinct targets across 32px instead of one: 12 for the roll, and
 * 10 clear pixels of single-edge trim on each side of it.
 */
const ROLL_PX = 6;
const MUTE_BOX = 16;                      // the speaker glyph itself
const MUTE_PAD = 5;                       // breathing room in its plate
/**
 * Keep-out margin between the speaker and either clip edge.
 *
 * The speaker rides the middle of the clip now, so this only bites on a narrow one - where
 * it decides whether the icon appears at all rather than crowd the handles. Comfortably
 * clear of HANDLE_PX rather than merely equal to it: a control that only just misses the
 * grab zone still feels like fighting for the pixel.
 */
const MUTE_INSET = HANDLE_PX + 10;
/**
 * Tallest the preview is allowed to get, in logical px.
 *
 * Widening the node must NOT grow the picture. An NLE splits the space the other way: the
 * monitor is a fixed panel and the timeline takes the width. Without a cap, an
 * aspect-driven preview makes the node taller every time you drag it wider - and a
 * portrait clip turns it into a column.
 */
export const PREVIEW_MAX_H = 260;
const TRACK_H = 46;
const MASK_H = 30;
const AUDIO_H = 34;
const AUDIO_ONLY_H = 74;                  // audio lane when sound IS the content
const MIN_VIDEO_TRACKS = 2;
const MAX_VIDEO_TRACKS = 8;
// ONE lane at rest. Unlike the video tracks, which keep a spare permanently so there is
// somewhere to stack onto, an audio timeline that only ever needs one lane should not
// spend half its height on an empty second one. The spare appears while dragging - see
// `audioTrackCount`.
const MIN_AUDIO_TRACKS = 1;
const MAX_AUDIO_TRACKS = 6;
// Area ratio above which a source is worth warning about. 6x is a bit over 2.4x per
// axis - the point where the decoding a scrub throws away stops being noise. 4K into
// 832x480 is 21x.
const SCALE_WARN_RATIO = 6;
const HANDLE_CORE = 4;     // dead zone in the middle so tiny clips stay movable
// Fade grips live in a shallow band at the TOP of the clip body, the way Premiere and
// Resolve place them: the full-height edge underneath stays a trim handle, so the two
// never fight over the corner when the fade is zero and both sit on the same pixel.
// Tall enough to cover the whole DRAWN disc (radius 5 centred at y+6, so it ends at y+11):
// a control you can see but cannot grab is worse than no control at all.
const FADE_BAND_H = 12;
const FADE_GRIP = 7;
// Vertical reach of the volume line. Generous: it is a 1px line and the alternative is
// hunting for it.
const LEVEL_GRAB = 5;
const SNAP_PX = 12;
const MIN_LEN = 1;

/** Which lane a clip lives in. Masks get their own because they are composited into the
 *  `mask` output rather than the picture, but they behave identically to drag. */
type Lane = "video" | "mask" | "audio";

/** Actions whose key can be rebound in ComfyUI settings. The transport (space, J/K/L)
 *  and the in/out marks (I/O) are the same in every editor, so they stay fixed. */
export type KeyAction =
  | "trimHead" | "trimTail" | "markIn" | "markOut" | "markClip" | "zoomFit" | "marker"
  | "blade";

type Hit =
  | { kind: "none" }
  | { kind: "ruler" }
  | { kind: "playhead" }
  | { kind: "inPoint" }
  | { kind: "outPoint" }
  | { kind: "mute"; clip: Clip; lane: Lane }
  | { kind: "clip"; clip: Clip; lane: Lane }
  | { kind: "edge"; clip: Clip; side: "start" | "end"; lane: Lane }
  | { kind: "roll"; left: Clip; right: Clip; lane: Lane }
  | { kind: "fade"; clip: Clip; side: "in" | "out"; lane: Lane }
  | { kind: "level"; clip: Clip; lane: Lane };

type ClipOrigin = { start: number; length: number; trimIn: number; track: number };

type Drag = {
  hit: Hit;
  startX: number;
  before: string;
  origin: ClipOrigin;
  /** Every clip moving in this drag, by id. One entry for a single drag, many for a
   *  group. Snapshots, so each move recomputes from the ORIGINAL state - accumulating
   *  deltas drifts. */
  origins: Map<string, { clip: Clip; from: ClipOrigin }>;
  moved: boolean;
  slip: boolean;
  /** Fade length at the moment of grabbing, so each move recomputes from the original
   *  rather than accumulating - the same reason `origins` snapshots. */
  fadeFrom: number;
  /** Same, for the volume line: level and pointer y when it was grabbed. */
  gainFrom: number;
  startY: number;
};

export class TimelineEditor {
  private readonly host: TimelineHost;
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly preview: HTMLCanvasElement;
  private readonly pctx: CanvasRenderingContext2D;
  private readonly status: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  readonly bar: HTMLDivElement;

  private drag: Drag | null = null;
  private hover: Hit = { kind: "none" };
  /** Transient status-bar message. A button whose conditions are not met must SAY so
   *  there — silently doing nothing reads as a dead button (reported by Neko). */
  private notice: { text: string; until: number } | null = null;
  /** Last play/pause state painted on the button — see updateStatus for why it matters. */
  private playBtnPlaying: boolean | null = null;
  private snapping = true;
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
  private audioGrid = false;
  private raf = 0;
  private disposed = false;
  private lastTimelineH = 0;
  /** Undo stack of whole JSON snapshots. None of the three reference implementations has
   *  one, and ComfyUI's graph undo does not understand drags inside a canvas. */
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Ids of the selected clips. A group drag moves all of them together. */
  private selection = new Set<string>();
  private menu: HTMLDivElement | null = null;
  /** Show the mask lane tinted over the picture in the monitor. */
  private maskOverlay = false;
  private maskBtn!: HTMLButtonElement;
  private dbBtn!: HTMLButtonElement;
  /** Draw the wave on a logarithmic scale. UI-only, like the mask overlay: it changes
   *  nothing the backend renders, so it stays out of the widget and its cache signature. */
  private waveDb = false;
  /** Default ON (Neko, 2026-08-19): the band is why the toggle exists; session-only. */
  private showClipWave = true;
  /** Scratch canvas for tinting the mask; reused so playback does not allocate. */
  private readonly tintCanvas = document.createElement("canvas");
  /** Last quantise/fps pair we warned about, so the toast fires on CHANGE only. */
  private lastFpsWarning = "";
  /** Same, for the canvas warning. */
  private lastCanvasWarning = "";
  /** Last (sources, output size) pair warned about. See `checkSourceScale`. */
  private lastScaleWarning = ""; 
  readonly transport: Transport;
  /** The `<video>` elements THIS editor scrubs. One per node: sharing them is what used to
   *  make two Timeline nodes on the same file drag each other's playhead. */
  readonly pool = new VideoPool();
  /** Called whenever the intrinsic height changes, so the host can resize the node. */
  onHeightChange: (() => void) | null = null;

  /**
   * Sound only: no monitor, no picture lanes, and the audio lanes get the whole widget.
   *
   * A MODE on this class rather than a second editor, because the interaction is
   * identical - drag, trim, blade, snap, undo, in/out, transport - and a parallel
   * implementation of all that would drift within a month. The lane geometry already
   * funnels through `trackCount`/`maskH`/`audioTop`/`laneHeight`, so the mode is those
   * four accessors and the monitor, not a flag sprinkled through the drawing code.
   */
  private readonly audioOnly: boolean;

  constructor(host: TimelineHost, opts: { audioOnly?: boolean } = {}) {
    this.host = host;
    this.audioOnly = !!opts.audioOnly;
    this.transport = new Transport({
      getTimeline: () => host.getTimeline(),
      getFps: () => host.getFps(),
      getStartFrame: () => host.getStartFrame(),
      getEndFrame: () => this.host.getStartFrame() + this.effCount(),
      seek: (f) => this.seek(f, true),
      audioRefFor: (src) => host.sourceFor(src)?.ref ?? null,
      srcFpsFor: (src) => host.sourceFor(src)?.info?.fps ?? host.getFps(),
    });
    this.transport.onChange = () => {
      if (this.transport.rate !== 1) this.pool.pauseAll();
      if (this.transport.rate === 0) this.host.commit();   // persist on stop
      this.requestRender();
    };
    this.root = document.createElement("div");
    this.root.className = "nkd-tl";

    this.preview = document.createElement("canvas");
    this.preview.className = "nkd-tl-preview";
    this.pctx = this.preview.getContext("2d")!;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "nkd-tl-canvas";
    this.ctx = this.canvas.getContext("2d")!;

    this.bar = document.createElement("div");
    this.bar.className = "nkd-tl-bar";
    this.status = document.createElement("span");
    this.status.className = "nkd-tl-status";

    this.buildBar();
    // The preview canvas still EXISTS when there is no picture - `renderPreview` and the
    // resize path both write to it unconditionally - it simply never enters the DOM.
    if (this.audioOnly) this.root.append(this.canvas, this.bar);
    else this.root.append(this.preview, this.canvas, this.bar);
    this.applyTimelineHeight();

    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onHover);
    this.canvas.addEventListener("pointerleave", this.onLeave);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    // Repaint as soon as a source has a frame to show, rather than waiting for a poll.
    this.pool.onReady = () => this.requestRender();
    this.root.addEventListener("keydown", this.onKey);
    this.root.tabIndex = 0;
  }

  // ── Control bar ─────────────────────────────────────────────────────────────

  private buildBar(): void {
    const make = (inner: string, title: string, on: () => void) => {
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
    // PrimeIcons: ComfyUI already loads the font, so it costs nothing and inherits
    // colour/hover. Never emoji - they ignore `color` and read as stickers.
    const icon = (name: string, title: string, on: () => void) =>
      make(`<i class="pi ${name}"></i>`, title, on);

    /**
     * Material Design Icons, for the handful of meanings PrimeIcons simply does not have
     * - a magnet above all, which is THE symbol for snapping in every editor.
     *
     * ComfyUI loads the MDI font too (verified in the running app: `fonts.check` passes
     * and every name below resolves), but its stylesheet only supplies the `content`, not
     * the `font-family` - so the CSS here sets it. Since this pack ships publicly and
     * another install might not carry MDI, each button keeps a PrimeIcons fallback that
     * swaps in once fonts settle, rather than leaving a tofu box in the bar.
     */
    const mdi = (name: string, fallback: string, title: string, on: () => void) => {
      const b = make(`<i class="mdi ${name}"></i>`, title, on);
      void document.fonts?.ready?.then(() => {
        if (!document.fonts.check(`16px "Material Design Icons"`)) {
          b.innerHTML = `<i class="pi ${fallback}"></i>`;
        }
      }).catch(() => { /* no font API: leave the MDI markup as-is */ });
      return b;
    };
    // In/out are plain brackets. Every icon set draws "sign-in"/"sign-out" as arrows
    // pointing the opposite way to what an editor expects, and `[`/`]` are exactly the
    // marks the ruler shows - monochrome text, inherits currentColor like any icon.
    const bracket = (glyph: string, title: string, on: () => void) =>
      make(`<span class="nkd-tl-brk">${glyph}</span>`, title, on);

    // The icon itself changes with the state, like the per-clip speaker: `magnet-on`
    // draws the attraction lines, so the state reads without relying on colour alone.
    const paintMagnet = () => {
      magnet.classList.toggle("on", this.snapping);
      const i = magnet.querySelector("i");
      if (i?.classList.contains("mdi")) {
        i.className = `mdi ${this.snapping ? "mdi-magnet-on" : "mdi-magnet"}`;
      }
    };
    const magnet = mdi("mdi-magnet-on", "pi-bolt", "Snapping (magnet)", () => {
      this.snapping = !this.snapping;
      paintMagnet();
    });
    magnet.classList.add("on");

    // Turning this ON asks the cut grid to satisfy the soundtrack's condition too, which
    // roughly triples its spacing. Only worth it when the sound is actually regenerated
    // across the cut; with the soundtrack kept whole there is no audio edge to align.
    const audioGridBtn = icon("pi-volume-up",
      "Cut grid also respects the soundtrack — turn this on only when the sound is "
      + "regenerated across the cut. With the sound kept whole, leave it off and Shift "
      + "reaches every legal cut instead of one in three.",
      () => {
        this.audioGrid = !this.audioGrid;
        audioGridBtn.classList.toggle("on", this.audioGrid);
      });

    this.playBtn = icon("pi-play", "Play / pause (Space) — J K L to shuttle",
      () => this.transport.toggle());
    this.maskBtn = icon("pi-eye-slash", "Show the mask over the picture (M)",
      () => this.toggleMaskOverlay());
    // A dialogue track peaking at -25 dBFS is a flat line on a linear wave. This is the
    // toggle every audio editor has for exactly that, not a preference.
    this.dbBtn = mdi("mdi-sine-wave", "pi-chart-line",
      "Waveform scale: linear / logarithmic (dB)", () => {
        this.waveDb = !this.waveDb;
        this.dbBtn.classList.toggle("on", this.waveDb);
      });
    // The sound a video clip carries is invisible until it plays — this paints it as a
    // band under the filmstrip, which is where every NLE puts it. A toggle, not always-on:
    // the band costs a third of the filmstrip's height on every clip.
    const waveBtn = mdi("mdi-waveform", "pi-chart-bar",
      "Show each video clip's soundtrack under its filmstrip", () => {
        this.showClipWave = !this.showClipWave;
        waveBtn.classList.toggle("on", this.showClipWave);
        this.requestRender();
      });
    waveBtn.classList.toggle("on", this.showClipWave);   // reflect the default

    /**
     * One flex box per family of buttons, with a rule drawn between them by CSS.
     *
     * Sixteen identical squares in a row is a wall: every icon is found by reading its
     * tooltip, which means finding it by elimination. Grouping is also what makes the bar
     * wrap sensibly on a narrow node - a group breaks as a unit instead of leaving the
     * zoom-out button stranded on the line above its own zoom-in.
     */
    const group = (...els: (HTMLElement | null)[]) => {
      const g = document.createElement("div");
      g.className = "nkd-tl-grp";
      g.append(...els.filter((e): e is HTMLElement => e !== null));
      return g;
    };

    this.bar.append(
      group(                                                        // transport
        icon("pi-step-backward", "Reverse (J)", () => this.transport.shuttle(-1)),
        this.playBtn,
        icon("pi-step-forward", "Forward (L)", () => this.transport.shuttle(1)),
      ),
      group(                                                        // in / out range
        bracket("[", "Mark in point at the playhead (I)", () => this.setIn(this.playhead)),
        bracket("]", "Mark out point at the playhead (O)", () => this.setOut(this.playhead)),
        mdi("mdi-select-all", "pi-clone",
          "Mark clip: fit in/out to the selected clip (X)", () => this.markClip()),
      ),
      group(                                                        // view
        icon("pi-search-minus", "Zoom out (Ctrl + wheel)",
          () => this.zoomBy(1 / 1.6, this.playhead)),
        icon("pi-search-plus", "Zoom in (Ctrl + wheel)",
          () => this.zoomBy(1.6, this.playhead)),
        mdi("mdi-fit-to-screen", "pi-window-maximize", "Fit the whole timeline (F)",
          () => this.zoomFit()),
      ),
      group(                                                        // material vs range
      mdi("mdi-arrow-collapse-horizontal", "pi-arrows-h",
        "Fit the range to the material (no gaps, no mask)",
        () => this.trimToMaterial()),
      // Deliberately NOT another horizontal arrow. Its neighbour above is the exact
      // inverse and was already `mdi-arrow-collapse-horizontal` with a `pi-arrows-h`
      // fallback: two adjacent buttons whose fallbacks were the SAME glyph, told apart
      // only by a tooltip. Neko could not find this one, which is the whole review of
      // that idea. Distinct icon, distinct fallback, and the verb first in the tooltip.
      mdi("mdi-arrow-expand-all", "pi-arrows-alt",
        "Show all the material: open the SELECTED clips to their full length "
        + "(all of them if nothing is selected)",
        () => this.expandToSources()),
        mdi("mdi-content-cut", "pi-filter",
          "Crop the material to the in/out range (discards the rest)",
          () => this.cropToInOut()),
      ),
      group(                                                        // toggles
        magnet,
        audioGridBtn,
        // The mask overlay is a picture control: with no monitor there is nothing to lay
        // it over, so it would be a button that does nothing.
        this.audioOnly ? null : this.maskBtn,
        this.dbBtn,
        // In audio-only mode every clip already IS a waveform.
        this.audioOnly ? null : waveBtn,
      ),
      group(                                                        // sources
        icon("pi-sync", "Conform: take fps and resolution from the first clip",
          () => this.host.conformToFirstClip()),
        icon("pi-refresh", "Reload the connected media (after changing a file)",
          () => this.reloadSources()),
      ),
      group(icon("pi-undo", "Undo (Ctrl+Z)", () => this.undo())),
      this.status,
    );
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  private get tl(): Timeline { return this.host.getTimeline(); }
  private get playhead(): number { return this.tl.ui.playhead; }

  /** Everything there is to look at, zoom aside. Never 0, or all the maths divides by it. */
  private get contentFrames(): number {
    const span = timelineSpan(this.tl);
    const end = this.host.getStartFrame() + this.effCount();
    return Math.max(24, span, end);
  }

  /** First visible frame. */
  private get viewStart(): number {
    return viewWindow(this.tl.ui, this.contentFrames).start;
  }

  /** How many frames the visible window spans. */
  private get viewFrames(): number {
    return viewWindow(this.tl.ui, this.contentFrames).frames;
  }

  private effCount(): number {
    return effectiveCount(this.tl, this.host.getStartFrame(), this.host.getFrameCount(),
      this.host.getQuantize(), this.host.getQuantizeN());
  }

  private get trackCount(): number {
    if (this.audioOnly) return 0;
    let max = MIN_VIDEO_TRACKS;
    for (const c of this.tl.clips) max = Math.max(max, c.track + 1);
    return Math.min(max, MAX_VIDEO_TRACKS);
  }

  /** The mask lane vanishes with the picture; keeping a 30px empty strip would read as a
   *  broken layout rather than as "there is nothing here". */
  private get maskH(): number {
    return this.audioOnly ? 0 : MASK_H;
  }

  /** One tall lane when the sound is the content, one thin strip when it is a companion
   *  to the picture. The wave needs the height: min/max and RMS are indistinguishable at
   *  34px. */
  private get audioLaneH(): number {
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
  private get audioTrackCount(): number {
    if (!this.audioOnly) return 1;
    let max = MIN_AUDIO_TRACKS;
    for (const a of this.tl.audio) max = Math.max(max, (a.track ?? 0) + 1);
    const dragging = this.drag?.hit.kind === "clip" && this.drag.hit.lane === "audio";
    return Math.min(max + (dragging ? 1 : 0), MAX_AUDIO_TRACKS);
  }

  /** Which audio lane a y coordinate falls on. NOT inverted, unlike the video tracks: an
   *  additive mix has no z-order, so there is no "on top" for the rows to depict. */
  private audioTrackOf(y: number): number {
    const row = Math.floor((y - this.audioTop) / this.audioLaneH);
    return Math.max(0, Math.min(this.audioTrackCount - 1, row));
  }

  /** Intrinsic height of the timeline canvas in logical px. */
  get timelineHeight(): number {
    return RULER_H + this.trackCount * TRACK_H + this.maskH
      + this.audioTrackCount * this.audioLaneH;
  }

  /**
   * Pin the canvas height in CSS. Without this the canvas has no CSS height, falls back
   * to its `height` attribute, and `syncSize` reading `clientHeight` to size the backing
   * store makes the two feed each other - the canvas grows every frame and spills far
   * below the node.
   */
  private applyTimelineHeight(): boolean {
    const h = this.timelineHeight;
    if (h === this.lastTimelineH) return false;
    this.lastTimelineH = h;
    this.canvas.style.height = `${h}px`;
    return true;
  }

  private get logicalWidth(): number {
    return Math.max(1, this.canvas.clientWidth);
  }

  private xOf(frame: number): number {
    return ((frame - this.viewStart) / this.viewFrames) * this.logicalWidth;
  }

  private frameOf(x: number): number {
    return Math.round(this.viewStart + (x / this.logicalWidth) * this.viewFrames);
  }

  /** Row for a track. INVERTED on purpose: the highest track number is the topmost
   *  layer, so it must be the topmost ROW too. Drawing track 0 first would put the
   *  bottom layer at the top of the widget and read backwards against every NLE. */
  private trackTop(track: number): number {
    return RULER_H + (this.trackCount - 1 - track) * TRACK_H;
  }

  private trackOf(y: number): number {
    const row = Math.floor((y - RULER_H) / TRACK_H);
    return Math.max(0, Math.min(this.trackCount - 1, this.trackCount - 1 - row));
  }

  private get maskTop(): number {
    return RULER_H + this.trackCount * TRACK_H;
  }

  private get audioTop(): number {
    return this.maskTop + this.maskH;
  }

  private laneOf(lane: Lane): Clip[] {
    return lane === "video" ? this.tl.clips
      : lane === "mask" ? this.tl.masks
      : (this.tl.audio as unknown as Clip[]);
  }

  private laneTop(lane: Lane, track: number): number {
    return lane === "video" ? this.trackTop(track)
      : lane === "mask" ? this.maskTop
      : this.audioTop + Math.max(0, track) * this.audioLaneH;
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
  private levelY(level: number, y: number, h: number): number {
    return y + h * (1 - Math.max(0, Math.min(MAX_GAIN, level)) / MAX_GAIN);
  }

  /** Inverse of `levelY`, for the drag. */
  private levelOf(py: number, y: number, h: number): number {
    return Math.max(0, Math.min(MAX_GAIN, (1 - (py - y) / Math.max(1, h)) * MAX_GAIN));
  }

  private laneHeight(lane: Lane): number {
    return lane === "video" ? TRACK_H : lane === "mask" ? MASK_H : this.audioLaneH;
  }

  // ── Hit-testing ─────────────────────────────────────────────────────────────

  private hitTest(x: number, y: number): Hit {
    if (y < RULER_H) {
      // The in/out bar owns the bottom strip of the ruler (the Premiere idiom), so its
      // brackets are grabbable without stealing the whole ruler from scrubbing.
      if (y >= IO_BAR_TOP - 2) {
        const dIn = Math.abs(x - this.xOf(this.host.getStartFrame()));
        const dOut = Math.abs(x - this.xOf(this.host.getStartFrame() + this.effCount()));
        if (Math.min(dIn, dOut) <= IO_GRAB_PX) {
          return dIn <= dOut ? { kind: "inPoint" } : { kind: "outPoint" };
        }
      }
      return Math.abs(x - this.xOf(this.playhead)) <= HANDLE_PX
        ? { kind: "playhead" } : { kind: "ruler" };
    }
    const lane: Lane = y >= this.audioTop ? "audio"
      : y >= this.maskTop ? "mask" : "video";
    const list = lane === "video"
      ? this.tl.clips.filter((c) => c.track === this.trackOf(y))
      : lane === "audio" && this.audioOnly
        ? this.laneOf(lane).filter((c) => (c.track ?? 0) === this.audioTrackOf(y))
        : this.laneOf(lane);
    // The JUNCTION between two butted clips, tested before the per-clip edges - there both
    // edges sit on the same pixel and whichever answered first would win by accident.
    // Kept BELOW the fade band on purpose: the mute box and the fade-out grip live up
    // there and are smaller targets, so they keep their pixels (same rule as the volume
    // line). Not on the mask lane, which has neither.
    if (lane !== "mask") {
      for (const right of list) {
        if (Math.abs(x - this.xOf(right.start)) > ROLL_PX) continue;
        const left = list.find((c) => c !== right && c.track === right.track
          && c.start + c.length === right.start);
        if (!left) continue;
        // With the speaker out of the way the header is free, so the junction reaches the
        // full lane height. The fade band stays carved out: those grips are smaller
        // targets and they sit on the same pixel when a fade is 0.
        const fadeTop = this.laneTop(lane, right.track)
          + (this.laneHeight(lane) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
        if (y < fadeTop || y > fadeTop + FADE_BAND_H) {
          return { kind: "roll", left, right, lane };
        }
      }
    }
    type Cand = { hit: Hit; dist: number; inside: boolean };
    // Nearest wins, and a tie goes to the clip the pointer is actually over. At a junction
    // that is what separates "the tail fade of the one on the left" from "the head fade of
    // the one on the right" - they sit on the same pixel and differ only by which side.
    const nearest = (list: Cand[]) => list.sort(
      (p, q) => p.dist - q.dist || Number(q.inside) - Number(p.inside))[0].hit;
    const fades: Cand[] = [];
    const edges: Cand[] = [];
    let bodyHit: Hit | null = null;
    // Back to front: the last one drawn is the visible one, so it answers first.
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const a = this.xOf(c.start);
      const b = this.xOf(c.start + c.length);
      if (x < a - HANDLE_PX || x > b + HANDLE_PX) continue;
      // The mute toggle sits inside the header, so it must be tested BEFORE the edges
      // and the body or it would never be reachable.
      const muteX = lane === "mask" ? null : this.muteCentreX(a, b);
      if (muteX !== null
          && Math.abs(x - muteX) <= (MUTE_BOX + MUTE_PAD) / 2
          && Math.abs(y - this.muteCentreY(lane, c.track)) <= (MUTE_BOX + MUTE_PAD) / 2) {
        return { kind: "mute", clip: c, lane };
      }
      // Fade grips, before the edges but only inside the shallow top band.
      if (lane !== "mask" && b - a > 24) {
        const bodyTop = this.laneTop(lane, c.track)
          + (this.laneHeight(lane) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
        if (y >= bodyTop && y <= bodyTop + FADE_BAND_H) {
          // Collected, not returned - same reason as the edges below. Two butted clips put
          // the left one's fade-OUT grip and the right one's fade-IN grip on the very same
          // pixel, and the loop runs right to left, so the right clip took both and the
          // tail fade of the clip before it could not be grabbed at all.
          const fi = this.xOf(c.start + (c.fadeIn ?? 0));
          const fo = this.xOf(c.start + c.length - (c.fadeOut ?? 0));
          const inside = x >= a && x <= b;
          if (Math.abs(x - fi) <= FADE_GRIP) {
            fades.push({ hit: { kind: "fade", clip: c, side: "in", lane },
                         dist: Math.abs(x - fi), inside });
          }
          if (Math.abs(x - fo) <= FADE_GRIP) {
            fades.push({ hit: { kind: "fade", clip: c, side: "out", lane },
                         dist: Math.abs(x - fo), inside });
          }
        }
      }
      // The plateau between the two ramps IS the volume line, so it is grabbable like
      // one. Tested AFTER the fade grips: where they overlap the grip wins, because a
      // grip is a smaller target and the line runs the whole clip.
      if (lane !== "mask" && b - a > 24) {
        const bodyTop = this.laneTop(lane, c.track)
          + (this.laneHeight(lane) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0) + 3;
        const bodyH = this.laneHeight(lane) - 6
          - (this.laneHeight(lane) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
        const from = a + (c.fadeIn ?? 0) * ((b - a) / Math.max(1, c.length));
        const to = b - (c.fadeOut ?? 0) * ((b - a) / Math.max(1, c.length));
        const ly = this.levelY(c.gain ?? 1, bodyTop, bodyH);
        if (x >= from && x <= to && Math.abs(y - ly) <= LEVEL_GRAB) {
          return { kind: "level", clip: c, lane };
        }
      }
      // Edges are COLLECTED, not returned on the spot. Two neighbours both reach into the
      // pixels between them, and returning the first match made the loop order decide:
      // it runs back to front, so the clip on the RIGHT always won and the tail of the
      // one on the left was simply unreachable. Nearest edge wins instead, and on a tie
      // the clip the pointer is actually over does - which is what the eye expects.
      const offer = (edgeX: number, side: "start" | "end") => edges.push({
        hit: { kind: "edge", clip: c, side, lane },
        dist: Math.abs(x - edgeX),
        inside: x >= a && x <= b,
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
      // The body only answers once no edge of ANY clip is in play, or a body hit here
      // would beat a nearer edge belonging to the neighbour.
      if (!matched && x >= a && x <= b) bodyHit = bodyHit ?? { kind: "clip", clip: c, lane };
    }
    // Fades keep their precedence over edges: a smaller target inside a larger one.
    if (fades.length) return nearest(fades);
    if (edges.length) return nearest(edges);
    if (bodyHit) return bodyHit;
    return { kind: "none" };
  }

  private localPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    // Logical/CSS ratio: the graph canvas is scaled by a transform, so raw clientX is
    // wrong at any zoom other than 1.
    return {
      x: (e.clientX - r.left) * (this.logicalWidth / Math.max(1, r.width)),
      y: (e.clientY - r.top) * (this.timelineHeight / Math.max(1, r.height)),
    };
  }

  // ── Interaction ─────────────────────────────────────────────────────────────

  private onDown = (e: PointerEvent): void => {
    // Middle button pans, as it does in every editor. preventDefault stops Windows from
    // starting its autoscroll cursor on top of us.
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startScroll = this.tl.ui.scroll;
      const move = (m: PointerEvent) => {
        const width = Math.max(1, this.canvas.getBoundingClientRect().width);
        this.tl.ui.scroll = startScroll - ((m.clientX - startX) / width) * this.viewFrames;
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
    // preventScroll or the wrapper scrolls and hides the control bar.
    this.root.focus({ preventScroll: true });
    const { x, y } = this.localPos(e);
    const hit = this.hitTest(x, y);

    if (hit.kind === "mute") {
      this.pushUndo();
      hit.clip.muted = !hit.clip.muted;
      this.host.commit();
      // Re-schedule so the change is audible immediately rather than at the next play.
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

    // A group drag moves every selected clip; an edge drag is always just the one.
    const origins = new Map<string, { clip: Clip; from: ClipOrigin }>();
    const snapshot = (k: Clip) => ({
      clip: k, from: { start: k.start, length: k.length, trimIn: k.trimIn, track: k.track },
    });
    if (c) {
      if (hit.kind === "clip") {
        for (const lane of [this.tl.clips, this.tl.masks,
                            this.tl.audio as unknown as Clip[]]) {
          for (const k of lane) if (this.selection.has(k.id)) origins.set(k.id, snapshot(k));
        }
      }
      if (!origins.has(c.id)) origins.set(c.id, snapshot(c));
    }

    this.drag = {
      hit, startX: x,
      before: JSON.stringify(this.tl),
      origin: c
        ? { start: c.start, length: c.length, trimIn: c.trimIn, track: c.track }
        : { start: 0, length: 0, trimIn: 0, track: 0 },
      origins,
      moved: false,
      slip: e.altKey,
      fadeFrom: hit.kind === "fade"
        ? (hit.side === "in" ? hit.clip.fadeIn ?? 0 : hit.clip.fadeOut ?? 0) : 0,
      gainFrom: hit.kind === "level" ? hit.clip.gain ?? 1 : 1,
      startY: y,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    // A cancelled gesture (focus loss, the widget reparented by a renderer switch) fires
    // pointercancel INSTEAD of pointerup; without this the drag state never clears.
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.requestRender();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    e.stopPropagation();
    const { x, y } = this.localPos(e);
    const d = this.drag;
    d.moved = true;
    // SHIFT snaps to the model's quantisation grid, so a cut can be dropped exactly on a
    // block boundary the model accepts. CTRL is the x0.1 fine drag (the pack convention
    // puts that on Shift, but landing on legal frames matters more on a timeline).
    const gain = e.ctrlKey || e.metaKey ? 0.1 : 1;
    // A clip's right edge is where material ENDS; everything else lands where it comes
    // BACK, and only that one is held to the resume window.
    const edge: CutEdge = d.hit.kind === "edge" && d.hit.side === "end" ? "end" : "resume";
    const toGrid = (f: number) => (e.shiftKey
      ? snapFrameToGrid(f, this.host.getStartFrame(), this.host.getQuantize(),
        this.host.getQuantizeN(), this.audioGrid, edge)
      : f);
    const dFrames = Math.round((x - d.startX) * gain / this.logicalWidth * this.viewFrames);

    switch (d.hit.kind) {
      case "roll": {
        const h = d.hit;
        if (rollEdit(h.left, h.right, toGrid(this.frameOf(d.startX + (x - d.startX) * gain)), this.host.getFps(),
                     (c) => this.host.srcFramesFor(c.src),
                     (c) => this.host.sourceFor(c.src)?.info?.fps || this.host.getFps())) {
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
          const thr = (SNAP_PX / this.logicalWidth) * this.viewFrames;
          frame = snap(frame, snapCandidates(this.tl), thr);
        }
        if (d.hit.kind === "inPoint") this.applyIn(frame);
        else this.applyOut(frame);
        break;
      }
      case "fade": {
        const c = d.hit.clip;
        // Dragging INWARDS lengthens the ramp, whichever end it hangs off - so the
        // out-fade counts the drag backwards.
        const len = d.fadeFrom + (d.hit.side === "in" ? dFrames : -dFrames);
        const want = Math.max(0, Math.min(c.length, toGrid(c.start + len) - c.start));
        if (d.hit.side === "in") c.fadeIn = want; else c.fadeOut = want;
        clampFades(c);
        // Audible straight away, like the mute toggle: a fade you cannot hear until the
        // next play is a fade you set by guesswork.
        if (this.transport.rate === 1) this.transport.refreshAudio();
        break;
      }
      case "level": {
        const c = d.hit.clip;
        const lane = d.hit.lane;
        const head = this.laneHeight(lane) > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0;
        const bodyTop = this.laneTop(lane, c.track) + head + 3;
        const bodyH = this.laneHeight(lane) - 6 - head;
        // Ctrl is the fine drag everywhere in this editor, so the level obeys it too:
        // the pointer travels its real distance and the LEVEL moves a tenth of it.
        const py = d.startY + (y - d.startY) * gain;
        const want = this.levelOf(py, bodyTop, bodyH)
          - (this.levelOf(d.startY, bodyTop, bodyH) - d.gainFrom);
        // Shift lands on the 3 dB detents. NOT rounded to two decimals afterwards: that
        // is only there to keep a free drag from writing a long float, and applying it to
        // a snapped value would pull it back off the detent it just landed on.
        c.gain = e.shiftKey
          ? snapGainToDb(want)
          : Math.max(0, Math.min(MAX_GAIN, Math.round(want * 100) / 100));
        if (c.gain === 1) delete c.gain;
        if (this.transport.rate === 1) this.transport.refreshAudio();
        break;
      }
      case "clip": {
        const c = d.hit.clip;
        if (d.slip) {
          c.trimIn = d.origin.trimIn;
          slipClip(c, -dFrames, this.framesOf(c) ?? 0, this.rateOf(c),
            this.host.getFps());
        } else {
          let start = toGrid(d.origin.start + dFrames);
          if (this.snapping && !e.shiftKey) {
            const cands = snapCandidates(this.tl, [this.host.getStartFrame(),
              this.host.getStartFrame() + this.effCount()])
              .filter((v) => v !== c.start && v !== c.start + c.length);
            const thr = (SNAP_PX / this.logicalWidth) * this.viewFrames;
            // Magnet by BOTH edges: butting the tail up is as common as the head.
            const byHead = snap(start, cands, thr);
            const byTail = snap(start + c.length, cands, thr) - c.length;
            start = Math.abs(byHead - start) <= Math.abs(byTail - start) ? byHead : byTail;
          }
          // Audio clips have no track: passing their undefined `track` through
          // Math.round would write NaN into the model.
          const track = d.hit.lane === "video"
            ? Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y)))
            : d.hit.lane === "audio" && this.audioOnly ? this.audioTrackOf(y)
            : 0;
          const shift = start - d.origin.start;
          const lift = track - d.origin.track;
          // No clip may be pushed off the left edge, so the whole group stops together
          // rather than piling up against zero and losing its relative spacing.
          let allowed = shift;
          for (const { from } of d.origins.values()) {
            allowed = Math.max(allowed, -from.start);
          }
          for (const { clip: k, from } of d.origins.values()) {
            moveClip(k, from.start + allowed,
              k === c || this.tl.clips.includes(k) ? from.track + lift : from.track);
          }
        }
        break;
      }
      case "edge": {
        const c = d.hit.clip;
        const info = this.infoFor(c);
        const fps = this.host.getFps();
        const srcFps = this.rateOf(c);
        let frame = toGrid(d.hit.side === "start"
          ? d.origin.start + dFrames
          : d.origin.start + d.origin.length + dFrames);
        if (this.snapping && !e.shiftKey) {
          const thr = (SNAP_PX / this.logicalWidth) * this.viewFrames;
          frame = snap(frame, snapCandidates(this.tl, [this.host.getStartFrame(),
            this.host.getStartFrame() + this.effCount()]), thr);
        }
        // Always from the ORIGINAL state, never accumulating: accumulating drifts.
        c.start = d.origin.start;
        c.length = d.origin.length;
        c.trimIn = d.origin.trimIn;
        if (d.hit.side === "start") trimStart(c, frame, srcFps, fps);
        else trimEnd(c, frame, info?.frame_count ?? 0, srcFps, fps);
        if (c.length < MIN_LEN) c.length = MIN_LEN;
        break;
      }
      default:
        break;
    }
    this.requestRender();
  };

  private onUp = (e: PointerEvent): void => {
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (JSON.stringify(this.tl) === d.before) {
      this.undoStack.pop();   // no actual change: do not pollute the undo stack
    } else {
      sortClips(this.tl);
      this.host.commit();
    }
    this.requestRender();
  };

  private onHover = (e: PointerEvent): void => {
    if (this.drag) return;
    const { x, y } = this.localPos(e);
    const hit = this.hitTest(x, y);
    // Also on a CHANGE OF TARGET within the same kind, or the hint would stay drawn on the
    // junction you just left when you slide onto the next one.
    if (hit.kind !== this.hover.kind
        || (hit.kind === "clip" && this.hover.kind === "clip" && hit.clip !== this.hover.clip)
        || (hit.kind === "roll" && this.hover.kind === "roll" && hit.right !== this.hover.right)
        || (hit.kind === "fade" && this.hover.kind === "fade"
            && (hit.clip !== this.hover.clip || hit.side !== this.hover.side))) {
      this.hover = hit;
      this.requestRender();
    }
    // One cursor per OPERATION, not one per shape. Three different edits used to live on
    // the same horizontal double-arrow and there was no way to tell them apart before
    // committing to the drag. The fade grips take the DIAGONALS on purpose: the cursor
    // then mirrors the slope of the wedge under it - up for a fade in, down for a fade
    // out - so it reads without being learnt.
    this.canvas.style.cursor =
      hit.kind === "mute" ? "pointer"
      : hit.kind === "roll" ? "col-resize"
      : hit.kind === "fade" ? (hit.side === "in" ? "nesw-resize" : "nwse-resize")
      : hit.kind === "level" ? "ns-resize"
      : hit.kind === "edge" || hit.kind === "inPoint" || hit.kind === "outPoint" ? "ew-resize"
      : hit.kind === "clip" ? (e.altKey ? "col-resize" : "grab")
      : hit.kind === "playhead" ? "grab"
      : hit.kind === "ruler" ? "pointer" : "default";
  };

  /**
   * Right-click menu. Two jobs that both belong to "this clip is not what you assumed":
   * reinterpreting a black-and-white video as a mask, and setting how its track composites.
   */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = this.localPos(e);
    const hit = this.hitTest(x, y);
    const items: { label: string; on: () => void; active?: boolean }[] = [];

    if (hit.kind === "clip" || hit.kind === "edge" || hit.kind === "fade"
        || hit.kind === "level") {
      const c = hit.clip;
      if (hit.lane !== "mask") {
        // No "Level: -6 dB" stops here any more. They were the ONLY way to set a level
        // before the volume line existed; now the line is draggable right on the clip,
        // with Ctrl for fine and Shift for 3 dB detents, and four fixed values in a menu
        // are strictly worse than that - fewer choices, further away, and they made this
        // menu long enough to bury the entries that have no other route.
        // The grips on the clip are the fast way, but nobody finds a grip they have not
        // been told about. These say the feature exists, and they are exact where a drag
        // is approximate: "to the playhead" is the same idiom as Trim head/tail.
        const inside = this.playhead > c.start && this.playhead < c.start + c.length;
        if (inside) {
          const setFade = (side: "in" | "out") => () => {
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
            },
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
          },
        });
      }
      if (c.markers?.length) {
        // A stray marker on a long clip is hard to find and therefore hard to un-toggle.
        items.push({
          label: `Clear ${c.markers.length} marker${c.markers.length > 1 ? "s" : ""}`,
          on: () => {
            this.pushUndo();
            delete c.markers;
            this.host.commit();
          },
        });
      }
      if (hit.lane === "video") {
        // Picture off, sound on: the span becomes a region to generate while its own audio
        // keeps playing. This is what "cut the middle out and refill it" needs, and it
        // avoids inventing an audio lane that points back at a video slot.
        items.push({
          label: c.audioOnly ? "Restore picture" : "Audio only (picture becomes a gap)",
          active: !!c.audioOnly,
          on: () => {
            this.pushUndo();
            if (c.audioOnly) delete c.audioOnly; else c.audioOnly = true;
            this.host.commit();
            this.requestRender();
          },
        });
      }
      items.push({
        label: "Split at playhead",
        on: () => { this.select(c); this.bladeAtPlayhead(); },
      });
      items.push({ label: "Delete", on: () => { this.select(c); this.deleteSelected(); } });
    }

    // Blend applies to the video track under the cursor, so right-clicking empty space in
    // a track still gets you there.
    if (y >= RULER_H && y < this.maskTop) {
      const track = Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y)));
      const current = trackBlend(this.tl, track);
      for (const mode of BLEND_MODES) {
        items.push({
          label: `Track ${track} blend: ${mode}`,
          active: mode === current,
          on: () => {
            this.pushUndo();
            setTrackBlend(this.tl, track, mode as BlendMode);
            this.host.commit();
          },
        });
      }
    }
    if (items.length) this.openMenu(e.clientX, e.clientY, items);
  };

  private openMenu(clientX: number, clientY: number,
                   items: { label: string; on: () => void; active?: boolean }[]): void {
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
        // pointerdown, not click: nothing between here and the click can swallow it, and
        // the menu closes on the same gesture that chose the item.
        ev.preventDefault();
        ev.stopPropagation();
        it.on();
        this.closeMenu();
        this.requestRender();
      });
      menu.appendChild(row);
    }
    // Appended to the body, not the node: inside the graph canvas the menu would be
    // clipped by the node box and scaled by the canvas zoom transform.
    document.body.appendChild(menu);
    this.menu = menu;
    setTimeout(() => window.addEventListener("pointerdown", this.closeMenuOnce, true), 0);
  }

  /**
   * Close on a click OUTSIDE the menu.
   *
   * The target check is load-bearing: this listener is on `window` in the CAPTURE phase,
   * so without it a pointerdown on a menu ITEM tears the menu out of the DOM before the
   * item's own `click` ever dispatches - every option silently does nothing.
   */
  private closeMenuOnce = (e: Event): void => {
    if (this.menu && e.target instanceof Node && this.menu.contains(e.target)) return;
    this.closeMenu();
  };

  private closeMenu(): void {
    window.removeEventListener("pointerdown", this.closeMenuOnce, true);
    this.menu?.remove();
    this.menu = null;
  }

  private select(c: Clip): void {
    this.selection.clear();
    this.selection.add(c.id);
  }

  private onLeave = (): void => {
    if (this.drag) return;
    this.hover = { kind: "none" };
    this.requestRender();
  };

  private onKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 10 : 1;
    const key = e.key.toLowerCase();
    // Rebindable first, so a user-chosen key wins over the built-in meaning of the same
    // letter. Premiere puts trim-to-playhead on Q/W; the defaults here are Q/E and both
    // are changeable in Settings -> NKD Timeline.
    const bound = (action: KeyAction, fallback: string) =>
      key === this.host.getKey(action, fallback);
    let handled = true;
    // Shift+M first: M is the marker key in every NLE, so the marker gets the bare letter
    // and the mask overlay - which also has a button - moves up a modifier.
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
      case " ": this.transport.toggle(); break;
      // J K L: the transport every editor has in their fingers, so not rebindable.
      case "j": this.transport.shuttle(-1); break;
      case "k": this.transport.stop(); break;
      case "l": this.transport.shuttle(1); break;
      case "delete":
      case "backspace": this.deleteSelected(); break;
      case "=":
      case "+": this.zoomBy(1.6, this.playhead); break;
      case "-": this.zoomBy(1 / 1.6, this.playhead); break;
      case ",": this.seek(this.playhead - step); break;
      case ".": this.seek(this.playhead + step); break;
      case "home": this.seek(this.host.getStartFrame()); break;
      case "end": this.seek(this.host.getStartFrame() + this.effCount() - 1); break;
      case "z": if (e.ctrlKey || e.metaKey) this.undo(); else handled = false; break;
      case "y": if (e.ctrlKey || e.metaKey) this.redo(); else handled = false; break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      this.requestRender();
    }
  };

  // ── Actions ─────────────────────────────────────────────────────────────────

  private scrubTo(x: number): void {
    this.seek(this.frameOf(x));
  }

  private seek(frame: number, fromTransport = false): void {
    const max = Math.max(0, this.contentFrames - 1);
    this.tl.ui.playhead = Math.max(0, Math.min(max, Math.round(frame)));
    // The playhead lives in node.properties, NOT in the widget: scrubbing must never
    // invalidate ComfyUI's cache. Only real edits (cuts, trims, moves) call commit().
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
  private rawCount(): number {
    const explicit = this.host.getFrameCount();
    return explicit > 0
      ? explicit
      : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
  }

  private applyIn(frame: number): void {
    const end = this.host.getStartFrame() + this.rawCount();
    const s = Math.max(0, Math.min(Math.round(frame), end - 1));
    this.host.setStartFrame(s);
    this.host.setFrameCount(Math.max(1, end - s));
  }

  private applyOut(frame: number): void {
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
  private markClip(): void {
    const at = clipExtent(this.tl, this.playhead,
      this.selection.size ? this.selection : undefined);
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
  private toggleMarkerAtPlayhead(): void {
    const f = this.playhead;
    let targets: Clip[];
    if (this.selection.size) {
      targets = [this.tl.clips, this.tl.masks, this.tl.audio as unknown as Clip[]]
        .flat().filter((c) => this.selection.has(c.id));
    } else {
      targets = clipsAt(this.tl, f).slice(0, 1);
    }
    this.pushUndo();
    let changed = false;
    for (const c of targets) changed = toggleMarker(c, f) || changed;
    if (!changed) {
      this.undoStack.pop();       // playhead off the clip: leave no empty undo behind
      return;
    }
    this.host.commit();
    this.requestRender();
  }

  private setIn(frame: number): void {
    this.pushUndo();
    this.applyIn(frame);
  }

  private setOut(frame: number): void {
    this.pushUndo();
    this.applyOut(frame);
  }

  /**
   * Crop the output range to the material that actually exists, instead of leaving the
   * empty stretches to come out as gaps in `coverage`. The counterpart to letting a gap
   * BE a region to generate: sometimes you just want the excess gone.
   */
  private trimToMaterial(): void {
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
  private deleteSelected(): void {
    if (this.selection.size === 0) return;
    this.pushUndo();
    for (const lane of [this.tl.clips, this.tl.masks,
                        this.tl.audio as unknown as Clip[]]) {
      const kept = lane.filter((c) => !this.selection.has(c.id));
      lane.length = 0;
      lane.push(...kept);
    }
    this.selection.clear();
    this.host.commit();
  }

  // -- Zoom and pan ------------------------------------------------------------

  /** Zoom keeping `anchorFrame` under the same pixel. Anything else feels like the
   *  timeline jumps away from whatever you were looking at. */
  private zoomBy(factor: number, anchorFrame: number): void {
    const ui = this.tl.ui;
    const before = viewWindow(ui, this.contentFrames);
    const rel = (anchorFrame - before.start) / before.frames;   // 0..1 across the view
    ui.zoom = Math.min(MAX_ZOOM, Math.max(1, ui.zoom * factor));
    const after = viewWindow(ui, this.contentFrames);
    ui.scroll = anchorFrame - rel * after.frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }

  private panBy(frames: number): void {
    this.tl.ui.scroll += frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }

  /** viewWindow already clamps; store the clamped value so it cannot creep. */
  private clampScroll(): void {
    this.tl.ui.scroll = viewWindow(this.tl.ui, this.contentFrames).start;
  }

  private zoomFit(): void {
    this.tl.ui.zoom = 1;
    this.tl.ui.scroll = 0;
    this.host.commit();
    this.requestRender();
  }

  /**
   * Ctrl/Cmd + wheel zooms; plain and shift wheel pan, as does a trackpad horizontal axis.
   *
   * `{ passive: false }` on the listener is load-bearing: browsers treat wheel listeners
   * as passive by default and then IGNORE preventDefault, so without it Ctrl+wheel zooms
   * the whole PAGE instead of the timeline. stopPropagation is the other half - otherwise
   * the same event reaches ComfyUI graph canvas and zooms the graph underneath.
   */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { x } = this.localPos(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, this.frameOf(x));
      return;
    }
    // A trackpad reports sideways movement in deltaX; a mouse wheel only has deltaY, so
    // both drive the pan and whichever axis moved more wins.
    const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.panBy((raw / this.logicalWidth) * this.viewFrames);
  };

  /**
   * Throw away whatever falls outside the in/out range. The counterpart to fitting the
   * range to the material: here the range is what you decided, and the material gives.
   */
  private cropToInOut(): void {
    const start = this.host.getStartFrame();
    const end = start + this.effCount();
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = cropToRange(this.tl, start, end, fps, (c) => this.rateOf(c));
    // Rebase to 0 whenever start_frame is OURS to write. The old rule kept the numbering
    // unconditionally because start_frame can arrive through a link — but with a plain
    // widget the un-rebased result reads as the button not working (reported by Neko):
    // you crop to the range and the render still starts at frame 173.
    const rebase = start > 0 && !this.host.isStartFrameLinked();
    if (!changed && !rebase) {
      this.undoStack.pop();          // nothing to do: do not leave a no-op undo behind
      this.say("Nothing outside the in/out range — nothing to crop");
      return;
    }
    if (rebase) {
      for (const lane of [this.tl.clips, this.tl.masks,
                          this.tl.audio as unknown as Clip[]]) {
        for (const c of lane) c.start -= start;   // markers are offsets: they ride along
      }
      this.tl.ui.playhead = Math.max(0, this.tl.ui.playhead - start);
      this.tl.ui.scroll = Math.max(0, this.tl.ui.scroll - start);
      this.host.setStartFrame(0);
    } else if (changed && start > 0) {
      this.say("Cropped — start_frame is linked, so the numbering was kept");
    }
    this.selection.clear();          // ids may have gone with the clips
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
  private trimEdgeToPlayhead(side: "start" | "end"): void {
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = trimToPlayhead(this.tl, this.playhead, side, fps,
      (c) => this.rateOf(c),
      this.selection.size ? this.selection : undefined);
    if (!changed) {
      this.undoStack.pop();      // playhead outside everything: leave no empty undo
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
  reloadSources(): void {
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
  expandToSources(): void {
    const fps = this.host.getFps();
    const ids = this.selection.size ? new Set(this.selection) : undefined;
    this.pushUndo();
    const changed = expandClipsToSources(this.tl, fps,
      (c) => this.framesOf(c), (c) => this.rateOf(c), ids);
    if (!changed) {
      this.undoStack.pop();       // nothing to expand: leave no empty undo behind
      // The usual reasons, said out loud: the length of a tensor source is unknown until
      // the first run, and a selection limits the button to the selected clips.
      this.say(ids
        ? "Nothing to expand in the selection — already at full length "
          + "(deselect to expand everything)"
        : "Nothing to expand — every clip already shows its full source "
          + "(a computed source reports its length after the first run)");
      return;
    }
    this.host.commit();
    this.zoomFit();               // a clip that just grew tenfold is off screen otherwise
    this.requestRender();
  }

  retightenToSources(): boolean {
    const fps = this.host.getFps();
    const before = JSON.stringify(this.tl);
    const changed = clampClipsToSources(this.tl, fps,
      (c) => this.framesOf(c), (c) => this.rateOf(c));
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
  private bladeAtPlayhead(): void {
    const fps = this.host.getFps();
    const at = this.playhead;
    const made: Clip[] = [];
    this.pushUndo();
    for (const lane of [this.tl.clips, this.tl.masks,
                        this.tl.audio as unknown as Clip[]]) {
      // Snapshot: splitting appends to the same array we are walking.
      for (const c of [...lane]) {
        if (this.selection.size && !this.selection.has(c.id)) continue;
        const right = splitClip(c, at, this.rateOf(c), fps);
        if (right) { lane.push(right); made.push(right); }
      }
    }
    if (!made.length) return;      // the playhead was not strictly inside anything
    sortClips(this.tl);
    // Select the right-hand halves: the usual next move is to delete the middle, and this
    // is the piece the user just brought into existence.
    this.selection.clear();
    for (const c of made) this.selection.add(c.id);
    this.host.commit();
    this.requestRender();
  }

  /** True when this clip lives on the audio lane. Identity, not `src`: the same file can
   *  legitimately sit on both lanes at once. */
  private isAudioClip(c: Clip): boolean {
    return (this.tl.audio as unknown as Clip[]).includes(c);
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
  private rateOf(c: Clip): number {
    if (this.isAudioClip(c)) return this.host.getFps();
    return this.host.sourceFor(c.src)?.info?.fps ?? this.host.getFps();
  }

  /** How much material a clip has behind it, in the cadence `rateOf` reports. An audio
   *  clip is bounded by the DECODED SOUND, not by the video's frame count. */
  private framesOf(c: Clip): number | null {
    return this.isAudioClip(c)
      ? this.host.audioFramesFor(c.src)
      : this.host.srcFramesFor(c.src);
  }

  private toggleMaskOverlay(): void {
    this.maskOverlay = !this.maskOverlay;
    this.maskBtn.classList.toggle("on", this.maskOverlay);
    this.maskBtn.innerHTML =
      `<i class="pi ${this.maskOverlay ? "pi-eye" : "pi-eye-slash"}"></i>`;
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
  private checkCanvasAgainstModel(): void {
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
      `${mode.replace(/\s*\(.*\)$/, "")} works on a ${spec.shortEdge}px short edge in `
      + `steps of ${spec.multiple}, capped at ${spec.maxPixels.toLocaleString()} pixels. `
      + `${w}x${h} ${tooBig ? "is over that cap" : "is off the step"}, so the model will `
      + `re-scale every frame itself. For this shape it wants ${aw}x${ah}.`,
      "warn");
  }

  private checkFpsAgainstModel(): void {
    const mode = this.host.getQuantize();
    const want = nativeFpsFor(mode);
    const fps = this.host.getFps();
    const stamp = `${mode}|${fps}`;
    if (stamp === this.lastFpsWarning) return;
    this.lastFpsWarning = stamp;
    if (want === null || Math.abs(want - fps) < 0.01) return;
    this.host.notify(
      "Frame rate does not match the model",
      `${mode.replace(/\s*\(.*\)$/, "")} is trained at ${want} fps, but the timeline `
      + `runs at ${fps}. The frame count will be valid, yet the result will play at the `
      + `wrong speed. Set fps to ${want}, or switch the quantise preset.`,
      "warn");
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
  private checkSourceScale(): void {
    const [ow, oh] = this.host.getOutSize();
    const outPx = Math.max(1, ow * oh);
    let worst: { src: string; w: number; h: number; ratio: number } | null = null;
    const seen = new Set<string>();
    for (const c of [...this.tl.clips, ...this.tl.masks]) {
      if (seen.has(c.src)) continue;
      seen.add(c.src);
      const info = this.host.sourceFor(c.src)?.info;
      if (!info?.width || !info.height) continue;      // tensor, or not probed yet
      const ratio = (info.width * info.height) / outPx;
      if (!worst || ratio > worst.ratio) {
        worst = { src: c.src, w: info.width, h: info.height, ratio };
      }
    }
    // Stamped on the WORST offender and the output size, so it fires once per situation
    // rather than on every repaint - the same discipline as the frame-rate warning.
    const stamp = worst ? `${worst.src}|${worst.w}x${worst.h}|${ow}x${oh}` : "";
    if (stamp === this.lastScaleWarning) return;
    this.lastScaleWarning = stamp;
    if (!worst || worst.ratio < SCALE_WARN_RATIO) return;
    this.host.notify(
      "Material much larger than the output",
      `${worst.src} is ${worst.w}x${worst.h} and this timeline renders ${ow}x${oh} - `
      + `${Math.round(worst.ratio)}x more pixels than needed. The browser cannot decode a `
      + `video at reduced size, so every scrub step pays for all of them: the preview will `
      + `be choppy and each render decodes the same waste. Conforming the source to `
      + `${ow}x${oh} costs nothing in quality here, since the timeline scales it to exactly `
      + `that anyway.`,
      "warn");
  }

  private pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.tl));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private applySnapshot(json: string): void {
    const t = JSON.parse(json);
    const live = this.tl;
    live.clips = t.clips;
    live.audio = t.audio;
    live.ui = t.ui;
    this.host.commit();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(prev);
    this.requestRender();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(next);
    this.requestRender();
  }

  /** Place a freshly connected slot, following the node's import mode. */
  addClipForSlot(src: string, frames: number, lane: Lane = "video",
                 sync?: { start: number; trimIn: number; length: number }): void {
    // Across ALL lanes, not just this one: a clip moved to the mask lane must not be
    // re-added to the picture lane the next time the slots are synced.
    if (slotInUse(this.tl, src)) return;
    const list = this.laneOf(lane);
    this.pushUndo();
    // In the video Timeline the audio lane is a single strip, so stacking there would
    // just be two takes playing over each other with no way to see it - hence append.
    // The Audio Timeline stacks for real, so there the node's import mode applies.
    const mode = lane === "audio" && !this.audioOnly
      ? "append" : this.host.getImportMode();
    // `sync` lands the clip ON another one instead of wherever the import mode would put
    // it - used when the same FILE is already on the timeline and this is its other half.
    const at = sync ?? placementFor(this.tl, list, mode);
    list.push({
      id: newId(), src,
      track: lane === "video" || (lane === "audio" && this.audioOnly)
        ? (at as { track?: number }).track ?? 0 : 0,
      start: at.start,
      trimIn: sync ? sync.trimIn : 0,
      length: Math.max(1, Math.round(sync ? sync.length : frames)),
      ...(lane === "audio" ? { gain: 1 } : {}),
    } as Clip);
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }

  /** Drop clips whose slot no longer has anything connected. Returns true if it changed
   *  anything, so the caller knows whether to commit. */
  pruneToSlots(live: Set<string>): boolean {
    let changed = false;
    for (const lane of [this.tl.clips, this.tl.masks,
                        this.tl.audio as unknown as Clip[]]) {
      const kept = lane.filter((c) => live.has(c.src));
      if (kept.length !== lane.length) {
        lane.length = 0;
        lane.push(...kept);
        changed = true;
      }
    }
    return changed;
  }

  private infoFor(c: Clip): MediaInfo | null {
    return this.host.sourceFor(c.src)?.info ?? null;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  requestRender(): void {
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
  private syncSize(cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
                    logicalH: number): boolean {
    const w = cv.clientWidth;
    if (w < 1 || logicalH < 1) return false;
    // HiDPI plus graph zoom: without ds.scale the canvas is blurry when zoomed in.
    // CAPPED: the product is pixels PER AXIS, so zoom 4 on a HiDPI screen would raster
    // 16-64x the pixels of every frame - filmstrips, waveform and monitor included - and
    // the zoom survives a renderer switch, which reads as "the preview stays at 2 fps
    // even back on legacy nodes". 3x is sharper than any real inspection needs.
    const graphScale = (window as any).app?.canvas?.ds?.scale ?? 1;
    const s = Math.min(3,
      Math.max(1, window.devicePixelRatio || 1) * Math.max(1, graphScale));
    const bw = Math.round(w * s);
    const bh = Math.round(logicalH * s);
    // 2 px deadband: reallocating a canvas clears it and costs real time, and a layout
    // that flaps between two widths (the two renderers disagree by a rounding) would
    // otherwise realloc EVERY frame. The transform below reads the REAL buffer size, so
    // a skipped realloc still maps logical -> buffer exactly.
    if (Math.abs(cv.width - bw) > 2 || Math.abs(cv.height - bh) > 2) {
      cv.width = bw;
      cv.height = bh;
    }
    ctx.setTransform(cv.width / w, 0, 0, cv.height / logicalH, 0, 0);
    return true;
  }

  render(): void {
    if (this.disposed) return;
    // A new track changes the intrinsic height: repin the CSS and tell the host to resize
    // the node, or the extra track would spill below the node frame.
    if (this.applyTimelineHeight()) this.onHeightChange?.();
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

    // Track lanes: flat alternating rows separated by a dark hairline, the way an NLE
    // reads. Video tracks are drawn top-down but numbered bottom-up in an NLE; here the
    // higher index still sits on top, which is what the compositing order means.
    for (let t = 0; t < this.trackCount; t++) {
      const y = this.trackTop(t);   // already inverted: higher track, higher row
      ctx.fillStyle = t % 2 ? C.trackAlt : C.trackBg;
      ctx.fillRect(0, y, W, TRACK_H);
      ctx.fillStyle = C.gridLine;
      ctx.fillRect(0, y, W, 1);
      // A non-normal blend changes what you get, so it must never be invisible.
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
    const bands: [number, number][] = [[this.maskTop, this.maskH]];
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
    for (const a of this.tl.audio as unknown as Clip[]) this.drawClip(ctx, a, "audio");
    this.drawRollHint(ctx);

    this.drawOutside(ctx, W, H, start, count);
    this.drawPlayhead(ctx, H);
    this.updateStatus(fps, count);
    this.checkFpsAgainstModel();
    this.checkCanvasAgainstModel();
    this.checkSourceScale();
  }

  private drawRuler(ctx: CanvasRenderingContext2D, W: number, fps: number): void {
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, 0, W, RULER_H);

    // Step ladder: the first step leaving >=60px between marks wins.
    const steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920, 4800];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if ((s / this.viewFrames) * W >= 60) { step = s; break; }
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
      const label = step >= 24
        ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
        : String(f);
      ctx.fillText(label, x + 3, RULER_H / 2 - 1);
    }

    // Two grids, and they answer different questions. TALL: valid frame counts, i.e. the
    // only end points the model will accept. SHORT: where a CUT can land - the token
    // boundaries Shift snaps to. Seeing the short ones is the point: a hole that starts
    // between them quietly grows to the nearest one when the mask hits the latent grid.
    const mode = this.host.getQuantize();
    if (mode !== QUANTIZE_FREE) {
      const start = this.host.getStartFrame();
      const span = this.contentFrames - start;
      const tick = (frames: number[], h: number, colour: string) => {
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
      // Skipped below ~5 px apart: at that spacing it is a solid band, not a grid, and
      // this runs on every render.
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
  private drawRollHint(ctx: CanvasRenderingContext2D): void {
    const h = this.hover;
    const d = this.drag?.hit;
    const hit = d?.kind === "roll" ? d : h.kind === "roll" ? h : null;
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
    for (const dir of [-1, 1]) {          // one arrowhead each way: both sides move
      ctx.beginPath();
      ctx.moveTo(x + dir * 9, my);
      ctx.lineTo(x + dir * 3, my - 4);
      ctx.lineTo(x + dir * 3, my + 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawInOutBar(ctx: CanvasRenderingContext2D, W: number): void {
    const a = this.xOf(this.host.getStartFrame());
    const b = this.xOf(this.host.getStartFrame() + this.effCount());
    const y = IO_BAR_TOP;

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, y, W, IO_BAR_H);
    ctx.fillStyle = this.host.getQuantize() === QUANTIZE_FREE
      ? "rgba(74,180,255,0.85)" : "rgba(255,209,102,0.85)";
    ctx.fillRect(a, y, Math.max(1, b - a), IO_BAR_H);

    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    const drawBracket = (x: number, glyph: string, hot: boolean) => {
      ctx.fillStyle = hot ? C.hover : "#f2f6fa";
      ctx.textAlign = glyph === "[" ? "left" : "right";
      ctx.fillText(glyph, glyph === "[" ? x - 1 : x + 1, y + IO_BAR_H / 2);
    };
    const dragging = this.drag?.hit.kind;
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
  private drawGaps(ctx: CanvasRenderingContext2D, start: number, count: number): void {
    const top = RULER_H;
    const h = this.trackCount * TRACK_H;
    // No picture lanes, no gap to mark: a "generate" region is a stretch the model has to
    // fill in with IMAGE, and there is no image here. Without this the band has zero
    // height so the amber wash paints nothing, but the LABEL still gets drawn - the word
    // "generate" floating loose under the ruler of the audio node.
    if (h <= 0) return;
    const end = start + count;
    const spans = this.tl.clips
      // An `audioOnly` clip contributes sound and NO picture, so its span is a region to
      // generate - which is exactly what the backend does (nkd_timeline.py, the `audioOnly`
      // branch skips writing pixels). Counting it as material here made the editor lie
      // about the one thing that flag exists to do.
      .filter((c) => !c.audioOnly)
      .map((c) => [Math.max(c.start, start), Math.min(c.start + c.length, end)] as const)
      .filter(([a, b]) => b > a)
      .sort((p, q) => p[0] - q[0]);

    let cursor = start;
    const paint = (a: number, b: number) => {
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

  private drawClip(ctx: CanvasRenderingContext2D, c: Clip, lane: Lane): void {
    const x = this.xOf(c.start);
    const w = Math.max(2, this.xOf(c.start + c.length) - x);
    const y = this.laneTop(lane, c.track) + 3;
    const h = this.laneHeight(lane) - 6;
    const isHover = (this.hover.kind === "clip" || this.hover.kind === "edge")
      && this.hover.clip === c;
    const isDrag = this.drag
      && (this.drag.hit.kind === "clip" || this.drag.hit.kind === "edge"
          || this.drag.hit.kind === "fade")
      && this.drag.hit.clip === c;

    ctx.save();
    ctx.beginPath();
    // Barely-rounded corners and a FLAT fill: an NLE clip is a solid block, and a
    // gradient on every clip turns a dense timeline into mush.
    ctx.roundRect(x, y, w, h, 2);
    // An `audioOnly` clip BEHAVES like an audio clip - it contributes sound and its picture
    // is a hole - so it reads like one, whichever lane it happens to sit on.
    const soundOnly = !!c.audioOnly && lane !== "audio";
    ctx.fillStyle = lane === "audio" || soundOnly ? C.audioFill
      : lane === "mask" ? C.maskFill : C.clipFill;
    ctx.fill();
    ctx.clip();

    // Header band carrying the name, like Premiere's clip label strip. A selected clip
    // gets the accent band: selection has to be visible while the cursor is ON the clip,
    // which is exactly when you are about to act on it.
    const selected = this.selection.has(c.id);
    if (h > CLIP_HEAD_H + 4) {
      ctx.fillStyle = selected ? C.accent
        : lane === "audio" || soundOnly ? C.audioHead
        : lane === "mask" ? C.maskHead : C.clipHead;
      ctx.fillRect(x, y, w, CLIP_HEAD_H);
    }

    const src = this.host.sourceFor(c.src);
    const body = y + (h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
    const bodyH = y + h - body;
    if (src && bodyH > 6) {
      // The waveform is what this clip actually contributes, so it replaces the filmstrip.
      // A video clip's trimIn counts SOURCE frames, so the wave needs the SOURCE rate.
      if (lane === "audio") {
        this.drawWaveform(ctx, c, src.ref, x, body, w, bodyH, this.host.getFps());
      } else if (soundOnly) {
        this.drawWaveform(ctx, c, src.ref, x, body, w, bodyH,
          src.info?.fps || this.host.getFps());
      } else if (src.info) {
        this.drawFilmstrip(ctx, c, src.ref, src.info, x, body, w, bodyH);
        // The soundtrack band, under the filmstrip like any NLE. A scrim behind it,
        // because a wave drawn straight over the stills is unreadable on both counts.
        // Muted clips keep the band: it is a guide to what is IN the material, and the
        // per-clip speaker already says whether it plays.
        if (this.showClipWave && lane === "video" && bodyH > 24) {
          // Half the body, not a third: at 35% telling sound from silence took squinting
          // (Neko, 2026-08-19). The stills above stay recognisable at half height; the
          // wave does not.
          const wh = Math.max(18, Math.round(bodyH * 0.5));
          const wy = body + bodyH - wh;
          ctx.fillStyle = "rgba(6,12,18,0.55)";
          ctx.fillRect(x, wy, w, wh);
          // A video clip's trimIn counts SOURCE frames — same rate rule as `soundOnly`.
          this.drawWaveform(ctx, c, src.ref, x, wy, w, wh,
            src.info.fps || this.host.getFps());
        }
      }
    }
    // Diagonal hatch over the body: "the picture here is a hole", the same thing the amber
    // `generate` wash says about the track underneath.
    if (soundOnly) this.drawHatch(ctx, x, y, w, h);
    if (lane !== "mask" && bodyH > 6) this.drawFades(ctx, c, x, body, w, bodyH);

    if (w > 26) {
      ctx.fillStyle = selected ? "#0d1b24" : src ? C.clipName : C.dim;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      // The colour and the hatch carry the signal at any width; the word is what makes it
      // unambiguous, so it only shows when there is room to spare beside the name.
      const label = (src?.label ?? `${c.src} (no source)`)
        + (soundOnly && w > 150 ? "  ·  audio only" : "");
      ctx.fillText(this.ellipsise(ctx, label, w - 12), x + 5, y + CLIP_HEAD_H / 2);
    }
    // Frame-rate warning: without it the resampling happens silently.
    const info = src?.info;
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
    if (lane !== "mask" && h > CLIP_HEAD_H) {
      const mx = this.muteCentreX(x, x + w);
      if (mx !== null) {
        this.drawSpeaker(ctx, mx, this.muteCentreY(lane, c.track), !!c.muted, isHover);
      }
    }
    this.drawMarkers(ctx, c, y, h);
    // Plus a wash over the body, the way an NLE marks a selection.
    if (selected) {
      ctx.fillStyle = "rgba(74,180,255,0.16)";
      ctx.fillRect(x, y, w, h);
    }
    // Trim handles only show on hover - permanent ones are visual noise on every clip.
    if (isHover && w > 14) {
      ctx.fillStyle = C.hover;
      ctx.fillRect(x, y, 3, h);
      ctx.fillRect(x + w - 3, y, 3, h);
    }
    ctx.restore();

    // Outline last, unclipped, so it is not shaved to half a pixel by the clip region.
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 2);
    // Priority: dragging > SELECTED > hover. Letting hover win made the selection vanish
    // the moment the pointer was over the very clip you had just picked.
    ctx.strokeStyle = isDrag ? C.active
      : selected ? C.accent
      : isHover ? C.hover : C.clipEdge;
    ctx.lineWidth = isDrag || selected || isHover ? 2 : 1;
    ctx.stroke();
  }

  /**
   * Freeze-frame markers: a pennant on the clip's head band plus a hairline down the body,
   * so a marked frame is findable at any zoom without hunting for a 1px tick.
   *
   * Called from inside `drawClip`'s clip region, so a marker never bleeds past its clip.
   */
  private drawMarkers(ctx: CanvasRenderingContext2D, c: Clip, y: number, h: number): void {
    if (!c.markers?.length) return;
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
  private drawFilmstrip(ctx: CanvasRenderingContext2D, c: Clip, ref: MediaRef,
                        info: MediaInfo, x: number, y: number, w: number, h: number): void {
    ensureThumbnails(ref, info, () => this.requestRender());
    const probe = thumbnailAt(ref, 0);
    if (!probe) return;
    const tileW = Math.max(8, (probe.width / probe.height) * h);
    const fps = this.host.getFps();
    const srcFps = info.fps || fps;
    ctx.globalAlpha = 0.95;
    for (let tx = x; tx < x + w; tx += tileW) {
      // Which timeline frame this tile sits on, then which source second that is.
      const f = c.start + ((tx - x) / Math.max(1, w)) * c.length;
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
  private drawFades(ctx: CanvasRenderingContext2D, c: Clip,
                    x: number, y: number, w: number, h: number): void {
    const pxPerFrame = w / Math.max(1, c.length);
    const fi = c.fadeIn ?? 0;
    const fo = c.fadeOut ?? 0;
    const g = c.gain ?? 1;
    const onClip = (this.hover.kind === "clip" || this.hover.kind === "edge"
                    || this.hover.kind === "fade" || this.hover.kind === "level")
      && this.hover.clip === c;
    const touched = fi > 0 || fo > 0 || g !== 1 || !!c.muted;

    // Drawn while the envelope is doing something, or while the pointer is on the clip so
    // the volume line can be grabbed. Always-on would put a line across every clip in the
    // video Timeline, over the filmstrip, saying nothing.
    if (touched || onClip) {
      const pt = ([off, lvl]: [number, number]): [number, number] =>
        [x + off * pxPerFrame, this.levelY(lvl, y, h)];
      const stops = levelStops(c).map(pt);

      ctx.beginPath();
      ctx.moveTo(x, y);                            // top-left...
      for (const p of stops) ctx.lineTo(...p);
      ctx.lineTo(x + w, y);                        // ...round to top-right: the loss
      ctx.closePath();
      ctx.fillStyle = "rgba(6,12,18,0.5)";
      ctx.fill();

      // Unity, so a level away from it is readable as a distance rather than as a number
      // you have to go and look up.
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

      const hotLevel = (this.hover.kind === "level" && this.hover.clip === c)
        || (this.drag?.hit.kind === "level" && this.drag.hit.clip === c);
      ctx.beginPath();
      stops.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.strokeStyle = hotLevel ? C.accent : "rgba(255,255,255,0.7)";
      ctx.lineWidth = hotLevel ? 2 : 1;
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    /**
     * The grips.
     *
     * A 4px square was invisible unless you already knew it was there - the affordance
     * has to say "grab me" before you have read the docs. So: a filled disc with a dark
     * ring, which reads as a control at any size, that GROWS when the pointer is anywhere
     * on the clip. That last part is the Premiere/Resolve idiom - the handles stay quiet
     * on a dense timeline and announce themselves on the clip you are working on.
     */
    const grip = (gx: number, side: "in" | "out") => {
      const hot = (this.hover.kind === "fade" && this.hover.clip === c
                   && this.hover.side === side)
        || (this.drag?.hit.kind === "fade" && this.drag.hit.clip === c
            && this.drag.hit.side === side);
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

    // The wave is drawn from the SOURCE samples, which the gain does not touch, so a level
    // away from unity only shows in the envelope line - and a number is easier to read
    // back than a height.
    if (g !== 1 && w > 60) {
      ctx.fillStyle = C.hover;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`${(20 * Math.log10(Math.max(1e-4, g))).toFixed(1)} dB`,
        x + w - 42, y + h - 3);
    }
  }

  /** The clip's own trimmed span of the wave, so trimming re-reads it.
   *
   * @param trimRate  fps that `c.trimIn` is counted in. An audio clip trims in TIMELINE
   *   frames, a video clip in SOURCE frames - passing the timeline rate for a video whose
   *   source runs at another cadence slides the whole wave off the picture it belongs to.
   */
  private drawWaveform(ctx: CanvasRenderingContext2D, c: Clip, ref: MediaRef,
                       x: number, y: number, w: number, h: number,
                       trimRate: number): void {
    ensureAudio(ref, () => this.requestRender());
    const env = peaksFor(ref);
    const buf = audioBufferFor(ref);
    if (!env || !buf) return;
    // Seconds into the SOURCE, not a fraction of it: the renderer needs real time to know
    // how many samples a column covers, which is what makes the detail follow the zoom.
    const fromSec = c.trimIn / Math.max(1, trimRate);
    const toSec = fromSec + c.length / this.host.getFps();
    drawWave(ctx, buf, env, fromSec, toSec, x, y, w, h, WAVE_COLORS, this.waveDb,
             0, this.logicalWidth);
  }

  /** Amber diagonals, the same colour the `generate` wash uses: this stretch produces no
   *  picture. Called inside `drawClip`'s clip region, so it never bleeds past the block. */
  private drawHatch(ctx: CanvasRenderingContext2D, x: number, y: number,
                    w: number, h: number): void {
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
  private muteCentreX(a: number, b: number): number | null {
    const half = (MUTE_BOX + MUTE_PAD) / 2;
    const lo = a + MUTE_INSET + half;
    const hi = b - MUTE_INSET - half;
    if (hi < lo) return null;
    const seen = (Math.max(a, 0) + Math.min(b, this.logicalWidth)) / 2;
    return Math.round(Math.max(lo, Math.min(hi, seen)));
  }

  /** Where the speaker sits vertically: in the clip BODY, out of the title band. One
   *  definition, so the drawing and the hit box can never drift apart. */
  private muteCentreY(lane: Lane, track: number): number {
    const top = this.laneTop(lane, track);
    const h = this.laneHeight(lane);
    const bodyTop = top + (h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
    return Math.round((bodyTop + top + h) / 2);
  }

  private drawSpeaker(ctx: CanvasRenderingContext2D, cx: number, cy: number,
                      muted: boolean, hot: boolean): void {
    const s = MUTE_BOX;
    ctx.save();
    // A dark plate under the glyph. Without it the speaker is white-on-whatever: over a
    // pale filmstrip frame or a bright waveform it simply disappears, and a control you
    // cannot see is a control that is not there. It also draws the target, which matters
    // more now that the icon has moved in from the edge. Square rather than round: it
    // reads as a button, and it matches the chrome of the toolbar above.
    // Room around the glyph rather than a plate that hugs it, and the same 2px corner the
    // clips use - it reads as part of the same furniture instead of a sticker on top.
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
    // The glyph is NOT symmetric about its own origin: the cone runs from -4 to +1 and the
    // wave arc reaches +6, so drawing it at the centre of the plate leaves it visibly off.
    // Shifted by half its own span, which is what puts the ink in the middle of the box.
    const gx = cx - 1;
    // Cone: a small box plus a triangle opening to the right.
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
      ctx.beginPath();               // struck through when silent
      ctx.moveTo(gx - 5, cy + 5);
      ctx.lineTo(gx + 5, cy - 5);
      ctx.stroke();
    } else {
      ctx.beginPath();               // one arc is enough at this size
      ctx.arc(gx + 2, cy, 4, -0.9, 0.9);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Truncate to fit, with an ellipsis - a name spilling out of its clip reads as a bug. */
  private ellipsise(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
    if (maxW <= 0) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : "";
  }

  /** Dim whatever falls outside [start_frame, start_frame+count). */
  private drawOutside(ctx: CanvasRenderingContext2D, W: number, H: number,
                       start: number, count: number): void {
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

  private drawPlayhead(ctx: CanvasRenderingContext2D, H: number): void {
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
  private drawPreview(): void {
    const [ow, oh] = this.host.getOutSize();
    // aspect-ratio drives the height (the proven NKD Sigmas pattern); the widget height
    // formula resolves the same number, so node and content agree by construction.
    // max-width caps it by HEIGHT (width = maxH x aspect), and `margin: 0 auto` in the
    // stylesheet centres it, so extra node width goes to the timeline instead.
    this.preview.style.aspectRatio = `${Math.max(1, ow)} / ${Math.max(1, oh)}`;
    this.preview.style.maxWidth =
      `${Math.round(PREVIEW_MAX_H * (Math.max(1, ow) / Math.max(1, oh)))}px`;
    const h = this.preview.clientHeight;
    if (!this.syncSize(this.preview, this.pctx, h)) return;
    const w = this.preview.clientWidth;
    const ctx = this.pctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    // BOTTOM-UP through every covering clip, applying each track's blend. That is the
    // whole point of stacking: with `difference`, two versions of a shot cancel to black
    // wherever they agree. `globalCompositeOperation` names map 1:1 onto the backend's
    // maths, so this preview IS the composite, not an impression of it.
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
    ctx.rect(0, 0, w, h);   // cover overflows the frame; the backend crops, so do we
    ctx.clip();
    let painted = false;
    for (const clip of stack) {
      const src = this.host.sourceFor(clip.src);
      if (!src) continue;
      const srcFps = src.info?.fps ?? this.host.getFps();
      const sf = sourceFrame(clip, this.playhead, srcFps, this.host.getFps());
      const at = sf / (srcFps || 1);
      // Forward at 1x: let it play. Anything else (scrub, shuttle, reverse) seeks.
      const img = this.pool.pictureAt(src.ref, at, this.transport.rate === 1);
      if (!img) continue;
      const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLCanvasElement).width;
      const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLCanvasElement).height;
      if (!iw || !ih) continue;
      const r = fitRect(iw, ih, w, h, this.host.getFit());
      const blend = trackBlend(this.tl, clip.track);
      // The lowest layer always draws straight: blending against the initial black would
      // make `multiply` erase it. Same rule the backend applies.
      ctx.globalCompositeOperation = painted && blend !== "normal"
        ? (blend as GlobalCompositeOperation) : "source-over";
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
  private drawMaskOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const top = this.tl.masks
      .filter((c) => this.playhead >= c.start && this.playhead < c.start + c.length)
      .sort((a, b) => b.track - a.track)[0];
    if (!top) return;
    const src = this.host.sourceFor(top.src);
    if (!src) return;
    const srcFps = src.info?.fps ?? this.host.getFps();
    const at = sourceFrame(top, this.playhead, srcFps, this.host.getFps()) / (srcFps || 1);
    // Same playing flag as the picture layers. Passing `false` here made the overlay
    // scrub-seek every frame DURING playback — and when the mask clip points at the same
    // file as a picture clip they share one pooled <video>, so playback kept playing it
    // forward while the overlay dragged it back with a quantised seek per frame: the
    // "steps frame to frame" stutter, measured live (seeks to a repeated rounded target
    // while currentTime advanced past it).
    const img = this.pool.pictureAt(src.ref, at, this.transport.rate === 1);
    if (!img) return;
    const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLCanvasElement).width;
    const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLCanvasElement).height;
    if (!iw || !ih) return;

    const tc = this.tintCanvas;
    if (tc.width !== Math.round(w) || tc.height !== Math.round(h)) {
      tc.width = Math.max(1, Math.round(w));
      tc.height = Math.max(1, Math.round(h));
    }
    const tctx = tc.getContext("2d")!;
    tctx.globalCompositeOperation = "source-over";
    tctx.clearRect(0, 0, tc.width, tc.height);
    tctx.fillStyle = "#000";
    tctx.fillRect(0, 0, tc.width, tc.height);
    const r = fitRect(iw, ih, tc.width, tc.height, this.host.getFit());
    tctx.drawImage(img, r.x, r.y, r.w, r.h);
    tctx.globalCompositeOperation = "multiply";   // white -> red, black stays black
    tctx.fillStyle = "#ff3b30";
    tctx.fillRect(0, 0, tc.width, tc.height);
    tctx.globalCompositeOperation = "source-over";

    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.65;
    ctx.drawImage(tc, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  /** Show `text` in the status bar for a few seconds, then fall back to the readout. */
  private say(text: string): void {
    this.notice = { text, until: performance.now() + 4000 };
    window.setTimeout(() => this.requestRender(), 4100);   // clear even with no other renders
    this.requestRender();
  }

  private updateStatus(fps: number, count: number): void {
    if (this.notice) {
      if (performance.now() < this.notice.until) {
        this.status.textContent = this.notice.text;
        return;
      }
      this.notice = null;
    }
    const rate = this.transport.rate;
    // Written ONLY on a state change. This runs every render — every frame during
    // playback — and an innerHTML assignment replaces the <i> even when the string is
    // identical. With the icon dying under the pointer between pointerdown and pointerup,
    // the browser never dispatches the click: that was "the play button stops working
    // while playing, have to use Space" (reported by Neko + a user, 2026-08-19).
    const playing = rate !== 0;
    if (this.playBtnPlaying !== playing) {
      this.playBtnPlaying = playing;
      this.playBtn.innerHTML = `<i class="pi ${playing ? "pi-pause" : "pi-play"}"></i>`;
      this.playBtn.classList.toggle("on", playing);
    }
    const secs = count / (fps || 1);
    const mode = this.host.getQuantize();
    const raw = this.host.getFrameCount() > 0
      ? this.host.getFrameCount()
      : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
    const q = mode !== QUANTIZE_FREE && raw !== count ? ` (${raw}→${count})` : "";
    const shuttle = Math.abs(rate) > 1 || rate < 0 ? ` · ${rate > 0 ? "" : "-"}${Math.abs(rate)}x` : "";
    const sel = this.selection.size ? ` · ${this.selection.size} selected` : "";
    // Markers only count once they land inside the rendered range - the same filter the
    // backend applies - so the readout matches the string that comes out of the node.
    const start = this.host.getStartFrame();
    const marks = markerFrames(this.tl)
      .filter((f) => f >= start && f < start + count).length;
    const mk = marks ? ` · ${marks} marker${marks > 1 ? "s" : ""}` : "";
    // A canvas has no tooltips, and the status bar is the one place a hint can live
    // without adding chrome. It only speaks while the pointer is actually on a grip, so
    // it never competes with the readout during ordinary work.
    if (this.hover.kind === "fade") {
      const c = this.hover.clip;
      const len = (this.hover.side === "in" ? c.fadeIn : c.fadeOut) ?? 0;
      this.status.textContent =
        `Fade ${this.hover.side} · ${len} frames (${(len / (fps || 1)).toFixed(2)}s)`
        + " · drag sideways to set, Shift snaps to the grid";
      return;
    }
    if (this.hover.kind === "level" || this.drag?.hit.kind === "level") {
      const c = this.drag?.hit.kind === "level" ? this.drag.hit.clip
        : (this.hover as { clip: Clip }).clip;
      const g = c.gain ?? 1;
      const db = g <= 1e-4 ? "-inf" : (20 * Math.log10(g)).toFixed(1);
      this.status.textContent =
        `Volume · ${db} dB · drag up and down, Shift snaps to ${GAIN_DB_STEP} dB, `
        + "Ctrl for fine";
      return;
    }
    this.status.textContent =
      `f ${this.playhead}${shuttle}${sel}${mk} · ${count} frames${q} · ${secs.toFixed(2)}s @ ${fps} fps`;
  }

  destroy(): void {
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
    // Our elements and only ours. This used to be a module-wide sweep in the node's
    // onRemoved, so deleting one Timeline blanked every other one's preview.
    this.pool.releaseAll();
  }
}
