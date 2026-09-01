"""Checks for the non-trivial logic in NKD Timeline.

Covers what breaks silently: frame resampling when the rates differ, model
quantisation, and the arithmetic of the audio mix. No frameworks - plain `assert`
and a `__main__`.

    python tests/test_timeline.py
"""

import os
import sys

_PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PACK)
# The node imports folder_paths / comfy.utils from core: custom_nodes/<pack>/ -> ComfyUI/
sys.path.insert(0, os.path.dirname(os.path.dirname(_PACK)))

from fractions import Fraction  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

from comfy_api.latest import Types  # noqa: E402

from nkd_timeline import (  # noqa: E402
    ASPECT_MODES, BLEND_MODES, QUANTIZE_MODES, NKDTimeline, _to_mask, _to_rgb,
    blend_pixels, resolve_resolution,
    build_sources, classify,
    AudioEnv, audio_env, clip_gain_ramp,
    clip_bound_indices, fit_frames, gather_window, marker_indices, mix_audio,
    muted_rows, rows_to_ranges,
    parse_frame_list,
    parse_timeline, quantize_count, quantize_stops,
    source_frame, source_meta, timeline_span, track_blend,
)

WAN = "Wan (4n+1)"
LTX = "LTX (8n+1)"
MOCHI = "Mochi (6n+1)"
MINIMAX = "MiniMax H3 (17n+5)"
CUSTOM = "custom (multiple of N)"


def outs(r):
    """The result tuple keyed by the schema's OUTPUT NAMES.

    Indexing by number is what let a whole reorder of the sockets slip past these tests -
    every assertion still passed while pointing at a different value. The names are the
    contract. It also pins the two lists to the same length, which is the classic way this
    node breaks: the runtime hands out the tuple by slot number, so one missing element
    silently shifts every socket after it.
    """
    names = [o.display_name for o in NKDTimeline.define_schema().outputs]
    assert len(names) == len(r.result), (len(names), len(r.result))
    return dict(zip(names, r.result))


def test_quantize():
    # Presets are named after model families; the combo value is what reaches the backend.
    assert QUANTIZE_MODES == ["free", WAN, "Hunyuan (4n+1)", LTX, "Cosmos (8n+1)",
                              MOCHI, MINIMAX, CUSTOM]

    # 8n+1 stops are 9, 17, 25, 33... Rounds down.
    assert quantize_count(33, LTX) == 33
    assert quantize_count(40, LTX) == 33
    assert quantize_count(41, LTX) == 41
    # 4n+1: 5, 9, 13...
    assert quantize_count(16, WAN) == 13
    assert quantize_count(13, WAN) == 13
    # 6n+1: 7, 13, 19...
    assert quantize_count(20, MOCHI) == 19
    assert quantize_count(7, MOCHI) == 7
    # MiniMax H3 is NOT an Nn+1 family: 5, 22, 39, 56... (124 is the node's own default)
    # MiniMax H3 rounds the OTHER WAY, because the model does: `align_frame_count`
    # walks up until n % 17 == 5, while the Nn+1 families floor their latent count.
    assert quantize_count(124, MINIMAX) == 124
    assert quantize_count(130, MINIMAX) == 141
    assert quantize_count(22, MINIMAX) == 22
    assert quantize_count(17, MINIMAX) == 22
    assert quantize_count(20, MINIMAX) == 22

    # Cross-checked against the real thing, not against our reading of it.
    def align_frame_count(n):          # comfy_extras/nodes_minimax_h3.py:34, verbatim
        while n % 17 != 5:
            n += 1
        return n

    for n in range(6, 200):
        assert quantize_count(n, MINIMAX) == align_frame_count(n), n
    for mode, step in ((LTX, 8), (WAN, 4), (MOCHI, 6)):
        for n in range(step + 2, 200):
            core = ((n - 1) // step) * step + 1     # nodes_wan.py:44 and friends
            assert quantize_count(n, mode) == core, (mode, n)
    assert quantize_count(21, MINIMAX) == 22
    assert quantize_count(4, MINIMAX) == 5
    # Never below the first valid stop, not even for absurd input.
    assert quantize_count(1, LTX) == 9
    assert quantize_count(3, WAN) == 5
    # And never 0 when something was asked for - that would blow up the sampler.
    for mode in (WAN, LTX, MOCHI, MINIMAX):
        for n in range(1, 300):
            assert quantize_count(n, mode) >= 5, (mode, n)
    assert quantize_count(0, LTX) == 0             # empty stays empty
    assert quantize_count(100, "free") == 100
    assert quantize_count(100, CUSTOM, 16) == 96
    assert quantize_count(5, CUSTOM, 16) == 16     # never below the step
    # An unknown mode degrades to no snapping rather than to 0.
    assert quantize_count(37, "something else") == 37


def test_quantize_stops_are_fixed_points():
    """Every stop painted on the ruler must survive quantize_count unchanged, or the
    editor would show an end point the backend then silently moves."""
    for mode in (WAN, LTX, MOCHI, MINIMAX):
        stops = quantize_stops(200, mode)
        assert stops, mode
        for s in stops:
            assert quantize_count(s, mode) == s, (mode, s)
    assert quantize_stops(45, MINIMAX) == [5, 22, 39]
    assert quantize_stops(30, LTX) == [9, 17, 25]
    assert quantize_stops(100, "free") == []


def test_minimax_matches_core():
    """comfy_extras/nodes_minimax_h3.py:33 walks UP until n % 17 == 5. We round DOWN, so
    every stop we produce must be a fixed point of that same function."""
    def align_up(n):
        while n % 17 != 5:
            n += 1
        return n

    for s in quantize_stops(400, MINIMAX):
        assert align_up(s) == s, s


def test_source_frame_resample():
    clip = {"start": 10, "trimIn": 5, "length": 100}
    # Same cadence: one-to-one offset from trimIn.
    assert source_frame(clip, 10, 24.0, 24.0) == 5
    assert source_frame(clip, 34, 24.0, 24.0) == 29
    # 30 fps source, 24 fps timeline: the source runs faster (frames get dropped).
    assert source_frame(clip, 10, 30.0, 24.0) == 5
    assert source_frame(clip, 34, 30.0, 24.0) == 5 + 30   # 24 frames x 30/24
    # 24 fps source, 30 fps timeline: the source runs slower (frames repeat).
    assert source_frame(clip, 40, 24.0, 30.0) == 5 + 24   # 30 frames x 24/30
    # An invalid fps must neither throw nor return nonsense.
    assert source_frame(clip, 50, 24.0, 0.0) == 5


def test_parse_defensive():
    # Garbage -> empty timeline, never an exception.
    empty = {"clips": [], "masks": [], "audio": [], "tracks": [], "playhead": 0}
    for junk in ("", None, "{{{", "[]", '{"clips": "nope"}', 42):
        assert parse_timeline(junk) == empty
    tl = parse_timeline('{"clips":['
                        '{"src":"video_1","track":2,"start":10,"trimIn":3,"length":20},'
                        '{"src":"video_0","track":0,"start":0,"length":30},'
                        '{"src":"video_9","length":0},'          # zero length -> dropped
                        '{"track":1,"length":5}],'               # no src -> dropped
                        '"audio":[{"src":"audio_0","start":0,"length":50,"gain":0.5}],'
                        '"ui":{"playhead":12}}')
    assert len(tl["clips"]) == 2
    # Sorted by track: the higher one comes last, so it overwrites when drawn.
    assert [c["src"] for c in tl["clips"]] == ["video_0", "video_1"]
    assert tl["clips"][1]["trimIn"] == 3
    assert tl["audio"][0]["gain"] == 0.5
    assert tl["playhead"] == 12
    assert timeline_span(tl["clips"], tl["masks"], tl["audio"]) == 50


def test_image_and_mask_sources():
    """An IMAGE batch is a frame sequence and a MASK is a batch of them, so both ride the
    timeline like a video. Tensor sources have no intrinsic rate: they run 1:1 with the
    timeline."""
    imgs = torch.rand((10, 8, 16, 3))
    msks = torch.rand((10, 8, 16))
    sources, audio_sources = build_sources({"image_0": imgs, "mask_0": msks})
    assert sources["image_0"][0] == "image"
    assert sources["mask_0"][0] == "mask"
    assert audio_sources == {}
    assert source_meta("image", imgs, 24.0) == (24.0, 10)   # 1:1 with the timeline
    assert source_meta("mask", msks, 30.0) == (30.0, 10)

    clip = {"src": "image_0", "track": 0, "start": 5, "trimIn": 2, "length": 6}
    frames, audio = gather_window("image", imgs, clip, 5, 11, 24.0)
    assert audio is None                       # a tensor batch carries no audio
    assert frames.shape == (6, 8, 16, 3)
    assert torch.equal(frames[0], imgs[2])     # honours trimIn
    assert torch.equal(frames[3], imgs[5])

    # Reading past the end clamps to the last frame rather than throwing.
    long_clip = {"src": "image_0", "track": 0, "start": 0, "trimIn": 0, "length": 40}
    tail, _ = gather_window("image", imgs, long_clip, 0, 40, 24.0)
    assert tail.shape[0] == 40
    assert torch.equal(tail[-1], imgs[-1])

    # An empty or inverted range yields nothing instead of a malformed tensor.
    assert gather_window("image", imgs, clip, 5, 5, 24.0) == (None, None)


def test_mask_and_rgb_conversion():
    # A mask [N,H,W] shown as a picture becomes grey; the rank comes back correctly.
    m = torch.rand((3, 4, 5))
    rgb = _to_rgb(m)
    assert rgb.shape == (3, 4, 5, 3)
    assert torch.equal(rgb[..., 0], m) and torch.equal(rgb[..., 2], m)
    # A picture read as a mask becomes Rec.709 luma - that is "use this video as a mask".
    white = torch.ones((2, 4, 5, 3))
    assert torch.allclose(_to_mask(white), torch.ones((2, 4, 5)))
    red = torch.zeros((1, 2, 2, 3))
    red[..., 0] = 1.0
    assert torch.allclose(_to_mask(red), torch.full((1, 2, 2), 0.2126))
    # A real mask passes through untouched, and RGBA drops its alpha.
    assert torch.equal(_to_mask(m), m)
    assert _to_rgb(torch.rand((2, 4, 5, 4))).shape == (2, 4, 5, 3)
    # fit_frames keeps a mask a mask.
    assert fit_frames(torch.rand((2, 10, 20)), 8, 8, "contain").shape == (2, 8, 8)


def test_fit_frames():
    src = torch.rand((3, 100, 200, 3))          # 2:1
    for mode in ("contain", "cover", "stretch"):
        out = fit_frames(src, 64, 64, mode)
        assert out.shape == (3, 64, 64, 3), mode
        assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0, mode
    # contain preserves the aspect ratio -> black bars top and bottom.
    contained = fit_frames(torch.ones((1, 100, 200, 3)), 64, 64, "contain")
    assert float(contained[0, 0, 32, 0]) == 0.0    # top edge, padding
    assert float(contained[0, 32, 32, 0]) == 1.0   # centre, image
    # Already matching: passes through untouched (no needless resample). Masks too - the
    # early-out sits BEFORE the 3-channel expansion, which is a 3x copy for nothing.
    same = torch.rand((2, 32, 32, 3))
    assert fit_frames(same, 32, 32, "contain") is same
    same_mask = torch.rand((2, 32, 32))
    assert fit_frames(same_mask, 32, 32, "contain") is same_mask

    # `cover` fills the frame from the CENTRE of the source: a 2:1 image squeezed into a
    # square keeps the middle half and loses the sides. Hand-cropping before the resize
    # replaced common_upscale's own "center" crop, so pin the geometry down.
    wide = torch.zeros((1, 100, 200, 3))
    wide[:, :, 50:150, :] = 1.0                 # exactly the central square
    covered = fit_frames(wide, 64, 64, "cover")
    assert covered.shape == (1, 64, 64, 3)
    assert float(covered.min()) > 0.99, "the cropped-away sides must not survive"

    tall = torch.zeros((1, 200, 100, 3))        # the other axis
    tall[:, 50:150, :, :] = 1.0
    assert float(fit_frames(tall, 64, 64, "cover").min()) > 0.99

    # A large reduction takes the `area` path and a small one takes bicubic; both must
    # still land on the requested size and stay in range.
    for src_wh, dst in (((3, 2160, 3840, 3), (832, 480)), ((3, 520, 900, 3), (832, 480))):
        out = fit_frames(torch.rand(src_wh), dst[0], dst[1], "stretch")
        assert out.shape == (3, dst[1], dst[0], 3)
        assert 0.0 <= float(out.min()) and float(out.max()) <= 1.0


def test_mix_audio():
    sr = 100
    ones = torch.ones((1, 50))                  # mono, 0.5 s
    # Placed at offset 20, no trim.
    out = mix_audio([(ones, sr, 20, 0, 1.0)], 100, sr)
    assert out.shape == (1, 2, 100)
    assert float(out[0, 0, 19]) == 0.0          # before the segment: silence
    assert float(out[0, 0, 20]) == 1.0          # mono duplicated to stereo
    assert float(out[0, 1, 20]) == 1.0
    assert float(out[0, 0, 69]) == 1.0
    assert float(out[0, 0, 70]) == 0.0          # after: silence again
    # Additive and clamped to [-1,1]: two full-scale segments must not overflow.
    both = mix_audio([(ones, sr, 0, 0, 1.0), (ones, sr, 0, 0, 1.0)], 50, sr)
    assert float(both[0, 0, 0]) == 1.0
    # Gain is applied.
    quiet = mix_audio([(ones, sr, 0, 0, 0.25)], 50, sr)
    assert abs(float(quiet[0, 0, 0]) - 0.25) < 1e-6
    # Trim discards the head of the segment.
    ramp = torch.arange(50, dtype=torch.float32).unsqueeze(0) / 100.0
    trimmed = mix_audio([(ramp, sr, 0, 10, 1.0)], 50, sr)
    assert abs(float(trimmed[0, 0, 0]) - 0.10) < 1e-6
    # A segment running off the end is clipped rather than crashing.
    assert mix_audio([(ones, sr, 80, 0, 1.0)], 100, sr).shape == (1, 2, 100)
    # And a negative offset is clipped from the front.
    assert float(mix_audio([(ones, sr, -10, 0, 1.0)], 100, sr)[0, 0, 0]) == 1.0
    # Resampling: half the sample rate -> twice the samples occupied.
    up = mix_audio([(ones, 50, 0, 0, 1.0)], 200, 100)
    assert float(up[0, 0, 99]) == 1.0
    assert float(up[0, 0, 150]) == 0.0


def test_audio_length_matches_frames():
    """Audio length must be exactly frames/fps * sample_rate: drift here makes
    picture and sound separate progressively."""
    for fps, count, sr in ((24.0, 97, 44100), (30.0, 120, 48000), (12.5, 25, 22050)):
        total = int(round(count / fps * sr))
        assert mix_audio([], total, sr).shape == (1, 2, total)


def test_blend_modes():
    """Stacking a before and an after and reading the difference is a main reason this
    node has tracks, so the maths has to be the real thing, not an approximation."""
    assert BLEND_MODES == ["normal", "screen", "multiply", "difference"]
    base = torch.tensor([[0.0, 0.5, 1.0]])
    top = torch.tensor([[0.25, 0.5, 0.25]])
    assert torch.allclose(blend_pixels(base, top, "normal"), top)
    assert torch.allclose(blend_pixels(base, top, "multiply"),
                          torch.tensor([[0.0, 0.25, 0.25]]))
    # screen: 1-(1-a)(1-b)
    assert torch.allclose(blend_pixels(base, top, "screen"),
                          torch.tensor([[0.25, 0.75, 1.0]]))
    assert torch.allclose(blend_pixels(base, top, "difference"),
                          torch.tensor([[0.25, 0.0, 0.75]]))
    # Identical layers under difference must be exactly black - that is the whole point.
    same = torch.rand((4, 4, 3))
    assert float(blend_pixels(same, same, "difference").abs().max()) == 0.0
    # An unknown mode must fall back to plain overwrite, never to something destructive.
    assert torch.allclose(blend_pixels(base, top, "nonsense"), top)


def test_track_blend_lookup():
    tracks = [{"blend": "normal"}, {"blend": "difference"}]
    assert track_blend(tracks, 0) == "normal"
    assert track_blend(tracks, 1) == "difference"
    assert track_blend(tracks, 7) == "normal"      # beyond the list
    assert track_blend([], 0) == "normal"
    assert track_blend([{"blend": "bogus"}], 0) == "normal"
    tl = parse_timeline('{"tracks":[{"blend":"screen"},"junk",{"blend":"evil"}]}')
    assert track_blend(tl["tracks"], 0) == "screen"
    assert track_blend(tl["tracks"], 1) == "normal"   # a non-dict entry degrades
    assert track_blend(tl["tracks"], 2) == "normal"   # an unknown name degrades


def test_current_image_is_the_composited_frame():
    """`current_image` must come from the OUTPUT tensor, not from a re-read of a source:
    it has to carry the track blends, and it has to track the playhead exactly."""
    import json

    seq = torch.zeros((20, 8, 8, 3))
    for i in range(20):
        seq[i] = i / 100.0

    def run(playhead):
        tl = _dumps({
            "clips": [{"src": "media_0", "track": 0, "start": 0, "trimIn": 0,
                       "length": 20}],
            "masks": [], "audio": [], "ui": {"playhead": playhead}})
        r = NKDTimeline.execute(
            media={"media_0": seq}, timeline=tl,
            import_mode="stack", fps=24.0, start_frame=0, frame_count=0, width=8,
            height=8, fit="stretch", aspect_ratio="Custom", megapixels=1.0,
            size_multiple=16, model="free", quantize_n=8, clip_audio=False)
        o = outs(r)
        images, n, cur = o["images"], o["frame_count"], o["current_frame"]
        cur_img, dur = o["current_image"], o["duration"]
        # Duration must be the QUANTISED count in seconds, matching what was rendered.
        assert abs(dur - n / 24.0) < 1e-9, (dur, n)
        assert images.shape[0] == n
        return cur, cur_img, images

    for ph in (0, 7, 19):
        cur, cur_img, images = run(ph)
        assert cur == ph
        assert cur_img.shape == (1, 8, 8, 3)          # a one-frame IMAGE batch
        assert torch.equal(cur_img[0], images[cur])   # exactly the rendered frame
    # A playhead past the end clamps instead of raising or returning an empty batch.
    cur, cur_img, images = run(999)
    assert cur == 19
    assert cur_img.shape[0] == 1


def test_gaps_are_black_and_the_flat_lanes_cost_nothing():
    """`out` is allocated with `torch.empty` - memsetting 6.8 GiB measured 2.4s - so the
    frames no clip covers MUST be blacked out explicitly. Uninitialised memory leaking into
    a gap would show up as garbage exactly where the design says "region to generate".

    Coverage and an empty mask lane are stride-0 views for the same reason: they carry one
    value per frame, and materialising them cost 4.1s and 4.5 GiB at 1080p.
    """
    import json

    seq = torch.full((6, 4, 4, 3), 0.5)
    tl = _dumps({
        "clips": [{"src": "media_0", "track": 0, "start": 2, "trimIn": 0, "length": 6}],
        "masks": [], "audio": [], "ui": {"playhead": 0}})
    r = NKDTimeline.execute(
        media={"media_0": seq}, timeline=tl, import_mode="stack", fps=24.0,
        start_frame=0, frame_count=12, width=4, height=4, fit="stretch", aspect_ratio="Custom", megapixels=1.0,
            size_multiple=16,
        model="free", quantize_n=8, clip_audio=False)
    o = outs(r)
    images, mask, cov = o["images"], o["mask"], o["coverage"]

    assert images.shape[0] == 12
    for f in (0, 1, 8, 11):                       # before the clip and after it
        assert float(images[f].abs().max()) == 0.0, f
    for f in (2, 5, 7):
        assert float(images[f].min()) == 0.5, f

    assert cov.shape == (12, 4, 4) and mask.shape == (12, 4, 4)
    assert cov.stride() == (1, 0, 0) and mask.stride() == (1, 0, 0)   # views, not buffers
    # POLARITY: white in the GAPS, black over material. It is an inpainting mask ("generate
    # here"), not a report of what is covered - core's VAEEncodeForInpaint wipes the pixels
    # where the mask is 1 (nodes.py:436). Flipped on purpose; do not "fix" it back.
    assert float(cov[0].min()) == 1.0, "frame 0 is a gap -> white"
    assert float(cov[3].max()) == 0.0, "frame 3 has material -> black"
    assert float(mask.max()) == 0.0
    # A real mask clip still gets a full per-pixel buffer.
    tl2 = json.loads(tl)
    tl2["masks"] = [{"src": "media_0", "track": 0, "start": 0, "trimIn": 0, "length": 6}]
    r2 = NKDTimeline.execute(
        media={"media_0": seq}, timeline=_dumps(tl2), import_mode="stack", fps=24.0,
        start_frame=0, frame_count=12, width=4, height=4, fit="stretch", aspect_ratio="Custom", megapixels=1.0,
            size_multiple=16,
        model="free", quantize_n=8, clip_audio=False)
    assert outs(r2)["mask"].stride() == (16, 4, 1)
    assert float(outs(r2)["mask"][0].min()) > 0.0


def test_generate_mask_unions_the_lane_and_the_gaps():
    """A gap is a region to generate, so it has to be WHITE in the conditioning mask.
    `mask` alone leaves it black, and a black mask generates nothing exactly where there is
    nothing - which is the one place the user wanted something."""
    import json

    seq = torch.full((6, 4, 4, 3), 0.5)
    base = {"clips": [{"src": "media_0", "track": 0, "start": 0, "trimIn": 0, "length": 6}],
            "masks": [], "audio": [], "ui": {"playhead": 0}}

    def run(tl):
        r = NKDTimeline.execute(
            media={"media_0": seq}, timeline=_dumps(tl), import_mode="stack", fps=24.0,
            start_frame=0, frame_count=10, width=4, height=4, fit="stretch", aspect_ratio="Custom", megapixels=1.0,
            size_multiple=16,
            model="free", quantize_n=8, clip_audio=False)
        o = outs(r)
        return o["mask"], o["generate"]

    # No mask lane: generate IS the gaps, and stays a free stride-0 view.
    mask, gen = run(base)
    assert gen.shape == (10, 4, 4) and gen.stride() == (1, 0, 0)
    assert float(mask.max()) == 0.0                       # the lane is empty
    assert [float(gen[f].max()) for f in (0, 5, 6, 9)] == [0.0, 0.0, 1.0, 1.0]

    # With a mask lane: the union. Covered frames keep the lane's pixels, gaps go white.
    tl2 = dict(base)
    tl2["masks"] = [{"src": "media_0", "track": 0, "start": 0, "trimIn": 0, "length": 3}]
    mask2, gen2 = run(tl2)
    assert float(mask2[7].max()) == 0.0                   # the lane says nothing there
    assert float(gen2[7].min()) == 1.0                    # but it IS a gap -> generate
    assert torch.equal(gen2[1], mask2[1])                 # covered + masked: the lane wins
    assert float(gen2[4].max()) == 0.0                    # covered, unmasked: leave alone


def test_resolve_resolution():
    """Parity anchor for `resolveResolution` in src/timeline/model.ts - the editor previews
    from the TS copy, so a drift means the monitor lies about what will be rendered. Same
    table and same formula as NKD Klein Presampling, so a ratio picked here lands on the
    numbers that pack already produces."""
    assert resolve_resolution("16:9 Horizontal", 1.0, 1920, 1080, 16) == (1376, 768)
    assert resolve_resolution("9:16 Vertical", 1.0, 1920, 1080, 16) == (768, 1376)
    assert resolve_resolution("9:16 Vertical", 0.8, 1920, 1080, 32) == (704, 1248)
    assert resolve_resolution("1:1", 2.0, 1920, 1080, 16) == (1456, 1456)
    assert resolve_resolution("21:9 Horizontal", 0.5, 1920, 1080, 8) == (1112, 480)
    assert resolve_resolution("32:9 Horizontal", 1.0, 1920, 1080, 64) == (1984, 576)
    # Custom is the default and MUST be a pass-through: that is the behaviour every
    # workflow saved before these widgets existed depends on.
    assert resolve_resolution("Custom", 1.0, 1920, 1080, 16) == (1920, 1080)
    assert resolve_resolution("Custom", 4.0, 0, 0, 16) == (0, 0)
    # An unknown ratio (a workflow from a newer version) falls back to Custom, it does not
    # raise mid-render.
    assert resolve_resolution("47:3 Sideways", 1.0, 800, 600, 16) == (800, 600)
    for mult in (8, 16, 32, 64):
        w, h = resolve_resolution("9:16 Vertical", 1.0, 0, 0, mult)
        assert w % mult == 0 and h % mult == 0, (mult, w, h)
    # As Source keeps the material's shape and only rescales it to the budget.
    assert resolve_resolution("As Source", 0.5, 0, 0, 16, 1920, 1080) == (960, 544)
    assert resolve_resolution("As Source", 0.5, 0, 0, 32, 1080, 1920) == (544, 960)
    assert resolve_resolution("As Source", 2.0, 0, 0, 16, 2560, 1210) == (2096, 992)
    # Without a source to copy it falls back to the typed size rather than inventing one.
    assert resolve_resolution("As Source", 1.0, 640, 480, 16, 0, 0) == (640, 480)
    assert len(ASPECT_MODES) == 25


def test_audio_only_clip_is_a_gap_that_still_sounds():
    """Cut a segment out, let the model refill it, keep the sound.

    Deleting the middle clip outright takes its audio with it. An `audioOnly` clip leaves
    the picture unwritten - so the span reads as a gap and comes out of `generate` - while
    its own audio still lands on the mix at the right offset.
    """
    import json

    class FakeVideo:
        """Minimal VideoInput: duck-typed exactly like `classify` expects."""

        def __init__(self, n, rate=24.0):
            self.n, self.rate = n, rate

        def get_frame_rate(self):
            return self.rate

        def get_dimensions(self):
            return (4, 4)

        def get_frame_count(self):
            return self.n

        def as_trimmed(self, start, duration, strict_duration=True):
            return self

        def get_components(self):
            frames = torch.full((self.n, 4, 4, 3), 0.5)
            wave = torch.ones((1, 1, int(self.n / self.rate * 8000)))
            return Types.VideoComponents(images=frames, audio={
                "waveform": wave, "sample_rate": 8000}, frame_rate=Fraction(24, 1))

    def run(audio_only):
        tl = {"clips": [
            {"src": "media_0", "track": 0, "start": 0, "trimIn": 0, "length": 4},
            {"src": "media_0", "track": 0, "start": 4, "trimIn": 4, "length": 4,
             **({"audioOnly": True} if audio_only else {})},
            {"src": "media_0", "track": 0, "start": 8, "trimIn": 8, "length": 4}],
            "masks": [], "audio": [], "ui": {"playhead": 0}}
        r = NKDTimeline.execute(
            media={"media_0": FakeVideo(12)}, timeline=_dumps(tl),
            import_mode="stack", fps=24.0, start_frame=0, frame_count=12, width=4,
            height=4, fit="stretch", aspect_ratio="Custom", megapixels=1.0,
            size_multiple=16, model="free", quantize_n=8, clip_audio=True)
        return outs(r)

    whole = run(False)
    holed = run(True)
    # Picture: the middle is now black, and `generate` says "fill this".
    assert float(whole["images"][5].max()) > 0.0
    assert float(holed["images"][5].max()) == 0.0
    assert float(holed["coverage"][5].min()) == 1.0          # coverage WHITE - it IS a gap
    assert float(whole["coverage"][5].max()) == 0.0          # with the picture on, black
    assert float(holed["generate"][5].min()) == 1.0         # generate 1 - regenerate it
    assert float(holed["images"][1].max()) > 0.0           # the halves either side are untouched
    assert float(holed["images"][9].max()) > 0.0
    # raw_images: the audioOnly clip's picture is still there.
    assert float(holed["raw_images"][5].max()) > 0.0
    assert torch.allclose(whole["images"], whole["raw_images"])   # no audioOnly -> same
    # Sound: unchanged. That is the whole point of the flag.
    assert torch.allclose(whole["audio"]["waveform"], holed["audio"]["waveform"])
    assert float(holed["audio"]["waveform"].abs().max()) > 0.0


def test_classify():
    """One socket takes everything, so the kind has to be recovered from the object. The
    four are never ambiguous - but a wrong answer here would put a mask on the picture
    lane, so it is worth pinning down."""
    assert classify(torch.zeros((4, 8, 8, 3))) == "image"      # [N,H,W,C]
    assert classify(torch.zeros((4, 8, 8))) == "mask"          # [N,H,W]
    assert classify({"waveform": torch.zeros((1, 2, 100)), "sample_rate": 44100}) == "audio"

    class FakeVideo:            # duck-typed, so any VideoInput implementation counts
        def get_frame_rate(self): return 24
        def get_components(self): return None
    assert classify(FakeVideo()) == "video"

    # Anything unrecognised is None rather than a wrong guess - an unfilled Autogrow slot
    # arrives as None and must simply be skipped.
    assert classify(None) is None
    assert classify({}) is None                       # a dict with no waveform
    assert classify(torch.zeros((8, 8))) is None      # rank 2: neither image nor mask
    assert classify("nope") is None

    visual, audio = build_sources({
        "media_0": torch.zeros((2, 4, 4, 3)),
        "media_1": torch.zeros((2, 4, 4)),
        "media_2": {"waveform": torch.zeros((1, 2, 10)), "sample_rate": 8000},
        "media_3": None,                              # unconnected slot
    })
    assert sorted(visual) == ["media_0", "media_1"]
    assert sorted(audio) == ["media_2"]


def test_markers_parse_within_the_clip():
    """Offsets from the clip start, sorted and unique. Out-of-range ones are DROPPED,
    not clamped: clamping would pile several markers onto the same frame."""
    tl = parse_timeline({
        "clips": [{"src": "media_0", "start": 100, "length": 10,
                   "markers": [7, 3, 3, -1, 10, "nope"]}],
        "audio": [{"src": "media_1", "start": 0, "length": 5, "markers": [2]}],
    })
    assert tl["clips"][0]["markers"] == [3, 7]
    assert tl["audio"][0]["markers"] == [2]
    # A clip that never had any still exposes the key, so callers need no getattr dance.
    assert parse_timeline({"clips": [{"src": "a", "length": 3}]})["clips"][0]["markers"] == []


def test_marker_indices_are_relative_to_the_rendered_batch():
    """The whole point: `images` starts at start_frame, so a marker at timeline frame 103
    of a range starting at 100 is index 3 of the batch - not 103."""
    clips = [{"src": "media_0", "start": 100, "length": 10, "markers": [3, 7]}]
    assert marker_indices([clips], 100, 10) == [3, 7]
    assert marker_indices([clips], 95, 20) == [8, 12]
    # Outside the rendered range there is no frame to freeze, so they drop out entirely.
    assert marker_indices([clips], 105, 5) == [2]
    assert marker_indices([clips], 200, 10) == []
    # Two lanes marked at the same instant are ONE output frame.
    masks = [{"src": "media_1", "start": 0, "length": 200, "markers": [103]}]
    assert marker_indices([clips, masks], 100, 10) == [3, 7]


def test_marker_indices_survive_a_timeline_with_no_markers():
    assert marker_indices([[{"src": "a", "start": 0, "length": 5}]], 0, 5) == []


def test_clip_bound_indices_walk_the_clips_in_editor_order():
    """First/last frame per picture clip, clip by clip, NOT deduplicated - each bound is
    its own Freeze Frames socket. Mirrors clipBoundFrames in model.ts."""
    clips = [
        {"src": "b", "start": 40, "length": 10, "track": 0},
        {"src": "a", "start": 0, "length": 38, "track": 0},
    ]
    # Sorted by (start, track): clip "a" first even though it parses second.
    assert clip_bound_indices(clips, 0, 100) == [0, 37, 40, 49]
    # Relative to the rendered batch, out-of-range bounds DROPPED, not clamped.
    assert clip_bound_indices(clips, 10, 100) == [27, 30, 39]
    # An audioOnly clip contributes no picture, so no bounds either.
    clips[0]["audioOnly"] = True
    assert clip_bound_indices(clips, 0, 100) == [0, 37]
    # Adjacent cuts share nothing but still emit all four bounds (out 4, in 5).
    cut = [{"src": "a", "start": 0, "length": 5, "track": 0},
           {"src": "a", "start": 5, "length": 5, "track": 0}]
    assert clip_bound_indices(cut, 0, 10) == [0, 4, 5, 9]


def test_parse_frame_list():
    """Separator-agnostic, duplicates kept, order preserved - repeating an index is how
    you hold a freeze for longer."""
    assert parse_frame_list("0, 12, 47", 50) == [0, 12, 47]
    assert parse_frame_list("3 3\n9", 10) == [3, 3, 9]
    assert parse_frame_list("[4; 5]", 10) == [4, 5]
    assert parse_frame_list("-1", 10) == [9]           # negatives count from the end
    for bad in ("", "   ", "no numbers here"):
        try:
            parse_frame_list(bad, 10)
        except ValueError:
            pass
        else:
            raise AssertionError(f"empty input must raise: {bad!r}")
    # Out of range RAISES rather than clamping: the timeline never emits one, so a bad
    # index was typed and silently freezing a different frame is worse than saying so.
    for bad in ("10", "-11"):
        try:
            parse_frame_list(bad, 10)
        except ValueError:
            pass
        else:
            raise AssertionError(f"out-of-range index must raise: {bad!r}")


def test_markers_output_feeds_freeze_frames():
    """End to end: a marker placed in the editor comes out of NKD Timeline as an index
    that NKD Freeze Frames can use directly against the same `images` batch."""
    import json

    from nkd_timeline import NKDFreezeFrames

    seq = torch.zeros((20, 4, 4, 3))
    for i in range(20):
        seq[i] = i / 100.0
    tl = _dumps({
        # Clip starts at 5, so its marker at offset 7 is timeline frame 12.
        "clips": [{"src": "media_0", "track": 0, "start": 5, "trimIn": 0, "length": 15,
                   "markers": [7, 1]}],
        "ui": {"playhead": 0}})
    r = NKDTimeline.execute(
        media={"media_0": seq}, timeline=tl, import_mode="stack", fps=24.0,
        start_frame=4, frame_count=0, width=4, height=4, fit="stretch", aspect_ratio="Custom", megapixels=1.0,
            size_multiple=16,
        model="free", quantize_n=8, clip_audio=False)
    o = outs(r)
    images, marks = o["images"], o["markers"]
    assert marks == "2, 8"                              # 5+1-4 and 5+7-4
    frozen = NKDFreezeFrames.execute(images, marks).result
    assert frozen[1] == 2                                # count
    # Timeline frame 12 shows source frame 7 of the clip, i.e. 0.07. Same picture whether
    # it is read off the batch or off its own socket.
    assert abs(float(frozen[0][1, 0, 0, 0]) - 0.07) < 1e-6
    assert abs(float(frozen[3][0, 0, 0, 0]) - 0.07) < 1e-6   # frame_2 socket


def test_freeze_frames_picks_the_right_pictures():
    from nkd_timeline import MAX_FREEZE_OUTPUTS, NKDFreezeFrames
    batch = torch.arange(6, dtype=torch.float32).view(6, 1, 1, 1).repeat(1, 8, 8, 3)
    res = NKDFreezeFrames.execute(batch, "4, 1, 1").result
    out, count, singles = res[0], res[1], res[2:]
    assert count == 3
    assert out.shape == (3, 8, 8, 3)
    assert [float(f[0, 0, 0]) for f in out] == [4.0, 1.0, 1.0]

    # One socket per frame, then None for the sockets the editor hides. The tuple must
    # ALWAYS be the full width: the runtime indexes it by slot number.
    assert len(singles) == MAX_FREEZE_OUTPUTS
    assert [s.shape for s in singles[:3]] == [(1, 8, 8, 3)] * 3
    assert [float(s[0, 0, 0, 0]) for s in singles[:3]] == [4.0, 1.0, 1.0]
    assert all(s is None for s in singles[3:])

    # A copy, so an in-place op downstream cannot reach back into the timeline's batch.
    out[0] += 100.0
    assert float(batch[4, 0, 0, 0]) == 4.0

    # More markers than sockets is refused with a message, not silently truncated.
    try:
        NKDFreezeFrames.execute(torch.zeros((40, 8, 8, 3)),
                                ",".join(str(i) for i in range(MAX_FREEZE_OUTPUTS + 1)))
    except ValueError as e:
        assert "sockets" in str(e)
    else:
        raise AssertionError("overflowing the sockets must raise")


def test_freeze_frame_previews_are_labelled_copies():
    """The badge is burned into the PREVIEW only - the tensors that leave the outputs must
    come out clean."""
    from nkd_timeline import _badge_previews
    batch = torch.zeros((2, 64, 96, 3))
    prev = _badge_previews(batch, [7, 12])
    assert prev.shape == (2, 64, 96, 3)                 # under PREVIEW_MAX_W: not resized
    assert float(prev.max()) > 0.1, "nothing was drawn on the black frames"
    assert float(batch.max()) == 0.0, "the source batch was written on"
    # A big frame is scaled down for the preview, keeping its aspect.
    small = _badge_previews(torch.zeros((1, 1080, 1920, 3)), [0])
    assert small.shape[2] == 256 and small.shape[1] == 144


def test_tensor_strips_describe_the_tensor_not_the_upstream_file():
    """The contact sheet is the only thing that can describe a computed slot, so its
    geometry has to line up with what the editor slices out of it."""
    import math

    from PIL import Image

    import folder_paths
    from nkd_timeline import (
        STRIP_HEIGHT, STRIP_MAX_TILES, strip_frame, tensor_strips,
    )

    mask = torch.rand((7, 40, 80))                    # [N,H,W] - a MASK
    image = torch.rand((90, 32, 32, 3))               # [N,H,W,C] - an IMAGE
    sources = {"media_0": ("mask", mask), "media_1": ("image", image),
               "media_2": ("video", object())}        # videos have a file; no strip
    strips = tensor_strips(sources, "42", 24.0)
    assert set(strips) == {"media_0", "media_1"}, "a video must not get a strip"

    m = strips["media_0"]
    assert m["tiles"] == 7 and m["frame_count"] == 7
    assert (m["width"], m["height"]) == (80, 40), "the TENSOR's size, not the sheet's"
    sheet = Image.open(os.path.join(folder_paths.get_temp_directory(), m["filename"]))
    tile_w = round(80 / 40 * STRIP_HEIGHT)            # per-tile aspect is kept
    assert m["cols"] == 3 and sheet.size == (3 * tile_w, 3 * STRIP_HEIGHT)

    i = strips["media_1"]
    # Under the ceiling: ONE TILE PER FRAME, or the mask overlay lands on a neighbour.
    assert i["tiles"] == 90 and i["cols"] == 10
    assert i["frame_count"] == 90 and i["duration"] == 90 / 24.0
    assert [strip_frame(k, 90, 90) for k in range(90)] == list(range(90))

    # Past the ceiling it samples rather than growing without bound.
    big = tensor_strips({"m": ("mask", torch.rand((STRIP_MAX_TILES * 2, 8, 8)))},
                        "42", 24.0)["m"]
    assert big["tiles"] == STRIP_MAX_TILES and big["frame_count"] == STRIP_MAX_TILES * 2
    assert big["cols"] == math.ceil(math.sqrt(STRIP_MAX_TILES))
    # Every tile stays inside the tensor, and they only ever move forwards.
    picks = [strip_frame(k, big["tiles"], big["frame_count"]) for k in range(big["tiles"])]
    assert picks[0] >= 0 and picks[-1] == big["frame_count"] - 1
    assert all(b >= a for a, b in zip(picks, picks[1:]))

    # No node id means no editor listening: writing files for nobody is pure waste.
    assert tensor_strips(sources, None, 24.0) == {}



from json import dumps as _dumps


def test_clip_gain_ramp_matches_the_editor_curve():
    # Flat clips stay a scalar: the common case must not allocate a per-sample tensor.
    assert clip_gain_ramp(AudioEnv(gain=0.5, length=100), 10) == 0.5
    assert clip_gain_ramp(AudioEnv(gain=1.0, fade_in=10, length=0), 10) == 1.0

    # Linear fade in, exactly `offset / fade_in` - the same formula as `gainAt` in
    # src/timeline/model.ts. Drift between the two means the preview lies about the render.
    k = clip_gain_ramp(AudioEnv(fade_in=10, length=100), 12)
    assert float(k[0]) == 0.0
    assert abs(float(k[5]) - 0.5) < 1e-6
    assert float(k[10]) == 1.0 and float(k[11]) == 1.0

    # Fade out measured from the TAIL: `(length - offset) / fade_out`.
    k = clip_gain_ramp(AudioEnv(fade_out=10, length=100), 100)
    assert float(k[89]) == 1.0
    assert abs(float(k[95]) - 0.5) < 1e-6
    assert float(k[99]) < 0.11

    # Gain scales the ramp rather than replacing it.
    k = clip_gain_ramp(AudioEnv(gain=0.5, fade_in=10, length=100), 10)
    assert abs(float(k[5]) - 0.25) < 1e-6


def test_a_clip_whose_head_is_outside_the_window_does_not_fade_in_again():
    """The trap this whole envelope exists for.

    Rendering from frame 50 of a clip that starts at 0 with a 20-frame fade-in: those 20
    frames are BEHIND the window, so the surviving audio is at full level throughout.
    Anchoring the ramp to the window instead of to the clip fades in at the window edge -
    a dip in the middle of a stretch the user never touched.
    """
    sr, fps = 100, 10
    clip = {"start": 0, "length": 100, "fadeIn": 20, "fadeOut": 0, "gain": 1.0}
    env = audio_env(clip, 50, fps, sr)          # a = 50: the window starts mid-clip
    assert env.head == 500 and env.fade_in == 200
    k = clip_gain_ramp(env, 50)
    assert float(k[0]) == 1.0, "re-faded at the window edge"
    assert float(k.min()) == 1.0

    # And the head that IS inside the window still fades.
    env0 = audio_env(clip, 0, fps, sr)
    assert env0.head == 0
    k0 = clip_gain_ramp(env0, 250)      # past the 200-sample fade-in
    assert float(k0[0]) == 0.0
    assert abs(float(k0[100]) - 0.5) < 1e-6
    assert float(k0[200]) == 1.0


def test_mix_audio_applies_the_ramp():
    sr = 100
    ones = torch.ones((1, 100))
    env = AudioEnv(fade_in=20, fade_out=20, length=100)
    out = mix_audio([(ones, sr, 0, 0, env)], 100, sr)
    assert float(out[0, 0, 0]) == 0.0
    assert abs(float(out[0, 0, 10]) - 0.5) < 1e-6
    assert float(out[0, 0, 50]) == 1.0
    assert abs(float(out[0, 0, 90]) - 0.5) < 1e-6
    # A plain float still works: the audio-only fallback path passes one.
    assert abs(float(mix_audio([(ones, sr, 0, 0, 0.25)], 50, sr)[0, 0, 0]) - 0.25) < 1e-6
    # A NEGATIVE offset drops samples off the front, and those come off the ramp too.
    clipped = mix_audio([(ones, sr, -20, 0, env)], 100, sr)
    assert float(clipped[0, 0, 0]) == 1.0, "the fade-in replayed after a front clip"


def test_video_clips_carry_their_own_level_and_fades():
    """The line that made this feature impossible was `1.0` hardcoded in
    `_queue_clip_audio`: a video clip's sound was always mixed flat."""
    tl = parse_timeline(_dumps({
        "clips": [{"src": "media_0", "start": 0, "length": 48,
                   "gain": 0.5, "fadeIn": 12, "fadeOut": 6}],
    }))
    c = tl["clips"][0]
    assert c["gain"] == 0.5 and c["fadeIn"] == 12 and c["fadeOut"] == 6
    # Absent means "the way it always behaved", so old workflows are untouched.
    old = parse_timeline(_dumps({"clips": [{"src": "media_0", "length": 10}]}))
    assert old["clips"][0] == {**old["clips"][0], "gain": 1.0, "fadeIn": 0, "fadeOut": 0}


def test_fades_are_clamped_into_the_clip():
    # Two ramps longer than the clip are scaled TOGETHER, keeping the shape the user drew
    # instead of letting them overlap and dip in the middle.
    tl = parse_timeline(_dumps({
        "clips": [{"src": "m", "start": 0, "length": 10, "fadeIn": 30, "fadeOut": 10}],
    }))
    c = tl["clips"][0]
    assert c["fadeIn"] + c["fadeOut"] <= c["length"]
    assert c["fadeIn"] > c["fadeOut"], "the 3:1 shape survived the clamp"
    # Gain is clamped to the same ceiling the editor enforces.
    hot = parse_timeline(_dumps({"clips": [{"src": "m", "length": 5, "gain": 99}]}))
    assert hot["clips"][0]["gain"] == 2.0
    neg = parse_timeline(_dumps({"clips": [{"src": "m", "length": 5, "gain": -3}]}))
    assert neg["clips"][0]["gain"] == 0.0



def test_muted_zones_export_as_mask_and_ranges():
    """Muting a clip is the fourth gesture: not "drop the picture" (audioOnly), not "make
    a gap" (delete) — "regenerate THIS sound". It has to come out as a mask for our AV
    nodes and as in,out second pairs for MVEx Audio Mask To Latent's time_ranges."""
    # The helpers, on their own grid: window-relative, merged across lanes, clipped.
    rows = muted_rows([[{"start": 2, "length": 4, "muted": True},
                        {"start": 4, "length": 4, "muted": True},     # overlaps -> one run
                        {"start": 20, "length": 5, "muted": False}]], 0, 12)
    assert rows.tolist() == [0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]
    assert rows_to_ranges(rows, 10.0) == "0.200,0.800"
    # Two runs -> two pairs; a start_frame shifts them into window time.
    two = muted_rows([[{"start": 0, "length": 2, "muted": True}],
                      [{"start": 8, "length": 10, "muted": True}]], 4, 8)
    assert rows_to_ranges(two, 10.0) == "0.400,0.800"                  # first clip fell out
    assert rows_to_ranges(muted_rows([[]], 0, 5), 10.0) == ""          # nothing muted

    # Through the node. White = the rendered soundtrack is SILENT there: a muted clip OR
    # no clip giving sound at all — a gap has no sound either, so it is white for the
    # same reason it is white in `coverage`.
    seq = torch.full((10, 4, 4, 3), 0.5)
    voice = {"waveform": torch.ones((1, 1, 44100)), "sample_rate": 44100}
    tl = _dumps({
        "clips": [{"src": "media_0", "track": 0, "start": 0, "trimIn": 0, "length": 10}],
        "masks": [],
        "audio": [{"src": "media_1", "start": 2, "trimIn": 0, "length": 3, "muted": True},
                  {"src": "media_1", "start": 5, "trimIn": 0, "length": 5}],
        "ui": {"playhead": 0}})
    r = NKDTimeline.execute(
        media={"media_0": seq, "media_1": voice}, timeline=tl, import_mode="stack", fps=24.0,
        start_frame=0, frame_count=10, width=4, height=4, fit="stretch",
        aspect_ratio="Custom", megapixels=1.0, size_multiple=16,
        model="free", quantize_n=8, clip_audio=False)
    o = outs(r)
    am, ranges = o["audio_mask"], o["audio_ranges"]
    assert am.shape == (10, 4, 4) and am.stride() == (1, 0, 0)         # view, not a buffer
    # 0..2 silent gap, 2..5 muted, 5..10 sounding: one white run, then black.
    assert [float(am[f].max()) for f in (0, 2, 4, 5, 9)] == [1, 1, 1, 0, 0]
    vals = [float(v) for v in ranges.split(",")]
    assert len(vals) % 2 == 0                                          # MVEx-parseable
    assert vals == [0.0, round(5 / 24, 3)], vals
    # No sound anywhere (image only, clip_audio off): everything is silence to regenerate.
    r2 = NKDTimeline.execute(
        media={"media_0": seq}, timeline=_dumps({
            "clips": [{"src": "media_0", "track": 0, "start": 0, "trimIn": 0,
                       "length": 10}], "masks": [], "audio": [], "ui": {"playhead": 0}}),
        import_mode="stack", fps=24.0, start_frame=0, frame_count=10, width=4, height=4,
        fit="stretch", aspect_ratio="Custom", megapixels=1.0, size_multiple=16,
        model="free", quantize_n=8, clip_audio=False)
    o2 = outs(r2)
    assert float(o2["audio_mask"].min()) == 1.0
    assert o2["audio_ranges"] == f"0.000,{10 / 24:.3f}"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    # No emoji: the Windows console is cp1252 and would blow up printing one.
    print("\nNKD Timeline - all good.")
