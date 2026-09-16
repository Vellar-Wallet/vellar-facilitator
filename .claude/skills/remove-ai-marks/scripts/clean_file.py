#!/usr/bin/env python3
"""Unified clean: text Layer A, PNG/JPEG metadata, and document containers."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import cleaned_path, eprint  # noqa: E402
from container_meta import clean_container, detect_container_format  # noqa: E402
from image_meta import clean_image, detect_format as detect_image_format  # noqa: E402
from text_unicode import clean_text  # noqa: E402

IMAGE_EXTS = {".png", ".jpg", ".jpeg"}
CONTAINER_EXTS = {".svg", ".pdf", ".docx", ".odt", ".html", ".htm", ".md", ".markdown", ".mdx"}
TEXT_EXTS = {
    ".txt",
    ".text",
    ".css",
    ".js",
    ".py",
    ".rs",
    ".go",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".csv",
}


def classify(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in CONTAINER_EXTS:
        return "container"
    if ext in TEXT_EXTS:
        return "text"
    data = path.read_bytes()
    if detect_image_format(data) in ("png", "jpeg"):
        return "image"
    if detect_container_format(path, data) != "unknown":
        return "container"
    return "text"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("path", type=Path)
    p.add_argument("-o", "--output", type=Path)
    p.add_argument("--in-place", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--nfkc", action="store_true", help="Text: NFKC normalize")
    p.add_argument("--aggressive-homoglyphs", action="store_true")
    p.add_argument(
        "--keep-non-ai-metadata",
        action="store_true",
        help="Images: only drop C2PA/AI-looking segments",
    )
    p.add_argument(
        "--as",
        dest="force_type",
        choices=("auto", "text", "image", "container"),
        default="auto",
    )
    args = p.parse_args()

    if not args.path.is_file():
        eprint(f"not a file: {args.path}")
        return 2

    kind = args.force_type if args.force_type != "auto" else classify(args.path)

    if args.in_place:
        bak = args.path.with_suffix(args.path.suffix + ".bak")
        bak.write_bytes(args.path.read_bytes())
        dest = args.path
        src = bak
    else:
        src = args.path
        dest = args.output or cleaned_path(args.path)

    if kind == "text":
        text = src.read_text(encoding="utf-8", errors="surrogateescape")
        cleaned, stats = clean_text(
            text,
            nfkc=args.nfkc,
            aggressive_homoglyphs=args.aggressive_homoglyphs,
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(cleaned, encoding="utf-8")
        result = {
            "kind": "text",
            "input": str(args.path),
            "output": str(dest),
            "stats": stats,
        }
        if args.json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            eprint(
                f"wrote {dest} removed={stats['removed_count']} replaced={stats['replaced_count']}"
            )
        return 0

    if kind == "image":
        try:
            result = clean_image(
                src,
                dest,
                strip_all_metadata=not args.keep_non_ai_metadata,
            )
        except Exception as e:
            eprint(f"error: {e}")
            return 1
        result = {"kind": "image", **result}
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            eprint(f"wrote {result['output']} ({result['bytes_in']} -> {result['bytes_out']})")
            for a in result["actions"]:
                eprint(f"  - {a}")
            if result["still_has_c2pa"] or result["still_has_ai_metadata"]:
                eprint("warning: residual C2PA/AI signals may remain")
                return 1
        return 0

    try:
        result = clean_container(src, dest)
    except Exception as e:
        eprint(f"error: {e}")
        return 1
    result = {"kind": "container", **result}
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        eprint(f"wrote {result['output']} format={result['format']}")
        for a in result["actions"]:
            eprint(f"  - {a}")
        if result["still_has_c2pa"] or result["still_has_ai_metadata"]:
            eprint("warning: residual C2PA/AI signals may remain")
            for f in result.get("post_findings") or []:
                eprint(f"  ! {f}")
            # degraded PDF copy is not a hard failure if we only warn
            if result.get("meta", {}).get("degraded"):
                return 0
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
