"""😺NKD projects — config round-trip, sanitising, and the token contract.

The failure this guards against is silent: a project whose name carries a separator, or a
config the cache never refreshes, both put renders somewhere other than where the chip
says. Nothing errors; you just find the files in the wrong folder a week later.

Run: python tests/test_projects.py   (with ComfyUI's interpreter)
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))))

import nkd_projects  # noqa: E402
from nkd_video import resolve_tokens, save_target  # noqa: E402

_tmp = tempfile.mkdtemp(prefix="nkd_proj_")
# Point the module at a scratch user dir and clear its cache, so the developer's real
# nkd_projects.json is never read and never written.
nkd_projects.config_path = lambda: os.path.join(_tmp, nkd_projects.CONFIG_NAME)


def reset(cfg=None):
    nkd_projects._cache = None
    path = nkd_projects.config_path()
    if os.path.exists(path):
        os.remove(path)
    return nkd_projects.save(cfg) if cfg else nkd_projects.load()


def test_first_run_creates_a_usable_config():
    cfg = reset()
    assert os.path.isfile(nkd_projects.config_path()), "the file must be written, not just returned"
    assert cfg["active"]["project"] in [p["name"] for p in cfg["projects"]]
    assert cfg["active"]["category"] in cfg["categories"]


def test_bare_strings_are_accepted_as_projects():
    # The obvious thing to type by hand into the JSON.
    cfg = reset({"projects": ["Contanimation", {"name": "Tests"}]})
    assert cfg["projects"] == [{"name": "Contanimation"}, {"name": "Tests"}]


def test_active_falls_back_when_it_names_something_gone():
    cfg = reset({"projects": ["A", "B"], "categories": ["x"],
                 "active": {"project": "deleted", "category": "gone"}})
    assert cfg["active"] == {"project": "A", "category": "x"}


def test_set_active_ignores_unknown_values():
    reset({"projects": ["A", "B"], "categories": ["x", "y"],
           "active": {"project": "A", "category": "x"}})
    cfg = nkd_projects.set_active("B", "nope")
    assert cfg["active"] == {"project": "B", "category": "x"}, \
        "an unknown category must be ignored, not invented"


def test_cache_follows_the_file():
    reset({"projects": ["A"], "categories": ["x"], "active": {"project": "A", "category": "x"}})
    assert nkd_projects.load()["active"]["project"] == "A"
    nkd_projects.set_active(None, None)          # a write must refresh the cache
    reset({"projects": ["Z"], "categories": ["q"], "active": {"project": "Z", "category": "q"}})
    assert nkd_projects.load()["active"]["project"] == "Z"


def test_tokens_use_the_path_override_when_there_is_one():
    reset({"projects": [{"name": "Contanimation", "path": "Contanimation/renders"}],
           "categories": ["test"],
           "active": {"project": "Contanimation", "category": "test"}})
    assert nkd_projects.tokens() == {"project": "Contanimation/renders", "category": "test"}


def test_tokens_fall_back_to_the_project_name():
    reset({"projects": ["Personal Tests"], "categories": ["draft"],
           "active": {"project": "Personal Tests", "category": "draft"}})
    assert nkd_projects.tokens()["project"] == "Personal Tests"


def test_a_name_cannot_smuggle_in_a_path():
    # A name is ONE segment. If it could carry separators, "../.." would walk out of
    # output/ and get_save_image_path would be the only thing left saying no.
    assert "/" not in nkd_projects.sanitize_name("../../etc")
    assert "/" not in nkd_projects.sanitize_name("a/b")
    assert "\\" not in nkd_projects.sanitize_name("a\\b")
    assert nkd_projects.sanitize_name("") == "Untitled"


def test_a_path_keeps_its_folders_but_not_its_traversal():
    assert nkd_projects.sanitize_path("Contanimation/renders") == "Contanimation/renders"
    assert nkd_projects.sanitize_path("a\\b") == "a/b"
    out = nkd_projects.sanitize_path("../../../etc/passwd")
    assert ".." not in out.split("/"), out
    assert nkd_projects.sanitize_path("   ") == "Untitled"


def test_the_tokens_actually_expand_in_a_prefix():
    # The whole point: no new path machinery, just two more tokens for the engine that
    # filename_prefix already runs through.
    reset({"projects": [{"name": "Contanimation", "path": "Contanimation/renders"}],
           "categories": ["test"],
           "active": {"project": "Contanimation", "category": "test"}})
    got = resolve_tokens("%project%/%category%/%node%", {"node": "SH010", **nkd_projects.tokens()})
    assert got == "Contanimation/renders/test/SH010"


def test_signature_changes_with_the_selection():
    # If this ever stops changing, switching project stops re-rendering: ComfyUI hands back
    # the cached UI and never writes into the new folder. Silent, and the worst kind.
    reset({"projects": ["A", "B"], "categories": ["x", "y"],
           "active": {"project": "A", "category": "x"}})
    first = nkd_projects.signature()
    nkd_projects.set_active("B", "y")
    assert nkd_projects.signature() != first


def test_uses_tokens_only_fires_for_prefixes_that_care():
    assert nkd_projects.uses_tokens("%project%/x")
    assert nkd_projects.uses_tokens("a/%category%")
    assert not nkd_projects.uses_tokens("video/NKD_v%v###%")


def test_save_target_versions_instead_of_overwriting():
    # The Popup Preview save bug: it must never write the same name twice.
    root = tempfile.mkdtemp(prefix="nkd_save_")

    def touch(vmode, ver=1):
        folder, name, _ = save_target("shot/NKD", root, ".png", vmode, ver)
        os.makedirs(folder, exist_ok=True)
        open(os.path.join(folder, name), "w").close()
        return name

    # off: the core's _NNNNN_ counter walks forward, no collision.
    assert touch("off") == "NKD_00001_.png"
    assert touch("off") == "NKD_00002_.png"

    # auto: _vNNN appended to the name, next free each time.
    assert touch("auto") == "NKD_v001.png"
    assert touch("auto") == "NKD_v002.png"

    # manual: exactly the asked version — re-saving overwrites on purpose (Write-node rule).
    assert touch("manual", 5) == "NKD_v005.png"
    assert touch("manual", 5) == "NKD_v005.png"

    # A prefix that already carries the token keeps its own placement/padding.
    folder, name, _ = save_target("shot/NKD_v%v####%", root, ".png", "manual", 7)
    assert name == "NKD_v0007.png"


def test_a_broken_file_does_not_take_the_render_down():
    reset()
    with open(nkd_projects.config_path(), "w", encoding="utf-8") as fh:
        fh.write("{ this is not json")
    nkd_projects._cache = None
    cfg = nkd_projects.load()
    assert cfg["projects"], "a corrupt config must fall back to defaults, not raise"


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"  ok   {name}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL {name}: {exc!r}")
    print("all good" if not failed else f"{failed} failed")
    sys.exit(1 if failed else 0)
