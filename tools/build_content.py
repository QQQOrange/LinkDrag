#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build extension/content.js from the canonical extension source.

The content script is a large, hand-maintained browser program.  Keeping the
canonical source next to the extension artifact makes the build deterministic:
this script only stamps the manifest version into the generated file.

Usage:
    python tools/build_content.py
    python tools/build_content.py --check

`--check` exits non-zero when extension/content.js is out of date.  It is useful
in CI and before packaging a release.
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "extension.content.js"
MANIFEST = ROOT / "extension" / "manifest.json"
OUT = ROOT / "extension" / "content.js"
VERSION_TOKEN = "__LPS_VERSION__"


def build() -> str:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    version = str(manifest.get("version", "")).strip()
    if not version:
        raise SystemExit("[build] manifest.json has no version")
    source = SOURCE.read_text(encoding="utf-8")
    if VERSION_TOKEN not in source:
        raise SystemExit(f"[build] {VERSION_TOKEN} missing from {SOURCE}")
    output = source.replace(VERSION_TOKEN, version)
    if VERSION_TOKEN in output:
        raise SystemExit("[build] unresolved version token in output")
    return output


def main() -> int:
    output = build()
    if "--check" in sys.argv[1:]:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != output:
            print(f"[build] {OUT} is out of date; run python tools/build_content.py", file=sys.stderr)
            return 1
        print(f"[build] {OUT} is up to date ({len(output):,} chars)")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(output, encoding="utf-8", newline="\n")
    print(f"[build] wrote {OUT} ({len(output):,} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
