"""😺NKD /nkd/open — same-origin gate.

`_is_local` alone isn't authentication: any page open in the operator's browser can fire a
plain GET at localhost. Guards that `_is_same_origin` actually requires the browser-set
`Sec-Fetch-Site: same-origin` header, and that a missing/forged header fails closed.

Run: python tests/test_open_route.py   (with ComfyUI's interpreter)
"""
import importlib
import importlib.util
import os
import sys
import types

_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PKG_DIR)
sys.path.insert(0, os.path.dirname(os.path.dirname(_PKG_DIR)))

# nodes.py does `from . import nkd_projects, ...`, so it needs a real package context -
# `import nodes` on its own would also collide with ComfyUI core's own nodes.py, which
# sits higher on sys.path. Register this dir as a synthetic package and import nodes.py
# as a submodule of it.
_PKG_NAME = "nkd_pt_pkg"
_pkg = types.ModuleType(_PKG_NAME)
_pkg.__path__ = [_PKG_DIR]
sys.modules[_PKG_NAME] = _pkg

# nodes.py registers its routes on the live PromptServer singleton at import time; outside
# a running server that's just an aiohttp RouteTableDef, so a bare stand-in is enough to
# satisfy the module-level `PromptServer.instance.routes`.
from aiohttp import web as _web  # noqa: E402
from server import PromptServer as _PromptServer  # noqa: E402

if getattr(_PromptServer, "instance", None) is None:
    class _StubServer:
        routes = _web.RouteTableDef()
    _PromptServer.instance = _StubServer()

nodes = importlib.import_module(f"{_PKG_NAME}.nodes")


class _FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}


def test_same_origin_header_required():
    assert nodes._is_same_origin(_FakeRequest({"Sec-Fetch-Site": "same-origin"})) is True


def test_cross_site_header_rejected():
    assert nodes._is_same_origin(_FakeRequest({"Sec-Fetch-Site": "cross-site"})) is False


def test_missing_header_fails_closed():
    assert nodes._is_same_origin(_FakeRequest()) is False


if __name__ == "__main__":
    test_same_origin_header_required()
    test_cross_site_header_rejected()
    test_missing_header_fails_closed()
    print("test_open_route: all passed")
