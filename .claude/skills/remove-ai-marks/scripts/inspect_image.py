#!/usr/bin/env python3
"""Inspect PNG/JPEG for C2PA and AI-related metadata."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import emit_json  # noqa: E402
from image_meta import inspect_image  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("path", type=Path, help="Image path (PNG or JPEG)")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    if not args.path.is_file():
        print(f"not a file: {args.path}", file=sys.stderr)
        return 2

    report = inspect_image(args.path)
    if args.json:
        emit_json(report.to_dict())
    else:
        print(f"Path: {report.path}")
        print(f"Format: {report.format}")
        print(f"C2PA: {report.has_c2pa}")
        print(f"AI metadata: {report.has_ai_metadata}")
        if report.findings:
            print("Findings:")
            for f in report.findings:
                print(f"  - {f}")
        ct = report.tools.get("c2patool") or {}
        print(f"c2patool: {'yes' if ct.get('available') else 'no'}")
        et = report.tools.get("exiftool") or {}
        print(f"exiftool: {'yes' if et.get('available') else 'no'}")
        if et.get("interesting_lines"):
            print("exiftool highlights:")
            for line in et["interesting_lines"][:20]:
                print(f"  {line}")

    return 0 if not (report.has_c2pa or report.has_ai_metadata) else 1


if __name__ == "__main__":
    raise SystemExit(main())
