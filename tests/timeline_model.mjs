/**
 * NKD Timeline model checks.
 *
 *   npm test          (node --test tests/timeline_model.mjs)
 *
 * src/timeline/model.ts is bundled with esbuild before running, so this exercises THE
 * SAME code that ships in the bundle, not a copy.
 *
 * Parity with `nkd_timeline.py` is checked against a table transcribed from the Python
 * implementation (see tests/test_timeline.py). Touch one side only and this table fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), "nkd-timeline-"));
const outFile = join(outDir, "model.mjs");
execFileSync(process.execPath, [
  join(root, "node_modules", "esbuild", "bin", "esbuild"),
  join(root, "src", "timeline", "model.ts"),
  "--bundle", "--format=esm", "--platform=node", "--log-level=warning",
  `--outfile=${outFile}`,
], { stdio: "inherit" });

const M = await import(pathToFileURL(outFile).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

const clip = (o = {}) => ({
  id: "x", src: "video_0", track: 0, start: 0, trimIn: 0, length: 10, ...o,
});

const WAN = "Wan (4n+1)";
const LTX = "LTX (8n+1)";
const MOCHI = "Mochi (6n+1)";
const MINIMAX = "MiniMax H3 (17n+5)";
const CUSTOM = "custom (multiple of N)";

test("quantize mode names match the Python combo exactly", () => {
  // The combo value IS what gets serialised and sent to the backend, so a typo here
  // means the node silently falls back to no snapping at all.
  assert.deepEqual(M.QUANTIZE_MODES, [
    "free", WAN, "Hunyuan (4n+1)", LTX, "Cosmos (8n+1)", MOCHI, MINIMAX, CUSTOM,
  ]);
});

test("quantizeCount — parity table with Python", () => {
  // Copied from the Python implementation. If it diverges, the editor's ruler lies about
  // what the backend will render.
  const table = [
    [33, LTX, 8, 33], [40, LTX, 8, 33], [41, LTX, 8, 41],
    [16, WAN, 4, 13], [13, WAN, 4, 13],
    [1, LTX, 8, 9], [3, WAN, 4, 5],
    [20, MOCHI, 6, 19], [7, MOCHI, 6, 7],
    // MiniMax H3 is NOT an Nn+1 family: valid counts are 5, 22, 39, 56... and it rounds
    // UP, because `align_frame_count` walks up while the Nn+1 families floor their
    // latent count. Rounding it down threw material away: 17 asked for, 5 rendered.
    [124, MINIMAX, 17, 124], [130, MINIMAX, 17, 141], [4, MINIMAX, 17, 5],
    [22, MINIMAX, 17, 22], [21, MINIMAX, 17, 22], [17, MINIMAX, 17, 22],
    [0, LTX, 8, 0], [100, "free", 8, 100],
    [100, CUSTOM, 16, 96], [5, CUSTOM, 16, 16],
    // An unknown mode must degrade to no snapping, never to 0.
    [37, "something else", 8, 37],
  ];
  for (const [n, mode, k, want] of table) {
    assert.equal(M.quantizeCount(n, mode, k), want, `${n} ${mode} ${k}`);
  }
  for (const mode of [WAN, LTX, MOCHI, MINIMAX]) {
    for (let n = 1; n < 300; n++) assert.ok(M.quantizeCount(n, mode) >= 5, `${mode} ${n}`);
  }
  // Checked against what the core actually builds, not against our reading of it.
  const alignFrameCount = (n) => { while (n % 17 !== 5) n++; return n; };
  for (let n = 6; n < 200; n++) {
    assert.equal(M.quantizeCount(n, MINIMAX), alignFrameCount(n), `H3 ${n}`);
  }
  for (const [mode, step] of [[LTX, 8], [WAN, 4], [MOCHI, 6]]) {
    for (let n = step + 2; n < 200; n++) {
      assert.equal(M.quantizeCount(n, mode), Math.floor((n - 1) / step) * step + 1,
        `${mode} ${n}`);
    }
  }
});

test("MiniMax H3 stops match core's align_frame_count", () => {
  // comfy_extras/nodes_minimax_h3.py:33 walks UP until n % 17 == 5. We round DOWN, so
  // every stop we produce must be a fixed point of that function.
  const alignUp = (n) => { while (n % 17 !== 5) n += 1; return n; };
  for (const s of M.quantizeStops(400, MINIMAX)) {
    assert.equal(alignUp(s), s, `stop ${s} is not on the 17k+5 grid`);
    assert.equal(M.quantizeCount(s, MINIMAX), s);
  }
  assert.equal(M.quantizeCount(124, MINIMAX), 124);   // the node's own default
});

test("quantizeStops — what gets painted on the ruler", () => {
  assert.deepEqual(M.quantizeStops(30, LTX), [9, 17, 25]);
  assert.deepEqual(M.quantizeStops(14, WAN), [5, 9, 13]);
  assert.deepEqual(M.quantizeStops(40, CUSTOM, 16), [16, 32]);
  assert.deepEqual(M.quantizeStops(45, MINIMAX), [5, 22, 39]);
  assert.deepEqual(M.quantizeStops(100, "free"), []);
  // Every stop must be a fixed point of quantizeCount, or the ruler would lie.
  for (const mode of [WAN, LTX, MOCHI, MINIMAX]) {
    for (const s of M.quantizeStops(200, mode)) {
      assert.equal(M.quantizeCount(s, mode), s, `${mode} ${s}`);
    }
  }
});

test("fitRect — parity with fit_frames, and what the preview draws", () => {
  // 2:1 source into a square frame.
  const contain = M.fitRect(200, 100, 64, 64, "contain");
  assert.deepEqual(contain, { x: 0, y: 16, w: 64, h: 32 });   // letterboxed
  const cover = M.fitRect(200, 100, 64, 64, "cover");
  assert.deepEqual(cover, { x: -32, y: 0, w: 128, h: 64 });   // overflows, gets cropped
  assert.deepEqual(M.fitRect(200, 100, 64, 64, "stretch"), { x: 0, y: 0, w: 64, h: 64 });
  // Already matching: every mode is a no-op.
  for (const mode of ["contain", "cover", "stretch"]) {
    assert.deepEqual(M.fitRect(64, 64, 64, 64, mode), { x: 0, y: 0, w: 64, h: 64 }, mode);
  }
  // Degenerate input must not produce NaN.
  assert.deepEqual(M.fitRect(0, 0, 64, 64, "contain"), { x: 0, y: 0, w: 64, h: 64 });
});

test("sourceFrame — resampling between different frame rates", () => {
  const c = clip({ start: 10, trimIn: 5, length: 100 });
  assert.equal(M.sourceFrame(c, 10, 24, 24), 5);
  assert.equal(M.sourceFrame(c, 34, 24, 24), 29);
  assert.equal(M.sourceFrame(c, 34, 30, 24), 35);  // 24 frames x 30/24
  assert.equal(M.sourceFrame(c, 40, 24, 30), 29);  // 30 frames x 24/30
  assert.equal(M.sourceFrame(c, 50, 24, 0), 5);    // invalid fps must not throw
});

test("parseTimeline — never throws on garbage", () => {
  for (const junk of ["", null, undefined, "{{{", "[]", '{"clips":"nope"}', "7"]) {
    const t = M.parseTimeline(junk);
    assert.deepEqual(t.clips, []);
    assert.deepEqual(t.audio, []);
  }
  const t = M.parseTimeline(JSON.stringify({
    clips: [
      { id: "b", src: "video_1", track: 2, start: 10, trimIn: 3, length: 20 },
      { id: "a", src: "video_0", track: 0, start: 0, length: 30 },
      { src: "video_9", length: 0 },   // zero length -> dropped
      { track: 1, length: 5 },         // no src -> dropped
    ],
    audio: [{ src: "audio_0", start: 0, length: 50, gain: 0.5 }],
    ui: { playhead: 12, zoom: 2 },
  }));
  assert.equal(t.clips.length, 2);
  assert.deepEqual(t.clips.map((c) => c.src), ["video_0", "video_1"]); // sorted by track
  assert.equal(t.clips[1].trimIn, 3);
  assert.equal(t.audio[0].gain, 0.5);
  assert.equal(t.ui.playhead, 12);
  assert.equal(M.timelineSpan(t), 50);
  // An audio clip with no id gets one: without it, dragging breaks after a reload.
  assert.ok(t.audio[0].id);
});

test("serialiseTimeline — round trip, no transient fields", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "a", src: "video_0", track: 1, start: 4, trimIn: 2, length: 8 }],
    audio: [], ui: { playhead: 3, zoom: 1.5 },
  }));
  // Fields the editor hangs on at runtime that must NEVER persist.
  t.clips[0].videoEl = { fake: true };
  t.clips[0].thumbnails = [1, 2, 3];
  const round = M.parseTimeline(M.serialiseTimeline(t));
  assert.deepEqual(round.clips[0], {
    id: "a", src: "video_0", track: 1, start: 4, trimIn: 2, length: 8,
  });
  // The playhead lives in node.properties (via viewState), NOT in the widget
  // JSON: scrubbing must not invalidate the cache. Zoom/scroll too.
  assert.equal(JSON.parse(M.serialiseTimeline(t)).ui.playhead, undefined);
  assert.equal(JSON.parse(M.serialiseTimeline(t)).ui.zoom, undefined);
});

test("resolveResolution — parity table with Python", () => {
  // Generated from `resolve_resolution` in nkd_timeline.py. If one side moves, this fails,
  // which is the point: the monitor would otherwise preview an aspect the backend will not
  // render. Custom must pass width/height straight through - that is the old behaviour and
  // the default, so a workflow saved before these widgets existed is untouched.
  const CASES = [
    ["16:9 Horizontal", 1.0, 16, [1376, 768]],
    ["9:16 Vertical", 1.0, 16, [768, 1376]],
    ["9:16 Vertical", 0.8, 32, [704, 1248]],
    ["1:1", 2.0, 16, [1456, 1456]],
    ["21:9 Horizontal", 0.5, 8, [1112, 480]],
    ["32:9 Horizontal", 1.0, 64, [1984, 576]],
    ["Custom", 1.0, 16, [1920, 1080]],
  ];
  for (const [aspect, mp, mult, want] of CASES) {
    assert.deepEqual(M.resolveResolution(aspect, mp, 1920, 1080, mult), want,
      `${aspect} @ ${mp}MP /${mult}`);
  }
  // The size_multiple has to actually bite: a 32-grid model must not get 16-grid numbers.
  for (const mult of [8, 16, 32, 64]) {
    const [w, h] = M.resolveResolution("9:16 Vertical", 1, 0, 0, mult);
    assert.equal(w % mult, 0);
    assert.equal(h % mult, 0);
  }
  // Junk megapixels must not produce NaN dimensions.
  for (const bad of [0, -1, NaN, undefined]) {
    const [w, h] = M.resolveResolution("1:1", bad, 0, 0, 16);
    assert.ok(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0, String(bad));
  }
  assert.equal(Object.keys(M.ASPECT_RATIOS).length, 25);   // same table as Python

  // "As Source": keep the material's shape, rescale it to the budget. Parity table from
  // `resolve_resolution` in Python.
  const SRC = [
    [1920, 1080, 0.5, 16, [960, 544]],
    [1080, 1920, 0.5, 32, [544, 960]],
    [2560, 1210, 2.0, 16, [2096, 992]],   // the awkward one the 4-candidate snap is for
    [640, 480, 1.0, 8, [1184, 888]],
  ];
  for (const [sw, sh, mp, mult, want] of SRC) {
    assert.deepEqual(M.resolveResolution("As Source", mp, 0, 0, mult, sw, sh), want,
      `As Source ${sw}x${sh} @${mp}MP /${mult}`);
    // Aspect drift has to stay tiny - that is the whole reason for the four candidates.
    const [w, h] = want;
    assert.ok(Math.abs((w / h) - (sw / sh)) / (sw / sh) < 0.02, `drift ${sw}x${sh}`);
  }
  // With no source yet it falls back to the typed width/height instead of guessing.
  assert.deepEqual(M.resolveResolution("As Source", 1, 640, 480, 16, 0, 0), [640, 480]);
});

test("splitClip — the blade, its trim and its markers", () => {
  // Same cadence: the right half starts where the left stopped reading.
  let c = clip({ start: 10, trimIn: 4, length: 20 });
  let right = M.splitClip(c, 16, 24, 24);
  assert.deepEqual([c.start, c.length, c.trimIn], [10, 6, 4]);
  assert.deepEqual([right.start, right.length, right.trimIn], [16, 14, 10]);
  assert.notEqual(right.id, c.id);                    // a new clip, not an alias

  // Different cadence: 6 timeline frames at 24 fps are 7.5 -> 8 source frames at 30.
  // Getting this wrong makes the second half play from the wrong place, silently.
  c = clip({ start: 10, trimIn: 4, length: 20 });
  right = M.splitClip(c, 16, 30, 24);
  assert.equal(right.trimIn, 4 + Math.round(6 * (30 / 24)));

  // Outside, or exactly on an edge, is a no-op rather than a zero-length clip.
  for (const at of [10, 30, 5, 99]) {
    const k = clip({ start: 10, trimIn: 0, length: 20 });
    assert.equal(M.splitClip(k, at, 24, 24), null, String(at));
    assert.equal(k.length, 20);
  }

  // Markers are offsets from `start`, so they follow the picture they were put on.
  c = clip({ start: 0, trimIn: 0, length: 20, markers: [2, 5, 12, 18] });
  right = M.splitClip(c, 8, 24, 24);
  assert.deepEqual(c.markers, [2, 5]);
  assert.deepEqual(right.markers, [4, 10]);           // 12 and 18, rebased onto the new clip
  // A half with none left must not carry an empty array into the JSON.
  c = clip({ start: 0, trimIn: 0, length: 20, markers: [1, 2] });
  right = M.splitClip(c, 10, 24, 24);
  assert.equal(right.markers, undefined);

  // audioOnly rides along: both halves keep the flag, and it survives a round trip.
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "a", start: 0, trimIn: 0, length: 20, audioOnly: true })];
  const r2 = M.splitClip(t.clips[0], 10, 24, 24);
  assert.equal(r2.audioOnly, true);
  t.clips.push(r2);
  const back = M.parseTimeline(M.serialiseTimeline(t));
  assert.equal(back.clips[0].audioOnly, true);
  assert.equal(back.clips[1].audioOnly, true);
  // ...and stays out of the JSON when it is off, like `muted`.
  t.clips.forEach((k) => delete k.audioOnly);
  assert.ok(!("audioOnly" in JSON.parse(M.serialiseTimeline(t)).clips[0]));
});

test("clipsAt — the higher track is the visible one", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "lo", track: 0, start: 0, length: 20 }),
             clip({ id: "hi", track: 3, start: 5, length: 5 })];
  assert.deepEqual(M.clipsAt(t, 2).map((c) => c.id), ["lo"]);
  assert.deepEqual(M.clipsAt(t, 6).map((c) => c.id), ["hi", "lo"]); // topmost first
  assert.deepEqual(M.clipsAt(t, 50).map((c) => c.id), []);          // a gap
});

test("effectiveCount — what the backend will actually produce", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ start: 0, length: 40 })];
  assert.equal(M.effectiveCount(t, 0, 0, "free"), 40);
  assert.equal(M.effectiveCount(t, 0, 0, LTX), 33);
  assert.equal(M.effectiveCount(t, 10, 0, "free"), 30);   // start_frame is subtracted
  assert.equal(M.effectiveCount(t, 0, 25, "free"), 25);   // explicit frame_count wins
  assert.equal(M.effectiveCount(M.emptyTimeline(), 0, 0, "free"), 0);
});

test("snap — magnets to the nearest candidate within the threshold", () => {
  assert.equal(M.snap(48, [0, 50, 100], 5), 50);
  assert.equal(M.snap(43, [0, 50, 100], 5), 43);   // outside the threshold, untouched
  assert.equal(M.snap(51, [50, 52], 5), 52);       // tie: the last candidate wins
  const t = M.emptyTimeline();
  t.clips = [clip({ start: 10, length: 20 })];
  t.ui.playhead = 7;
  assert.deepEqual([...M.snapCandidates(t)].sort((a, b) => a - b), [0, 7, 10, 30]);
});

test("trimStart — content does not slide under the cut", () => {
  const c = clip({ start: 10, trimIn: 20, length: 30 });   // ends at 40
  M.trimStart(c, 15, 24, 24);
  assert.equal(c.start, 15);
  assert.equal(c.trimIn, 25);        // advanced exactly as much as the edge
  assert.equal(c.start + c.length, 40); // the end does NOT move
  // Cannot trim past the start of the source.
  const d = clip({ start: 10, trimIn: 3, length: 30 });
  M.trimStart(d, 0, 24, 24);
  assert.equal(d.trimIn, 0);
  assert.equal(d.start, 7);          // 10 - 3, the material available
  // Nor invert the clip.
  const e = clip({ start: 0, trimIn: 100, length: 10 });
  M.trimStart(e, 999, 24, 24);
  assert.ok(e.length >= 1);
  // With mismatched rates the trim advances at the SOURCE cadence.
  const f = clip({ start: 0, trimIn: 0, length: 30 });
  M.trimStart(f, 10, 30, 24);
  assert.equal(f.trimIn, 13);        // 10 timeline frames x 30/24 = 12.5 -> 13
});

test("trimEnd — never stretches past the available material", () => {
  const c = clip({ start: 0, trimIn: 0, length: 10 });
  M.trimEnd(c, 50, 100, 24, 24);
  assert.equal(c.length, 50);
  M.trimEnd(c, 500, 100, 24, 24);
  assert.equal(c.length, 100);       // capped at the whole source
  M.trimEnd(c, -5, 100, 24, 24);
  assert.equal(c.length, 1);         // never below a single frame
  // 30 fps source on a 24 fps timeline: 100 source frames give 80 timeline frames.
  const d = clip({ start: 0, trimIn: 0, length: 10 });
  M.trimEnd(d, 999, 100, 30, 24);
  assert.equal(d.length, 80);
});

test("slipClip — moves the content, not the clip", () => {
  const c = clip({ start: 10, trimIn: 20, length: 30 });
  M.slipClip(c, 5, 200, 24, 24);
  assert.equal(c.trimIn, 25);
  assert.equal(c.start, 10);         // position untouched
  assert.equal(c.length, 30);        // duration untouched
  // Cannot run off the end of the source: 30 of 40 frames used -> max trim 10.
  const d = clip({ start: 0, trimIn: 0, length: 30 });
  M.slipClip(d, 999, 40, 24, 24);
  assert.equal(d.trimIn, 10);
  // Nor off the start.
  M.slipClip(d, -999, 40, 24, 24);
  assert.equal(d.trimIn, 0);
});

test("mask lane survives the round trip and counts toward the span", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "v", src: "video_0", start: 0, length: 10 }],
    masks: [{ id: "m", src: "mask_0", start: 20, trimIn: 4, length: 15 }],
    audio: [],
  }));
  assert.equal(t.masks.length, 1);
  assert.equal(t.masks[0].trimIn, 4);
  assert.equal(M.timelineSpan(t), 35);            // the mask lane extends the span
  const round = M.parseTimeline(M.serialiseTimeline(t));
  assert.deepEqual(round.masks[0], {
    id: "m", src: "mask_0", track: 0, start: 20, trimIn: 4, length: 15,
  });
  // A timeline saved before the mask lane existed must still load.
  assert.deepEqual(M.parseTimeline('{"clips":[],"audio":[]}').masks, []);
  // Mask edges are snap candidates too - you align a mask to a cut constantly.
  assert.ok(M.snapCandidates(t).includes(20));
  assert.ok(M.snapCandidates(t).includes(35));
});

test("materialRange — what 'trim to material' crops to", () => {
  const t = M.emptyTimeline();
  assert.equal(M.materialRange(t), null);          // nothing at all
  t.clips = [clip({ start: 30, length: 10 }), clip({ start: 5, length: 10 })];
  t.masks = [clip({ start: 50, length: 4 })];
  assert.deepEqual(M.materialRange(t), { start: 5, end: 54 });
  // Audio alone must NOT define the picture range.
  const onlyAudio = M.emptyTimeline();
  onlyAudio.audio = [{ id: "a", src: "audio_0", start: 0, trimIn: 0, length: 99, gain: 1 }];
  assert.equal(M.materialRange(onlyAudio), null);
});

test("cutStops — where a latent begins, which is not where a count is valid", () => {
  const H3 = "MiniMax H3 (17n+5)";
  // H3 cuts on whole blocks: the material has to resume on a multiple of 17, and the
  // cuts that achieve that are 17g-3 .. 17g.
  // A window of four, not a point: 133..136 all land the material at 136.
  assert.deepEqual(M.cutStops(40, H3),
    [0, 14, 15, 16, 17, 31, 32, 33, 34]);
  // and 132 - the first frame of that token - is NOT in it
  assert.ok(!M.cutStops(140, H3).includes(132));
  assert.ok([133, 134, 135, 136].every((f) => M.cutStops(140, H3).includes(f)));
  // With sound, the window is intersected with the multiples of 3 (40/24 = 5/3), which
  // still leaves one or two per block rather than one every 51 frames.
  assert.deepEqual(M.cutStops(40, H3, true), [0, 15, 33]);
  assert.ok(M.cutStops(140, H3, true).every((f) => f % 3 === 0));
  // The edge where material ENDS takes the plain token grid instead.
  assert.deepEqual(M.cutStops(40, H3, false, "end"),
    [0, 1, 5, 9, 13, 17, 18, 22, 26, 30, 34, 35, 39]);
  assert.ok(M.cutStops(140, H3, false, "end").includes(132));   // free where the window is not
  // The Nn+1 families do not restart: frame 0 alone, then every 1 + N*k.
  assert.deepEqual(M.cutStops(20, "LTX (8n+1)"), [0, 1, 9, 17]);
  assert.deepEqual(M.cutStops(14, "Wan (4n+1)"), [0, 1, 5, 9, 13]);
  assert.deepEqual(M.cutStops(13, "Mochi (6n+1)"), [0, 1, 7, 13]);
  // Audio is a no-op where the preset states no audio rate, so a picture-only family
  // is never held to a grid it does not have.
  assert.deepEqual(M.cutStops(20, "LTX (8n+1)", true), M.cutStops(20, "LTX (8n+1)"));
  // No token pattern documented -> no claim.
  assert.deepEqual(M.cutStops(50, "custom (multiple of N)"), []);
  assert.deepEqual(M.cutStops(50, "free"), []);
});

test("snapFrameToGrid — Shift lands the playhead on a token boundary", () => {
  const LTX8 = "LTX (8n+1)";
  const H3 = "MiniMax H3 (17n+5)";
  assert.equal(M.snapFrameToGrid(20, 0, LTX8), 17);
  assert.equal(M.snapFrameToGrid(22, 0, LTX8), 25);
  // CHANGED semantics: this used to clamp up to the first valid COUNT (9). A cut is not
  // a count - frame 1 really is where the second latent starts - so it snaps there now.
  assert.equal(M.snapFrameToGrid(2, 0, LTX8), 1);
  // The grid rides start_frame, so trimming the head does not invalidate every cut.
  assert.equal(M.snapFrameToGrid(120, 100, LTX8), 117);
  // Free mode is a no-op.
  assert.equal(M.snapFrameToGrid(37, 0, "free"), 37);
  // H3 lands on whole blocks: 133 resolves to 136, where the material resumes.
  assert.equal(M.snapFrameToGrid(133, 0, H3), 133);   // already safe: left where it is
  assert.equal(M.snapFrameToGrid(132, 0, H3), 133);   // outside the window: moves one on
  // ...but the same 132 is fine on the edge where material ENDS - a plain extension.
  assert.equal(M.snapFrameToGrid(132, 0, H3, 8, false, "end"), 132);
  assert.equal(M.snapFrameToGrid(130, 0, H3, 8, false, "end"), 128);
  assert.equal(M.snapFrameToGrid(40, 0, H3), 34);
  assert.equal(M.snapFrameToGrid(50, 0, H3, 8, true), 51);   // audio: window n multiples of 3
  // Whatever it returns is a legal cut, at any start frame, with or without sound.
  for (const mode of [LTX8, "Wan (4n+1)", H3]) {
    for (const withAudio of [false, true]) {
      for (let f = 0; f < 200; f++) {
        const got = M.snapFrameToGrid(f, 30, mode, 8, withAudio) - 30;
        assert.ok(M.cutStops(400, mode, withAudio).includes(got),
          `${mode} audio=${withAudio} ${f} -> ${got}`);
      }
    }
  }
});

test("adaptCanvas — the size the model would have chosen", () => {
  const H3 = M.canvasFor("MiniMax H3 (17n+5)");
  // 16:9 lands on H3's own default, which is the check that the port is faithful.
  assert.deepEqual(M.adaptCanvas(1920, 1080, H3), [1344, 768]);
  assert.deepEqual(M.adaptCanvas(1080, 1920, H3), [768, 1344]);
  assert.deepEqual(M.adaptCanvas(1000, 1000, H3), [768, 768]);
  for (const [w, h] of [[1920, 1080], [1080, 1920], [1000, 1000], [2560, 1210], [640, 480]]) {
    const [aw, ah] = M.adaptCanvas(w, h, H3);
    assert.equal(aw % 32, 0);
    assert.equal(ah % 32, 0);
    // The cap is applied BEFORE the round to 32, so the final size can sit a hair over
    // it - 2560x1210 gives 1472x704. That is the core's own behaviour and matching it is
    // the point; "fixing" it here would put us off the size H3 actually builds.
    assert.ok(aw * ah <= H3.maxPixels * 1.01, `${w}x${h} -> ${aw}x${ah}`);
  }
  assert.equal(M.canvasFor("Wan (4n+1)"), null);   // undocumented stays undocumented
});

test("rollEdit — moves a junction without ever opening a gap", () => {
  const mk = (start, len, trimIn) => ({ id: "x" + start, src: "media_0", track: 0,
                                        start, trimIn, length: len });
  const src = () => 400, rate = () => 24;
  const butted = (l, r) => assert.equal(l.start + l.length, r.start,
    `junction split: ${l.start}+${l.length} vs ${r.start}`);

  // Nominal: the cut slides, one shortens and the other grows by the same amount.
  let a = mk(0, 100, 0), b = mk(100, 100, 100);
  assert.ok(M.rollEdit(a, b, 120, 24, src, rate));
  assert.equal(a.length, 120);
  assert.equal(b.start, 120);
  assert.equal(b.trimIn, 120);          // the right clip gave up 20 frames of its head
  butted(a, b);

  // The right clip cannot reach further back than the material its trimIn skipped.
  a = mk(0, 100, 0); b = mk(100, 100, 10);
  M.rollEdit(a, b, 50, 24, src, rate);
  assert.equal(b.start, 90);            // 10 frames of handle, no more
  assert.equal(b.trimIn, 0);
  butted(a, b);                         // and the left one followed it exactly

  // The left clip cannot outrun its own source. THIS is the case that would tear:
  // trimEnd would clamp and trimStart would not, leaving a hole.
  a = mk(0, 100, 0); b = mk(100, 100, 100);
  M.rollEdit(a, b, 190, 24, () => 130, rate);
  assert.equal(a.start + a.length, 130);
  butted(a, b);

  // Neither clip may vanish, and a no-op reports no change.
  a = mk(0, 100, 0); b = mk(100, 100, 100);
  assert.equal(M.rollEdit(a, b, 100, 24, src, rate), false);
  M.rollEdit(a, b, -50, 24, src, rate);
  assert.ok(a.length >= 1 && b.length >= 1);
  butted(a, b);

  // A source at another cadence converts: 30 fps material on a 24 fps timeline.
  a = mk(0, 100, 0); b = mk(100, 100, 250);
  M.rollEdit(a, b, 80, 24, src, () => 30);
  assert.equal(b.start, 80);
  assert.equal(b.trimIn, 250 - 25);     // 20 timeline frames = 25 source frames
  butted(a, b);
});

test("track blend — stored per track, degrades on junk", () => {
  const t = M.emptyTimeline();
  assert.equal(M.trackBlend(t, 0), "normal");
  assert.equal(M.trackBlend(t, 9), "normal");       // beyond the list
  M.setTrackBlend(t, 2, "difference");
  assert.equal(M.trackBlend(t, 2), "difference");
  assert.equal(M.trackBlend(t, 1), "normal");       // the gap is filled with normal
  assert.equal(t.tracks.length, 3);
  // Survives the round trip, and an unknown name from a hand-edited file degrades.
  assert.equal(M.trackBlend(M.parseTimeline(M.serialiseTimeline(t)), 2), "difference");
  assert.equal(M.trackBlend(M.parseTimeline('{"tracks":[{"blend":"evil"}]}'), 0), "normal");
  assert.equal(M.trackBlend(M.parseTimeline('{"tracks":["junk"]}'), 0), "normal");
  // The blend names must be exactly the canvas composite operations, or the preview
  // would silently fall back to source-over while the backend blends.
  assert.deepEqual(M.BLEND_MODES, ["normal", "screen", "multiply", "difference"]);
});

test("placementFor — append assembles, stack compares", () => {
  const t = M.emptyTimeline();
  const lane = t.clips;
  assert.deepEqual(M.placementFor(t, lane, "append"), { start: 0, track: 0 });
  assert.deepEqual(M.placementFor(t, lane, "stack"), { start: 0, track: 0 });
  lane.push(clip({ start: 0, length: 30, track: 0 }));
  // append: after the previous one, same track.
  assert.deepEqual(M.placementFor(t, lane, "append"), { start: 30, track: 0 });
  // stack: on top, both from frame 0, which is what makes a before/after comparison.
  assert.deepEqual(M.placementFor(t, lane, "stack"), { start: 0, track: 1 });
  lane.push(clip({ start: 0, length: 30, track: 1 }));
  assert.deepEqual(M.placementFor(t, lane, "stack"), { start: 0, track: 2 });
  // append only looks at track 0, so a stacked clip does not push the next append out.
  assert.deepEqual(M.placementFor(t, lane, "append"), { start: 30, track: 0 });
});

test("moveClipToLane — a black-and-white video becomes a mask", () => {
  const t = M.emptyTimeline();
  const c = clip({ id: "vid", src: "video_0", track: 3, start: 10, length: 20 });
  t.clips.push(c);
  M.moveClipToLane(t, c, true);
  assert.equal(t.clips.length, 0);
  assert.deepEqual(t.masks.map((k) => k.id), ["vid"]);
  // Position and trim are kept - only the interpretation changed. The track resets
  // because the mask lane has just the one.
  assert.equal(t.masks[0].start, 10);
  assert.equal(t.masks[0].src, "video_0");
  assert.equal(t.masks[0].track, 0);
  M.moveClipToLane(t, c, false);
  assert.deepEqual(t.clips.map((k) => k.id), ["vid"]);
  assert.equal(t.masks.length, 0);
  // Moving a clip that is not in the source lane must be a no-op, not a duplicate.
  M.moveClipToLane(t, c, false);
  assert.equal(t.clips.length, 1);
});

test("viewWindow — zoom and scroll stay inside the content", () => {
  const ui = { zoom: 1, scroll: 0, playhead: 0 };
  assert.deepEqual(M.viewWindow(ui, 1000), { start: 0, frames: 1000 });
  // Zoom 4 shows a quarter, and scroll picks which quarter.
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4 }, 1000), { start: 0, frames: 250 });
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4, scroll: 500 }, 1000),
    { start: 500, frames: 250 });
  // Scrolling past the end pins to the last full window, never past it.
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4, scroll: 9999 }, 1000),
    { start: 750, frames: 250 });
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4, scroll: -50 }, 1000),
    { start: 0, frames: 250 });
  // Zooming out below "everything fits" is refused, and MAX_ZOOM caps the other end.
  assert.equal(M.viewWindow({ ...ui, zoom: 0.1 }, 1000).frames, 1000);
  assert.equal(M.viewWindow({ ...ui, zoom: 1e9 }, 1000).frames,
    M.viewWindow({ ...ui, zoom: M.MAX_ZOOM }, 1000).frames);
  // Garbage must not produce NaN - the whole coordinate mapping divides by `frames`.
  for (const bad of [NaN, undefined, null, "x"]) {
    const w = M.viewWindow({ zoom: bad, scroll: bad, playhead: 0 }, 1000);
    assert.ok(Number.isFinite(w.start) && Number.isFinite(w.frames) && w.frames > 0);
  }
  // A tiny timeline still yields a usable window rather than collapsing to zero.
  assert.ok(M.viewWindow({ ...ui, zoom: M.MAX_ZOOM }, 10).frames >= 2);
  // The view state goes through `viewState` into node.properties, NOT through the widget
  // JSON: the widget is a node input, so a wheel tick there would cost a full re-render.
  const t = M.emptyTimeline();
  t.ui.zoom = 6; t.ui.scroll = 42;
  assert.deepEqual(M.viewState(t), { zoom: 6, scroll: 42, playhead: 0 });
  const json = JSON.parse(M.serialiseTimeline(t));
  assert.equal(json.ui.zoom, undefined);
  assert.equal(json.ui.scroll, undefined);
  // Still parsed when present, so workflows saved by older versions keep their view.
  assert.equal(M.parseTimeline(JSON.stringify({ ui: { zoom: 6, scroll: 42 } })).ui.zoom, 6);
});

test("mute — per clip, omitted from the JSON when off", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "a", src: "video_0", start: 0, length: 10, muted: true },
            { id: "b", src: "video_1", start: 0, length: 10 }],
    audio: [{ id: "c", src: "audio_0", start: 0, length: 10, muted: true }],
  }));
  assert.equal(t.clips.find((c) => c.id === "a").muted, true);
  assert.equal(t.clips.find((c) => c.id === "b").muted, undefined);
  assert.equal(t.audio[0].muted, true);
  // Survives the round trip, and an unmuted clip carries no key at all.
  const json = JSON.parse(M.serialiseTimeline(t));
  assert.equal(json.clips.find((c) => c.id === "a").muted, true);
  assert.ok(!("muted" in json.clips.find((c) => c.id === "b")));
  assert.equal(json.audio[0].muted, true);
  // A truthy non-boolean from a hand-edited file normalises to true, not to itself.
  assert.equal(M.parseTimeline('{"clips":[{"src":"v","length":1,"muted":"yes"}]}')
    .clips[0].muted, true);
});

test("stack is the default import mode", () => {
  // Layered-by-default: connecting a second video puts it ON TOP, not after.
  assert.equal(M.IMPORT_MODES[0], "stack");
});

test("cropToRange — discards what falls outside in/out", () => {
  const t = M.emptyTimeline();
  t.clips = [
    clip({ id: "before", start: 0, length: 10 }),     // wholly before -> dropped
    clip({ id: "head", start: 5, length: 20 }),       // straddles the in point
    clip({ id: "inside", start: 30, length: 10 }),    // untouched
    clip({ id: "tail", start: 45, length: 20 }),      // straddles the out point
    clip({ id: "after", start: 90, length: 10 }),     // wholly after -> dropped
  ];
  t.masks = [clip({ id: "m", src: "mask_0", start: 0, length: 5 })];
  t.audio = [{ id: "a", src: "audio_0", start: 40, trimIn: 0, length: 40, gain: 1 }];

  const changed = M.cropToRange(t, 10, 60, 24, () => 24);
  assert.equal(changed, true);
  assert.deepEqual(t.clips.map((c) => c.id), ["head", "inside", "tail"]);
  // Nothing may stick out of the range afterwards, in ANY lane.
  for (const lane of [t.clips, t.masks, t.audio]) {
    for (const c of lane) {
      assert.ok(c.start >= 10, `${c.id} starts at ${c.start}`);
      assert.ok(c.start + c.length <= 60, `${c.id} ends at ${c.start + c.length}`);
    }
  }
  // The head cut advances trimIn, so the content does not slide under the cut.
  const head = t.clips.find((c) => c.id === "head");
  assert.equal(head.start, 10);
  assert.equal(head.trimIn, 5);          // 5 frames were cut off the front
  assert.equal(head.length, 15);
  // The tail cut only shortens.
  const tail = t.clips.find((c) => c.id === "tail");
  assert.equal(tail.start, 45);
  assert.equal(tail.trimIn, 0);
  assert.equal(tail.length, 15);
  // An untouched clip is left exactly alone.
  assert.deepEqual(t.clips.find((c) => c.id === "inside"),
    { id: "inside", src: "video_0", track: 0, start: 30, trimIn: 0, length: 10 });
  // Every lane is cropped, not just the picture.
  assert.equal(t.masks.length, 0);
  assert.equal(t.audio[0].length, 20);   // 40..80 clipped to 40..60

  // A second pass changes nothing and reports so, so the button leaves no empty undo.
  assert.equal(M.cropToRange(t, 10, 60, 24, () => 24), false);
});

test("cropToRange — a 30 fps source cuts at its own cadence", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "v", start: 0, trimIn: 0, length: 40 })];
  // 10 timeline frames cut at 24 fps == 12.5 source frames at 30 fps.
  M.cropToRange(t, 10, 40, 24, () => 30);
  assert.equal(t.clips[0].start, 10);
  assert.equal(t.clips[0].trimIn, 13);
  assert.equal(t.clips[0].length, 30);
});

test("slotInUse — a reinterpreted clip must not be re-added as a video", () => {
  // The exact regression: a video moved to the mask lane looks "unplaced" to a per-lane
  // check, so the next slot sync adds it back to the picture lane and the same source
  // ends up in both - the reinterpretation undoing itself on every refresh.
  const t = M.emptyTimeline();
  const c = clip({ id: "v", src: "video_0", start: 0, length: 20 });
  t.clips.push(c);
  assert.equal(M.slotInUse(t, "video_0"), true);
  assert.equal(M.slotInUse(t, "video_1"), false);

  M.moveClipToLane(t, c, true);            // "Interpret as mask"
  assert.equal(t.clips.length, 0);
  assert.equal(M.slotInUse(t, "video_0"), true, "still placed, just in another lane");

  // Audio counts too, so an audio slot is not duplicated either.
  t.audio.push({ id: "a", src: "audio_0", start: 0, trimIn: 0, length: 10, gain: 1 });
  assert.equal(M.slotInUse(t, "audio_0"), true);
  // And a slot nobody references stays free, so real new connections still land.
  assert.equal(M.slotInUse(t, "mask_3"), false);
});

test("trimToPlayhead — Q and E bring an edge to the playhead", () => {
  const mk = () => {
    const t = M.emptyTimeline();
    t.clips = [clip({ id: "v", src: "media_0", start: 0, length: 100 })];
    t.audio = [{ id: "a", src: "media_1", start: 0, trimIn: 0, length: 200, gain: 1 }];
    return t;
  };
  const rate = () => 24;

  // E (end): the tail comes back to the playhead. Nothing else moves.
  let t = mk();
  assert.equal(M.trimToPlayhead(t, 40, "end", 24, rate), true);
  assert.equal(t.clips[0].start, 0);
  assert.equal(t.clips[0].length, 40);
  assert.equal(t.audio[0].length, 40);          // every lane, so a cut is straight across

  // Q (start): the head comes forward AND trimIn advances, so the content does not slide.
  t = mk();
  assert.equal(M.trimToPlayhead(t, 30, "start", 24, rate), true);
  assert.equal(t.clips[0].start, 30);
  assert.equal(t.clips[0].trimIn, 30);
  assert.equal(t.clips[0].start + t.clips[0].length, 100);   // the tail stays put

  // Only ever shortens: a playhead outside the clip is a no-op, so the button leaves no
  // empty undo and a clip can never be stretched by accident.
  t = mk();
  assert.equal(M.trimToPlayhead(t, 500, "start", 24, rate), false);
  assert.equal(M.trimToPlayhead(t, 0, "start", 24, rate), false);   // exactly on the edge
  assert.equal(t.clips[0].length, 100);

  // A selection restricts it: press E with only the audio picked and the video is spared.
  t = mk();
  assert.equal(M.trimToPlayhead(t, 50, "end", 24, rate, new Set(["a"])), true);
  assert.equal(t.audio[0].length, 50);
  assert.equal(t.clips[0].length, 100);

  // A 30 fps source advances its trim at its own cadence.
  t = mk();
  M.trimToPlayhead(t, 10, "start", 24, () => 30);
  assert.equal(t.clips[0].trimIn, 13);
});

test("nativeFpsFor — only where core documents it", () => {
  // Backed by ComfyUI core, each cited in the source:
  assert.equal(M.nativeFpsFor("Wan (4n+1)"), 16);          // nodes_wan.py:526
  assert.equal(M.nativeFpsFor("LTX (8n+1)"), 25);          // nodes_lt.py:549
  assert.equal(M.nativeFpsFor("MiniMax H3 (17n+5)"), 24);  // nodes_minimax_h3.py:29
  // NOT documented anywhere in the repo: these must stay null rather than carry a guess,
  // or the node would warn confidently about a rate nobody verified.
  assert.equal(M.nativeFpsFor("Hunyuan (4n+1)"), null);
  assert.equal(M.nativeFpsFor("Cosmos (8n+1)"), null);
  assert.equal(M.nativeFpsFor("Mochi (6n+1)"), null);
  assert.equal(M.nativeFpsFor("free"), null);
  assert.equal(M.nativeFpsFor("custom (multiple of N)"), null);
  // Every preset carrying a rate must still be a real preset with a real grid.
  for (const mode of Object.keys(M.QUANTIZE_NATIVE_FPS)) {
    assert.ok(M.QUANTIZE_MODES.includes(mode), `${mode} is not a preset`);
    assert.ok(M.quantizeGrid(mode), `${mode} has no grid`);
  }
});

test("clampClipsToSources — a swapped source pulls its clips back in", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "long", src: "media_0", start: 0, trimIn: 0, length: 300 })];
  t.audio = [{ id: "a", src: "media_1", start: 0, trimIn: 0, length: 4000, gain: 1 }];

  // The three-minute track became ten seconds: clips come back inside it.
  const frames = { media_0: 120, media_1: 240 };
  assert.equal(M.clampClipsToSources(t, 24,
    (c) => frames[c.src] ?? null, () => 24), true);
  assert.equal(t.clips[0].length, 120);
  assert.equal(t.audio[0].length, 240);

  // Idempotent: a second pass reports no change, so the button leaves no empty undo.
  assert.equal(M.clampClipsToSources(t, 24, (c) => frames[c.src] ?? null, () => 24), false);

  // It only ever SHORTENS - a source that got longer must not undo a deliberate trim.
  assert.equal(M.clampClipsToSources(t, 24, () => 9999, () => 24), false);
  assert.equal(t.clips[0].length, 120);

  // A trim now past the end of the new material resets rather than reading nothing.
  const t2 = M.emptyTimeline();
  t2.clips = [clip({ id: "c", src: "media_0", start: 0, trimIn: 500, length: 50 })];
  assert.equal(M.clampClipsToSources(t2, 24, () => 100, () => 24), true);
  assert.equal(t2.clips[0].trimIn, 0);
  assert.equal(t2.clips[0].length, 50);

  // Unknown length (a tensor source) is left completely alone.
  const t3 = M.emptyTimeline();
  t3.clips = [clip({ id: "c", src: "media_0", length: 999 })];
  assert.equal(M.clampClipsToSources(t3, 24, () => null, () => 24), false);
  assert.equal(t3.clips[0].length, 999);

  // Rate conversion: 120 source frames at 30 fps are only 96 frames of a 24 fps line.
  const t4 = M.emptyTimeline();
  t4.clips = [clip({ id: "c", src: "media_0", length: 999 })];
  M.clampClipsToSources(t4, 24, () => 120, () => 30);
  assert.equal(t4.clips[0].length, 96);
});

test("clipExtent — mark clip, from the selection or from the playhead", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "a", start: 10, length: 20 }),          // 10..30
             clip({ id: "b", start: 50, length: 10, track: 1 })];  // 50..60
  t.audio = [{ id: "s", src: "media_1", start: 12, trimIn: 0, length: 25, gain: 1 }];

  // No selection: everything under the playhead. A picture+sound pair cut together gives
  // their shared extent, not whichever was found first.
  assert.deepEqual(M.clipExtent(t, 20), { start: 10, end: 37 });
  // A playhead over a single clip marks just that one.
  assert.deepEqual(M.clipExtent(t, 55), { start: 50, end: 60 });
  // Over a gap there is nothing to mark - and it must not throw or return zeros.
  assert.equal(M.clipExtent(t, 45), null);
  assert.equal(M.clipExtent(M.emptyTimeline(), 0), null);

  // With a selection the playhead is irrelevant: it spans exactly what was picked.
  assert.deepEqual(M.clipExtent(t, 999, new Set(["a"])), { start: 10, end: 30 });
  assert.deepEqual(M.clipExtent(t, 0, new Set(["a", "b"])), { start: 10, end: 60 });
  assert.equal(M.clipExtent(t, 20, new Set(["nope"])), null);

  // The end is exclusive, so a clip at 10 of length 20 ends at 30, not 29.
  const ext = M.clipExtent(t, 20, new Set(["a"]));
  assert.equal(ext.end - ext.start, 20);
});

// ── Freeze-frame markers ──────────────────────────────────────────────────────
// Markers are anchored to the CLIP, so the invariant under test is: an edit that moves
// the clip must not change which PICTURE a marker sits on.

test("markers survive a round trip and stay sorted, unique and in range", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "a", src: "media_0", start: 100, length: 10,
              markers: [7, 3, 3, -1, 10, 99] }],
  }));
  assert.deepEqual(t.clips[0].markers, [3, 7]);        // dupes, negatives and >= length go
  assert.deepEqual(M.parseTimeline(M.serialiseTimeline(t)).clips[0].markers, [3, 7]);
});

test("a clip with no markers keeps them out of the JSON", () => {
  const t = M.parseTimeline(JSON.stringify({ clips: [{ src: "media_0", length: 5 }] }));
  assert.equal("markers" in t.clips[0], false);
  assert.equal(M.serialiseTimeline(t).includes("markers"), false);
});

test("toggleMarker adds, removes, and refuses frames off the clip", () => {
  const c = clip({ start: 100, length: 10 });
  assert.equal(M.toggleMarker(c, 103), true);
  assert.deepEqual(c.markers, [3]);
  assert.equal(M.toggleMarker(c, 105), true);
  assert.deepEqual(c.markers, [3, 5]);
  assert.equal(M.toggleMarker(c, 103), true);          // same frame again: lifts it
  assert.deepEqual(c.markers, [5]);
  assert.equal(M.toggleMarker(c, 99), false);          // before the clip
  assert.equal(M.toggleMarker(c, 110), false);         // one past the end
  assert.deepEqual(c.markers, [5]);
});

test("moving a clip carries its markers to the new absolute frames", () => {
  const t = M.emptyTimeline();
  const c = clip({ start: 100, length: 10, markers: [3] });
  t.clips.push(c);
  assert.deepEqual(M.markerFrames(t), [103]);
  M.moveClip(c, 200, 0);
  assert.deepEqual(M.markerFrames(t), [203]);          // same picture, new position
});

test("trimming the head keeps markers on the same picture", () => {
  const c = clip({ start: 100, length: 10, markers: [2, 6] });
  M.trimStart(c, 104, 24, 24);                         // cut 4 frames off the front
  assert.equal(c.start, 104);
  assert.deepEqual(c.markers, [2]);                    // 6 -> 2, still frame 106; 2 is gone
  assert.deepEqual(M.markerFrames({ clips: [c], masks: [], audio: [] }), [106]);
});

test("trimming the tail drops the markers that went with it", () => {
  const c = clip({ start: 0, length: 10, markers: [2, 8] });
  M.trimEnd(c, 5, 0, 24, 24);
  assert.deepEqual(c.markers, [2]);
});

test("slipping slides markers with the content", () => {
  const c = clip({ start: 0, length: 10, trimIn: 10, markers: [5] });
  M.slipClip(c, 3, 100, 24, 24);                       // content moves 3 frames earlier
  assert.equal(c.trimIn, 13);
  assert.deepEqual(c.markers, [2]);
});

test("markerFrames deduplicates across lanes", () => {
  const t = M.emptyTimeline();
  t.clips.push(clip({ id: "a", start: 0, length: 10, markers: [4] }));
  t.clips.push(clip({ id: "b", track: 1, start: 0, length: 10, markers: [4, 9] }));
  t.masks.push(clip({ id: "c", start: 5, length: 10, markers: [0] }));   // -> frame 5
  assert.deepEqual(M.markerFrames(t), [4, 5, 9]);
});

test("clipBoundFrames walks the clips in editor order - parity with clip_bound_indices", () => {
  const t = M.emptyTimeline();
  // Parse order deliberately NOT start order, and one audioOnly clip in the middle.
  t.clips.push(clip({ id: "b", start: 40, length: 10 }));
  t.clips.push(clip({ id: "hole", track: 1, start: 20, length: 5, audioOnly: true }));
  t.clips.push(clip({ id: "a", start: 0, length: 38 }));
  // Sorted by (start, track), NOT deduplicated, absolute frames: each bound is its own
  // Freeze Frames socket. The same fixture as the Python side, plus the audioOnly hole.
  assert.deepEqual(M.clipBoundFrames(t), [0, 37, 40, 49]);
  // A single-frame clip: in and out are the SAME frame, and both survive.
  const one = M.emptyTimeline();
  one.clips.push(clip({ id: "x", start: 3, length: 1 }));
  assert.deepEqual(M.clipBoundFrames(one), [3, 3]);
});

test("expandClipsToSources - show all the material, without unrolling the world", () => {
  const t = M.emptyTimeline();
  // A clip that landed on a guessed length because its source is a tensor, and a music
  // bed that is deliberately trimmed and must NOT be dragged out with it.
  t.clips = [
    clip({ id: "guess", src: "media_0", start: 0, trimIn: 0, length: 24 }),
    clip({ id: "cut", src: "media_1", track: 1, start: 100, trimIn: 30, length: 10,
           markers: [5] }),
  ];
  t.audio = [{ id: "bed", src: "media_2", start: 0, trimIn: 0, length: 200, gain: 1 }];
  const frames = { media_0: 723, media_1: 240, media_2: 4320 };
  const rate = { media_0: 24, media_1: 30, media_2: 24 };
  // The callbacks take the CLIP now, so the editor can answer per LANE: an audio clip
  // is measured in timeline frames, not in its source's cadence.
  const framesFor = (c) => frames[c.src] ?? null;
  const rateFor = (c) => rate[c.src] ?? 24;

  // With a selection, ONLY the selection moves - the three-minute bed stays put.
  assert.equal(M.expandClipsToSources(t, 24, framesFor, rateFor, new Set(["guess"])), true);
  assert.equal(t.clips[0].length, 723);
  assert.equal(t.clips[1].length, 10, "an unselected clip is untouched");
  assert.equal(t.audio[0].length, 200, "and so is the audio bed");

  // Without one, everything opens up.
  assert.equal(M.expandClipsToSources(t, 24, framesFor, rateFor), true);
  // 240 source frames at 30 are 192 frames of a 24fps timeline.
  assert.equal(t.clips[1].length, 192);
  assert.equal(t.clips[1].trimIn, 0, "the trim is dropped");
  assert.equal(t.clips[1].start, 100, "where a clip SITS is the user's decision");
  assert.deepEqual(t.clips[1].markers, [],
    "dropping a trim slides the picture, so its markers no longer point at it");
  assert.equal(t.audio[0].length, 4320);

  // Idempotent, so the button leaves no empty undo behind.
  assert.equal(M.expandClipsToSources(t, 24, framesFor, rateFor), false);

  // Unknown length (a tensor with no sheet yet) is left completely alone.
  const t2 = M.emptyTimeline();
  t2.clips = [clip({ id: "c", src: "media_9", trimIn: 2, length: 7 })];
  assert.equal(M.expandClipsToSources(t2, 24, () => null, () => 24), false);
  assert.equal(t2.clips[0].length, 7);
  assert.equal(t2.clips[0].trimIn, 2);
});

// ── Level and fades (parity with nkd_timeline.py) ─────────────────────────────

test("clampFades keeps the drawn SHAPE when a clip gets shorter", () => {
  // Transcribed from test_fades_are_clamped_into_the_clip in tests/test_timeline.py.
  // Clamping each ramp to `length` on its own first flattens 3:1 to 1:1 - the bug this
  // pins - so the two are scaled together instead.
  const c = { length: 10, fadeIn: 30, fadeOut: 10 };
  M.clampFades(c);
  assert.ok(c.fadeIn + c.fadeOut <= c.length);
  assert.ok(c.fadeIn > c.fadeOut, "the 3:1 shape did not survive the clamp");
  assert.deepEqual([c.fadeIn, c.fadeOut], [7, 2]);

  // A single ramp longer than the clip is simply capped.
  const one = { length: 10, fadeIn: 30 };
  M.clampFades(one);
  assert.equal(one.fadeIn, 10);
  assert.equal(one.fadeOut, undefined, "a zero fade is deleted, not stored as 0");

  // A zero-length clip cannot carry a ramp, and must not divide by zero either.
  const dead = { length: 0, fadeIn: 5, fadeOut: 5 };
  M.clampFades(dead);
  assert.deepEqual([dead.fadeIn, dead.fadeOut], [undefined, undefined]);
});

test("gainAt is the same curve Python renders", () => {
  // Mirrors clip_gain_ramp in nkd_timeline.py: offset/fadeIn, (length-offset)/fadeOut.
  const c = { length: 100, fadeIn: 10, fadeOut: 10 };
  assert.equal(M.gainAt(c, 0), 0);
  assert.ok(Math.abs(M.gainAt(c, 5) - 0.5) < 1e-9);
  assert.equal(M.gainAt(c, 10), 1);
  assert.equal(M.gainAt(c, 50), 1);
  assert.ok(Math.abs(M.gainAt(c, 95) - 0.5) < 1e-9);
  // Gain scales the ramp rather than replacing it.
  assert.ok(Math.abs(M.gainAt({ ...c, gain: 0.5 }, 5) - 0.25) < 1e-9);
  // Muted wins over everything, and off the clip is silence.
  assert.equal(M.gainAt({ ...c, muted: true }, 50), 0);
  assert.equal(M.gainAt(c, -1), 0);
  assert.equal(M.gainAt(c, 100), 0);
  // No fades: flat at the clip's level, which is what every existing workflow gets.
  assert.equal(M.gainAt({ length: 100 }, 50), 1);
  assert.equal(M.gainAt({ length: 100, gain: 0.3 }, 50), 0.3);
});

test("fades survive a round trip, and absent ones stay absent", () => {
  // A workflow saved before fades existed must come back byte-identical.
  // playhead is no longer in ui (it lives in node.properties now).
  const plain = '{"v":1,'
    + '"clips":[{"id":"a","src":"m","track":0,"start":0,"trimIn":0,"length":10}],'
    + '"masks":[],"tracks":[],"audio":[],"ui":{}}';
  assert.equal(M.serialiseTimeline(M.parseTimeline(plain)), plain);

  const tl = M.parseTimeline(JSON.stringify({
    clips: [{ id: "a", src: "m", track: 0, start: 0, trimIn: 0, length: 48,
              gain: 0.5, fadeIn: 12, fadeOut: 6 }],
  }));
  assert.deepEqual(
    [tl.clips[0].gain, tl.clips[0].fadeIn, tl.clips[0].fadeOut], [0.5, 12, 6]);
  const back = JSON.parse(M.serialiseTimeline(tl)).clips[0];
  assert.deepEqual([back.gain, back.fadeIn, back.fadeOut], [0.5, 12, 6]);
});

test("blading a clip leaves each half the ramp it still has", () => {
  const c = { id: "a", src: "m", track: 0, start: 0, trimIn: 0, length: 100,
              fadeIn: 10, fadeOut: 10 };
  const right = M.splitClip(c, 50, 24, 24);
  assert.equal(c.fadeIn, 10, "the left half keeps its fade-in");
  assert.equal(right.fadeOut, 10, "the right half keeps its fade-out");
  // Both halves are still 50 long, so both ramps fit and neither is scaled away.
  assert.equal(c.fadeOut, 10);
  assert.equal(right.fadeIn, 10);

  // Blading INSIDE a fade-out shrinks it to what is left rather than leaving both
  // halves ramping down.
  const d = { id: "b", src: "m", track: 0, start: 0, trimIn: 0, length: 100, fadeOut: 80 };
  const r2 = M.splitClip(d, 30, 24, 24);
  assert.ok(d.fadeOut <= d.length, `left fadeOut ${d.fadeOut} > length ${d.length}`);
  assert.ok(r2.fadeOut <= r2.length);
});

test("levelStops: a fade IN rises and a fade OUT falls", () => {
  // The direction this editor already got backwards once: the first version drew the
  // ATTENUATION, so a fade in sloped downwards. HEIGHT IS LEVEL, so the numbers must rise.
  const rise = M.levelStops({ length: 100, fadeIn: 20 });
  assert.equal(rise[0][0], 0, "starts at the head");
  assert.equal(rise[0][1], 0, "a fade in starts at SILENCE");
  assert.equal(rise[rise.length - 1][1], 1, "and reaches full level");
  for (let i = 1; i < rise.length; i++) {
    assert.ok(rise[i][1] >= rise[i - 1][1], `fade in dipped at stop ${i}`);
  }
  // The knee is exactly where the ramp was set, not a pixel off.
  assert.deepEqual(rise.find((p) => p[1] === 1), [20, 1]);

  const fall = M.levelStops({ length: 100, fadeOut: 20 });
  assert.equal(fall[0][1], 1, "a fade out starts at full level");
  assert.ok(fall[fall.length - 1][1] < 0.001, "and ends at silence");
  for (let i = 1; i < fall.length; i++) {
    assert.ok(fall[i][1] <= fall[i - 1][1], `fade out rose at stop ${i}`);
  }

  // Both: up, flat, down. Three distinct levels in that order.
  const both = M.levelStops({ length: 100, fadeIn: 10, fadeOut: 10 });
  assert.equal(both[0][1], 0);
  assert.equal(both[1][1], 1);
  assert.ok(both[both.length - 1][1] < 0.001);
});

test("levelStops: the plateau is the volume line, and it carries the gain", () => {
  // No fades: a flat line at the clip's level from end to end. That flat line is what the
  // volume drag grabs, so it has to exist even when nothing has been faded.
  const flat = M.levelStops({ length: 100, gain: 0.5 });
  assert.equal(flat.length, 2, "one segment, two ends");
  assert.deepEqual(flat.map((p) => p[1]), [0.5, 0.5]);
  assert.equal(flat[0][0], 0);
  assert.ok(flat[1][0] > 99.9 && flat[1][0] <= 100, "spans the whole clip");

  // Gain scales the ramps rather than replacing them.
  const ramped = M.levelStops({ length: 100, fadeIn: 20, gain: 0.5 });
  assert.equal(ramped[0][1], 0);
  assert.equal(ramped.find((p) => p[0] === 20)[1], 0.5);

  // Muted is flat on the floor - not "no line", which would read as untouched.
  assert.deepEqual(M.levelStops({ length: 10, muted: true }).map((p) => p[1]), [0, 0]);
});

test("levelStops: never ends on a false cliff, and survives a degenerate clip", () => {
  // `gainAt` reports silence past the end, so asking at exactly `length` would end every
  // polyline with a drop to the floor that no fade asked for.
  const flat = M.levelStops({ length: 50 });
  assert.equal(flat[flat.length - 1][1], 1, "unity clip ended at silence");
  for (const c of [{ length: 0 }, { length: 0, fadeIn: 5, fadeOut: 5 }]) {
    const s = M.levelStops(c);
    assert.ok(s.length >= 1);
    for (const [off, lvl] of s) {
      assert.ok(Number.isFinite(off) && Number.isFinite(lvl), "NaN in the polyline");
    }
  }
});

test("snapGainToDb: the detents are 3 dB apart, and they can reach silence", () => {
  const db = (g) => 20 * Math.log10(g);
  // Every result sits on a multiple of 3 dB - the whole point of the detent.
  for (const g of [0.31, 0.42, 0.55, 0.68, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0]) {
    const s = M.snapGainToDb(g);
    assert.ok(Math.abs(db(s) - Math.round(db(s) / 3) * 3) < 1e-9,
      `${g} -> ${s} (${db(s).toFixed(2)} dB) is not on a 3 dB step`);
    // And it is the NEAREST one: never more than half a step away.
    assert.ok(Math.abs(db(s) - db(g)) <= 1.5 + 1e-9, `${g} snapped too far`);
  }
  // Unity is a detent, so the drag can be put back to "untouched" exactly.
  assert.equal(M.snapGainToDb(1), 1);
  assert.equal(M.snapGainToDb(0.99), 1);
  assert.equal(M.snapGainToDb(1.02), 1);
  // -6 dB is a round amplitude, which makes it the easiest one to check by eye.
  assert.ok(Math.abs(M.snapGainToDb(0.52) - 0.5011872) < 1e-6);

  // Snapping in dB steps towards -inf forever, so it could never reach a true mute on its
  // own: below the floor the next detent IS silence.
  assert.equal(M.snapGainToDb(0.02), 0);
  assert.equal(M.snapGainToDb(0), 0);
  assert.equal(M.snapGainToDb(-1), 0);
  assert.ok(M.snapGainToDb(0.04) > 0, "the floor swallowed a level that is still audible");

  // Never past the ceiling the model allows, however hard the drag pushes.
  assert.ok(M.snapGainToDb(99) <= 2);
  assert.ok(M.snapGainToDb(2) <= 2);
});

test("un clip del carril de audio no se mide en frames de la FUENTE", () => {
  // El bug real (2026-08-14): dejar entrar VÍDEO en el carril de audio hizo que el probe
  // empezara a devolver un frame rate para esas fuentes, y todas las conversiones
  // timeline<->fuente se lo creyeron. Un clip de audio recorta en frames de TIMELINE.
  //
  // Aquí se reconstruye el comportamiento roto — pasarle la cadencia de la FUENTE — y se
  // exige que dé mal, para que el test no pueda pasar por casualidad.
  const audio = () => ({
    id: "a", src: "media_0", track: 0, start: 0, trimIn: 0, length: 240, gain: 1,
  });
  const SRC_FPS = 16;     // un vídeo de IA típico
  const TL_FPS = 24;

  // ROTO: con la cadencia de la fuente, la mitad derecha apunta al sitio equivocado.
  const bad = audio();
  const badRight = M.splitClip(bad, 120, SRC_FPS, TL_FPS);
  assert.notEqual(badRight.trimIn, 120, "el bug ya no se reproduce; revisa el test");
  assert.equal(badRight.trimIn, 80);

  // BIEN: en el carril de audio la cadencia ES la de la línea de tiempo, así que el corte
  // en el frame 120 empieza en el frame 120 del sonido. Ni antes ni después.
  const good = audio();
  const right = M.splitClip(good, 120, TL_FPS, TL_FPS);
  assert.equal(right.trimIn, 120);
  assert.equal(good.length, 120);
  assert.equal(right.length, 120);
  // Y las dos mitades juntas siguen cubriendo exactamente el material original.
  assert.equal(good.length + right.length, 240);
});

test("clampClipsToSources mide cada clip contra SU material", () => {
  // El otro síntoma del mismo fallo. Escenario real: un vídeo de 11 s a 16 fps sobre una
  // timeline a 24. Su SONIDO dura 264 frames de timeline, pero su IMAGEN son 176 frames.
  // Cortando por el frame 200, la mitad derecha tiene trimIn 200 - que comparado contra
  // los 176 del vídeo parece "más allá del final", y el trim se RESETEABA A CERO: el
  // audio volvía al principio del fichero.
  const clip = () => JSON.stringify({
    audio: [{ id: "b", src: "media_0", track: 0, start: 200, trimIn: 200,
              length: 64, gain: 1 }],
  });

  // ROTO: medido contra la imagen (176 frames) y en cadencia de la fuente (16 fps).
  const bad = M.parseTimeline(clip());
  M.clampClipsToSources(bad, 24, () => 176, () => 16);
  assert.equal(bad.audio[0].trimIn, 0, "el bug ya no se reproduce; revisa el test");

  // BIEN: medido contra el SONIDO (264 frames de timeline) y en cadencia de timeline, el
  // clip cabe entero en su material y nadie lo toca.
  const ok = M.parseTimeline(clip());
  const changed = M.clampClipsToSources(ok, 24, () => 264, () => 24);
  assert.equal(changed, false, "tocó un clip que cabía de sobra");
  assert.equal(ok.audio[0].trimIn, 200);
  assert.equal(ok.audio[0].length, 64);
});
