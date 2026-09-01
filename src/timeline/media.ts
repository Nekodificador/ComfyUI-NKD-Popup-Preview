/**
 * 😺NKD Timeline — resolución y decodificación de medios en el navegador.
 *
 * Dos decisiones que definen el rendimiento de todo el widget:
 *
 * 1. **El fichero se sirve CRUDO por `/view`.** aiohttp lo entrega con `FileResponse`,
 *    que soporta Range, así que el `<video>` hace seek nativo. Video Helper Suite
 *    transcodifica cada preview a un WebM en streaming sin Range — por eso su preview no
 *    se puede escrubear. No repetir ese error.
 *
 * 2. **Los metadatos exactos vienen del backend.** `<video>.duration` es poco fiable y el
 *    conteo de frames no está expuesto en el DOM; `/nkd/timeline/probe` los saca con PyAV.
 */
import { api } from "../comfyRuntime";
import { type ChannelEnvelope, buildEnvelope } from "./waveform";

export type MediaRef = { filename: string; subfolder: string; type: string };
export type MediaInfo = {
  fps: number; frame_count: number; duration: number; width: number; height: number;
};

const refKey = (r: MediaRef) => `${r.type}|${r.subfolder}|${r.filename}`;

/** URL del fichero crudo. Vía `api.apiURL` para no romperse tras un proxy o en Desktop
 *  — SA-Nodes escribe "/view?..." a pelo y se rompe ahí. */
/** Bumped by `bustCaches`, and part of every media URL. Overwriting a file keeps its
 *  NAME, so without this the browser would keep serving the old bytes from its own HTTP
 *  cache no matter how much of ours we clear. */
let cacheBust = 0;

export function viewUrl(ref: MediaRef): string {
  const q = new URLSearchParams({
    filename: ref.filename, type: ref.type || "input", subfolder: ref.subfolder || "",
  });
  if (cacheBust) q.set("_nkd", String(cacheBust));
  return api.apiURL(`/view?${q}`);
}

/**
 * Drop every cached view of the media and force a re-fetch.
 *
 * Two different staleness problems: a DIFFERENT file (caught automatically by comparing
 * the resolved reference) and the SAME file with new content, which nothing can detect
 * from the outside - hence the manual button and the URL counter.
 */
export function bustCaches(): void {
  cacheBust += 1;
  infoCache.clear();
  thumbCache.clear();
  audioCache.clear();
  peakCache.clear();
}

/** Forget one source, used when a slot silently starts pointing somewhere else.
 *  Only the caches keyed by FILE - the `<video>` elements live in a per-node pool, so
 *  dropping those is `VideoPool.forget`'s half of the job. */
export function forgetFile(ref: MediaRef): void {
  const key = refKey(ref);
  stripRefs.delete(key);
  infoCache.delete(key);
  thumbCache.delete(key);
  audioCache.delete(key);
  peakCache.delete(key);
}

// ── Resolución del origen a través del grafo ──────────────────────────────────

const FILE_WIDGETS = ["file", "video", "audio", "image", "filename", "path"];
const looksLikeFile = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v !== "none" && /\.[a-z0-9]{2,5}$/i.test(v);

/**
 * Sube por el enlace conectado a `slotName` buscando el nodo que realmente tiene un
 * fichero. Cubre `Load Video → Timeline` (el caso dominante) y cadenas cortas del tipo
 * `Load Video → Trim → Timeline`.
 *
 * ponytail: si la cadena es larga o pasa por un subgrafo, esto devuelve null y el bloque
 * se dibuja como marcador de posición. El empuje de metadatos en ejecución vía websocket
 * cubre ese caso restante — fase 3, no ahora.
 */
export function resolveSource(node: any, slotName: string, maxDepth = 6,
                              depth = 0): MediaRef | null {
  if (depth > maxDepth) return null;
  const slot = node?.inputs?.find((i: any) => i.name === slotName || i.name?.endsWith(`.${slotName}`));
  if (!slot || slot.link == null) return null;
  const link = node.graph?.getLink(slot.link);
  const src = link && node.graph?.getNodeById(link.origin_id);
  if (!src) return null;

  for (const name of FILE_WIDGETS) {
    const w = src.widgets?.find((x: any) => x.name === name);
    if (w && looksLikeFile(w.value)) {
      const raw = String(w.value);
      // ComfyUI anota el origen como "sub/dir/fichero.mp4 [input]".
      const m = /^(.*?)\s*\[(\w+)\]$/.exec(raw);
      const clean = m ? m[1] : raw;
      const cut = clean.lastIndexOf("/");
      return {
        filename: cut >= 0 ? clean.slice(cut + 1) : clean,
        subfolder: cut >= 0 ? clean.slice(0, cut) : "",
        type: m ? m[2] : "input",
      };
    }
  }
  // Un timeline REMEZCLA lo que sale por su salida: corta, deja huecos y mezcla el sonido
  // propio de los vídeos. El paseo hacia arriba se apoya en que "los bytes siguen saliendo
  // de ese fichero" (ver `sourceFor` en main.ts) y aquí eso es FALSO, así que seguir subiendo
  // devuelve el fichero original entero — 36 s de onda para un clip de 8 s, con su longitud.
  // Un bloque liso es la respuesta honesta, igual que para una ranura de tensor.
  // ponytail: solo se cortan los nuestros, que son los que sabemos que transforman. Un nodo
  // de terceros que edite audio sigue mintiendo; el arreglo de fondo sería que un timeline
  // empuje su audio renderizado como hace con las hojas de contactos de los tensores.
  if (src.type === "NKDTimeline" || src.type === "NKDAudioTimeline") return null;

  // Sin fichero propio: seguir subiendo por su primera entrada conectada.
  for (const inp of src.inputs ?? []) {
    if (inp.link == null) continue;
    const up = resolveSource(src, inp.name, maxDepth, depth + 1);
    if (up) return up;
  }
  return null;
}

/** What kind of media is wired into a slot, read from the LINK rather than the socket.
 *
 * The socket itself is multi-type ("VIDEO,IMAGE,MASK,AUDIO"), so it cannot say what is
 * actually connected. The link carries the concrete type; if a frontend build leaves it
 * unset, the origin node output is the fallback. Renderer-independent either way.
 */
export type MediaKind = "video" | "image" | "mask" | "audio";

export function slotKind(node: any, slotName: string): MediaKind | null {
  const slot = node?.inputs?.find(
    (i: any) => i.name === slotName || i.name?.endsWith(`.${slotName}`));
  if (!slot || slot.link == null) return null;
  const link = node.graph?.getLink(slot.link);
  let type = link?.type;
  if (!type && link) {
    const src = node.graph?.getNodeById(link.origin_id);
    type = src?.outputs?.[link.origin_slot]?.type;
  }
  const t = String(type ?? "").toUpperCase();
  // VIDEO and AUDIO first: an upstream that reports a union would otherwise be read as
  // whichever name happens to be checked earliest.
  if (t.includes("VIDEO")) return "video";
  if (t.includes("AUDIO")) return "audio";
  if (t.includes("MASK")) return "mask";
  if (t.includes("IMAGE")) return "image";
  return null;
}

// ── Sondeo de metadatos ───────────────────────────────────────────────────────

const infoCache = new Map<string, MediaInfo>();
const infoPending = new Map<string, Promise<MediaInfo | null>>();

/** Metadatos exactos, cacheados y con las peticiones en vuelo deduplicadas: varios
 *  clips de la misma fuente no disparan varios sondeos. */
export function probe(ref: MediaRef): Promise<MediaInfo | null> {
  const key = refKey(ref);
  const hit = infoCache.get(key);
  if (hit) return Promise.resolve(hit);
  const flight = infoPending.get(key);
  if (flight) return flight;

  const q = new URLSearchParams({
    filename: ref.filename, type: ref.type || "input", subfolder: ref.subfolder || "",
  });
  const p = api.fetchApi(`/nkd/timeline/probe?${q}`)
    .then((r: Response) => (r.ok ? r.json() : null))
    .then((info: MediaInfo | null) => {
      if (info && info.frame_count > 0) infoCache.set(key, info);
      return info;
    })
    .catch(() => null)
    .finally(() => infoPending.delete(key));
  infoPending.set(key, p);
  return p;
}

export const cachedInfo = (ref: MediaRef): MediaInfo | undefined =>
  infoCache.get(refKey(ref));

// ── Pool de elementos <video> ─────────────────────────────────────────────────

type Pooled = {
  el: HTMLVideoElement;
  /** Último frame decodificado con éxito. Mientras el <video> busca, `drawImage` daría
   *  negro; re-pintar este buffer es lo que hace que el scrub no parpadee.
   *  (El truco viene de SA-Nodes/node_setup.js.) */
  good: HTMLCanvasElement;
  hasGood: boolean;
  wantTime: number;
  /** The target the in-flight seek was SENT with. The `seeked` retry compares against
   *  this, never against `currentTime`: on a PLAYING element currentTime has always
   *  advanced past the target by the time the event handler runs, so comparing against
   *  it re-seeks backwards forever — a self-sustaining loop that pinned playback to
   *  ~3 fps (one real step per drift correction) and survived renderer switches. */
  sentTime: number;
  seeking: boolean;
  /** Watchdog for a seek that never reports back. Without it one lost `seeked` wedges the
   *  element for the rest of the session. */
  guard: number;
};

const stripRefs = new Set<string>();

/** How far the picture may lag the playhead before we seek it back. Big enough to absorb
 *  ordinary jitter, small enough that a cut is never visibly late. */
const DRIFT_S = 0.25;

/**
 * The `<video>` elements one Timeline node is scrubbing, and nothing else.
 *
 * OWNED PER NODE, deliberately. This used to be a module-level Map keyed by file, which
 * meant two Timeline nodes wired to the same video shared one element: the playhead of one
 * dragged the other's, pressing Space in one animated both monitors, and deleting either
 * node blanked the survivors. An element carries POSITION, and position is what a node is;
 * the caches above carry the file's CONTENT, which really is the same for everyone, so
 * those stay shared.
 */
export class VideoPool {
  private readonly pool = new Map<string, Pooled>();
  /** Called whenever one of our elements gains something new to show, so the editor can
   *  repaint instead of waiting for the next poll. One per pool, so several editors do not
   *  overwrite each other's - the last one registered used to win, and the rest went
   *  quiet. */
  onReady: (() => void) | null = null;

  private make(ref: MediaRef): Pooled {
    const el = document.createElement("video");
    el.src = viewUrl(ref);
    el.muted = true;           // sin esto el navegador bloquea cualquier reproducción
    el.playsInline = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    const entry: Pooled = {
      el, good: document.createElement("canvas"), hasGood: false, wantTime: -1,
      sentTime: -1, seeking: false, guard: 0,
    };
    // Metadata is what makes the element seekable. Any time requested before this point was
    // parked rather than applied, so apply it now.
    el.addEventListener("loadedmetadata", () => this.applySeek(entry));
    el.addEventListener("seeked", () => {
      window.clearTimeout(entry.guard);
      entry.seeking = false;
      captureGood(entry);
      // Mientras buscábamos pudo pedirse OTRO instante: atenderlo ahora. Comparado
      // contra el objetivo ENVIADO, jamás contra currentTime — en un elemento
      // reproduciéndose currentTime ya pasó el objetivo cuando este handler corre, y
      // comparar contra él re-seekea hacia atrás en bucle infinito (medido: 158 seeks
      // en 3 s desde esta línea, imagen a ~3 fps).
      if (entry.wantTime >= 0 && Math.abs(entry.wantTime - entry.sentTime) > 1e-3) {
        this.applySeek(entry);
      }
    });
    el.addEventListener("loadeddata", () => {
      captureGood(entry);
      this.onReady?.();
      // Fetch the audio only once the picture has its data. Pulling the whole file down for
      // decodeAudioData in parallel competes with the element's own range requests for the
      // per-host connection budget, and the picture is what the user is looking at.
      ensureAudio(ref, () => this.onReady?.());
    });
    return entry;
  }

  private entry(ref: MediaRef): Pooled {
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
  private applySeek(p: Pooled): void {
    if (p.seeking || p.wantTime < 0) return;
    if (p.el.readyState < 1) return;   // not seekable yet; loadedmetadata will retry
    p.seeking = true;
    try {
      p.el.currentTime = p.wantTime;
      p.sentTime = p.wantTime;
    } catch {
      p.seeking = false;
      return;
    }
    // A seek that never reports back must not wedge the element permanently.
    window.clearTimeout(p.guard);
    p.guard = window.setTimeout(() => {
      p.seeking = false;
      captureGood(p);
      this.onReady?.();
    }, 2000);
  }

  videoFor(ref: MediaRef): HTMLVideoElement {
    return this.entry(ref).el;
  }

  /** Pide un instante. Coalescente: durante un arrastre llegan decenas de peticiones por
   *  segundo y el `<video>` solo puede atender una a la vez. */
  seekTo(ref: MediaRef, seconds: number, tolerance = 0.02): void {
    const p = this.entry(ref);
    const want = Math.max(0, seconds);
    // Pedir el instante en el que el elemento YA está no puede cambiar un píxel, y ocupa el
    // decodificador igual. Medido antes de esto: 78 de 78 seeks en reposo y 340 de 468
    // arrastrando eran exactamente eso. `tolerance` es medio frame de la FUENTE, que es lo
    // que "el mismo frame" significa; la pasa el llamante, que es quien sabe su cadencia.
    //
    // Esto es lo ÚNICO que sobrevivió del intento de borrar el canvas `good`. Aquel canvas
    // resultó no ser deuda: es lo que permite que una capa siga aportando imagen mientras
    // busca, y sin él el overlay de máscara desaparece durante el movimiento y la imagen
    // avanza a tirones. Medir el desperdicio no basta para saber qué se puede quitar.
    if (p.el.readyState >= 1 && !p.seeking
        && Math.abs(p.el.currentTime - want) < tolerance) {
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
  followPlayback(ref: MediaRef, seconds: number): void {
    const p = this.entry(ref);
    if (p.el.paused) {
      p.wantTime = Math.max(0, seconds);
      this.applySeek(p);
      void p.el.play().catch(() => { /* autoplay policy, or not ready yet */ });
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
  pictureAt(ref: MediaRef, seconds: number, playing: boolean): CanvasImageSource | null {
    if (stripRefs.has(refKey(ref))) return thumbnailAt(ref, seconds);
    if (playing) this.followPlayback(ref, seconds);
    else this.seekTo(ref, seconds, 0.02);
    return this.frameSource(ref);
  }

  /** Lo que hay que pintar AHORA: el frame vivo si está listo, y si no el último bueno. */
  frameSource(ref: MediaRef): CanvasImageSource | null {
    const p = this.pool.get(refKey(ref));
    if (!p) return null;
    if (!p.seeking && p.el.readyState >= 2) return p.el;
    return p.hasGood ? p.good : null;
  }

  /** Stop our elements. Called when the transport stops, so a clip that scrolled out from
   *  under the playhead does not keep decoding in the background. */
  pauseAll(): void {
    for (const p of this.pool.values()) {
      if (!p.el.paused) p.el.pause();
    }
  }

  private drop(key: string): void {
    const p = this.pool.get(key);
    if (!p) return;
    window.clearTimeout(p.guard);
    p.el.removeAttribute("src");
    p.el.load();
    this.pool.delete(key);
  }

  /** Suelta los elementos que ya no usa ningún clip — un `<video>` retenido mantiene el
   *  fichero decodificándose en memoria. */
  releaseUnused(active: Iterable<MediaRef>): void {
    const keep = new Set<string>();
    for (const r of active) keep.add(refKey(r));
    for (const key of [...this.pool.keys()]) {
      if (!keep.has(key)) this.drop(key);
    }
  }

  /** Everything, on teardown. */
  releaseAll(): void {
    this.releaseUnused([]);
  }

  /** A slot silently started pointing somewhere else: drop the file's shared caches and
   *  our element for it. */
  forget(ref: MediaRef): void {
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
  bust(): void {
    bustCaches();
    this.releaseAll();
  }
}

function captureGood(p: Pooled): void {
  const { el, good } = p;
  if (!el.videoWidth || !el.videoHeight) return;
  if (good.width !== el.videoWidth) good.width = el.videoWidth;
  if (good.height !== el.videoHeight) good.height = el.videoHeight;
  try {
    good.getContext("2d")!.drawImage(el, 0, 0);
    p.hasGood = true;
  } catch {
    /* el frame aún no es dibujable */
  }
}

// ── Filmstrip thumbnails ──────────────────────────────────────────────────────
// Extracted in the browser from the raw file: no server round trip, no ffmpeg, and it
// starts showing frames while it is still working.

export type Thumb = { time: number; canvas: HTMLCanvasElement };

const thumbCache = new Map<string, Thumb[]>();
const thumbJobs = new Map<string, Promise<void>>();

/** How many stills to pull. Enough to read the shot, few enough to stay cheap - and
 *  fewer for long sources, where seeking is what costs. */
function thumbCount(duration: number): number {
  return Math.max(6, Math.min(48, Math.ceil(duration * 2)));
}

/**
 * Fill the strip for a source, calling `onFrame` as each still lands so the UI can paint
 * progressively instead of waiting for the whole run.
 *
 * Uses its OWN <video>, never the preview pool: thumbnail seeking and scrub seeking would
 * otherwise fight over the same element and both would stutter.
 */
export function ensureThumbnails(ref: MediaRef, info: MediaInfo,
                                 onFrame: () => void): Thumb[] {
  const key = refKey(ref);
  const have = thumbCache.get(key);
  if (have) return have;
  if (thumbJobs.has(key)) return [];

  const strip: Thumb[] = [];
  thumbCache.set(key, strip);
  const job = new Promise<void>((resolve) => {
    const el = document.createElement("video");
    el.src = viewUrl(ref);
    el.muted = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    const duration = info.duration || 1;
    const n = thumbCount(duration);
    let i = 0;
    let timer = 0;

    const done = () => {
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve();
    };
    const grab = () => {
      if (i >= n) return done();
      // Sample at the MIDDLE of each slice: the first frame of a shot is often a fade.
      el.currentTime = ((i + 0.5) / n) * duration;
      // A seek that never resolves (a broken keyframe index) must not hang the strip.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { i += 1; grab(); }, 2000);
    };
    el.addEventListener("seeked", () => {
      window.clearTimeout(timer);
      if (el.videoWidth && el.videoHeight) {
        const h = 64;
        const c = document.createElement("canvas");
        c.height = h;
        c.width = Math.max(1, Math.round((el.videoWidth / el.videoHeight) * h));
        try {
          c.getContext("2d")!.drawImage(el, 0, 0, c.width, c.height);
          strip.push({ time: el.currentTime, canvas: c });
          onFrame();
        } catch { /* frame not drawable yet */ }
      }
      i += 1;
      grab();
    });
    el.addEventListener("error", done);
    el.addEventListener("loadeddata", grab, { once: true });
  }).finally(() => thumbJobs.delete(key));

  thumbJobs.set(key, job);
  return strip;
}

/** Which source frame tile `i` shows. Mirrors `strip_frame` in nkd_timeline.py. */
export const stripFrame = (i: number, tiles: number, n: number): number =>
  Math.min(n - 1, Math.floor(((i + 0.5) * n) / tiles));

/**
 * Take a contact sheet the backend wrote for a TENSOR source and file it as that source's
 * thumbnails, so everything downstream treats it like any other filmstrip.
 *
 * An IMAGE/MASK input has no file, so none of the machinery above can reach it - the
 * pooled `<video>`, the probe and the thumbnailer all start from a URL. The backend writes
 * one PNG per tensor slot at the end of a run and this seeds both caches from it, which is
 * why the entry is registered (empty) UP FRONT: otherwise `ensureThumbnails` would spawn a
 * `<video>` job against a PNG.
 *
 * Laid out as a GRID, because at one tile per frame a single row would run tens of
 * thousands of pixels wide and hit the browser's image size limits.
 */
export function adoptStrip(ref: MediaRef, info: MediaInfo, tiles: number, cols: number,
                           onReady: () => void): void {
  const key = refKey(ref);
  stripRefs.add(key);
  if (thumbCache.has(key)) return;
  infoCache.set(key, info);
  const strip: Thumb[] = [];
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
      c.getContext("2d")!.drawImage(
        img, Math.round((i % cols) * tw), Math.round(Math.floor(i / cols) * th),
        c.width, c.height, 0, 0, c.width, c.height);
      // The EXACT frame this tile came from, by the same formula Python used to pick it.
      // Deriving the time from the tile's position instead lands half a tile off, and
      // `thumbnailAt` then hands the overlay a mask from the neighbouring frame.
      strip.push({
        time: stripFrame(i, tiles, info.frame_count) / (info.fps || 1),
        canvas: c,
      });
    }
    onReady();
  };
  img.src = viewUrl(ref);
}

/** Nearest still to `seconds`, or null while the strip is still empty. */
export function thumbnailAt(ref: MediaRef, seconds: number): HTMLCanvasElement | null {
  const strip = thumbCache.get(refKey(ref));
  if (!strip || strip.length === 0) return null;
  let best = strip[0];
  let dist = Math.abs(best.time - seconds);
  for (const t of strip) {
    const d = Math.abs(t.time - seconds);
    if (d < dist) { dist = d; best = t; }
  }
  return best.canvas;
}

// ── Audio: one decode serves both the waveform and playback ───────────────────

const audioCache = new Map<string, AudioBuffer>();
const peakCache = new Map<string, ChannelEnvelope[]>();
const audioJobs = new Map<string, Promise<AudioBuffer | null>>();
let audioCtx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}


/**
 * Decode a source's audio once and keep it: the peaks for the waveform and the buffer for
 * playback come from the same decode.
 *
 * `decodeAudioData` is handed the raw CONTAINER bytes and the browser pulls the audio
 * track out, which is how a plain .mp4 yields its audio with no demuxing on our side.
 *
 * ponytail: this holds the whole track as PCM (a few minutes of stereo is tens of MB).
 * Fine for reference material; if someone drops an hour-long file in, this is the knob to
 * turn - decode lazily per clip window instead.
 */
export function ensureAudio(ref: MediaRef, onDone: () => void): void {
  const key = refKey(ref);
  // `onDone` fires in EVERY case, including "already decoded" and "someone else is
  // already fetching this". Returning early without it is a silent trap the moment a
  // file's picture and sound arrive on two different sockets - exactly what VHS's loader
  // and `Get Video Components` do: whoever asks second has the callback that PLACES ITS
  // CLIP dropped on the floor, so there is no waveform, no sound and no error.
  if (audioCache.has(key)) {
    onDone();
    return;
  }
  const flight = audioJobs.get(key);
  if (flight) {
    void flight.then(() => onDone());
    return;
  }
  const job = fetch(viewUrl(ref))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("fetch failed"))))
    .then((buf) => audioContext().decodeAudioData(buf))
    .then((decoded) => {
      audioCache.set(key, decoded);
      peakCache.set(key, buildEnvelope(decoded));
      return decoded;
    })
    .catch(() => null)               // no audio track, or a codec the browser refuses
    .finally(() => {
      audioJobs.delete(key);
      // Even on failure. A clip whose sound this browser cannot decode still has to
      // appear: the backend reads the file itself and will happily mix it, so refusing
      // to place the clip would lose audio from the RENDER over a preview limitation.
      onDone();
    });
  audioJobs.set(key, job);
}

/** The per-channel min/max/RMS envelope, or undefined until the decode lands. */
export const peaksFor = (ref: MediaRef): ChannelEnvelope[] | undefined =>
  peakCache.get(refKey(ref));

export const audioBufferFor = (ref: MediaRef): AudioBuffer | undefined =>
  audioCache.get(refKey(ref));
