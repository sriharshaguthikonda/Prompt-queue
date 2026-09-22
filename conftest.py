# Chromium refuses to load an unpacked extension whose root holds a name starting
# with "_" (reserved), so a pytest run must never leave __pycache__ behind here.
# tests/extension-root-names.test.js guards the same rule from the jest side.
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent


def pytest_unconfigure(config):
    for cache in (ROOT / "__pycache__", ROOT / "tests" / "__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)
