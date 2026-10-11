"""Layer A: invisible Unicode / homoglyph space detection and cleaning."""

from __future__ import annotations

import unicodedata
from collections import Counter
from dataclasses import dataclass, field

# Format / invisible controls commonly used for steganography or broken pastes.
STRIP_CODEPOINTS: frozenset[int] = frozenset(
    {
        0x00AD,  # soft hyphen
        0x034F,  # combining grapheme joiner
        0x061C,  # Arabic letter mark
        0x115F,  # Hangul choseong filler
        0x1160,  # Hangul jungseong filler
        0x17B4,  # Khmer vowel inherent AQ
        0x17B5,  # Khmer vowel inherent AA
        0x180B,  # Mongolian free variation selector-1
        0x180C,
        0x180D,
        0x180E,  # Mongolian vowel separator
        0x200B,  # zero width space
        0x200C,  # zero width non-joiner
        0x200D,  # zero width joiner
        0x200E,  # LRM
        0x200F,  # RLM
        0x202A,  # LRE
        0x202B,  # RLE
        0x202C,  # PDF
        0x202D,  # LRO
        0x202E,  # RLO
        0x2060,  # word joiner
        0x2061,  # function application
        0x2062,  # invisible times
        0x2063,  # invisible separator
        0x2064,  # invisible plus
        0x2066,  # LRI
        0x2067,  # RLI
        0x2068,  # FSI
        0x2069,  # PDI
        0x206A,  # inhibit symmetric swapping
        0x206B,
        0x206C,
        0x206D,
        0x206E,
        0x206F,
        0xFEFF,  # BOM / ZWNBSP
        0xFE00,  # variation selectors
        0xFE01,
        0xFE02,
        0xFE03,
        0xFE04,
        0xFE05,
        0xFE06,
        0xFE07,
        0xFE08,
        0xFE09,
        0xFE0A,
        0xFE0B,
        0xFE0C,
        0xFE0D,
        0xFE0E,
        0xFE0F,
        0xFFF9,  # interlinear annotation
        0xFFFA,
        0xFFFB,
    }
)

# Spaces that look like (or substitute for) U+0020.
SPACE_HOMOGLYPHS: dict[int, str] = {
    0x00A0: " ",  # no-break space
    0x1680: " ",  # Ogham space mark
    0x2000: " ",  # en quad
    0x2001: " ",  # em quad
    0x2002: " ",  # en space
    0x2003: " ",  # em space
    0x2004: " ",  # three-per-em space
    0x2005: " ",  # four-per-em space
    0x2006: " ",  # six-per-em space
    0x2007: " ",  # figure space
    0x2008: " ",  # punctuation space
    0x2009: " ",  # thin space
    0x200A: " ",  # hair space
    0x202F: " ",  # narrow no-break space
    0x205F: " ",  # medium mathematical space
    0x3000: " ",  # ideographic space
}

# Optional confusable Latin lookalikes (aggressive mode only).
LATIN_CONFUSABLES: dict[int, str] = {
    0x0410: "A",  # Cyrillic
    0x0412: "B",
    0x0415: "E",
    0x041A: "K",
    0x041C: "M",
    0x041D: "H",
    0x041E: "O",
    0x0420: "P",
    0x0421: "C",
    0x0422: "T",
    0x0425: "X",
    0x0430: "a",
    0x0435: "e",
    0x043E: "o",
    0x0440: "p",
    0x0441: "c",
    0x0443: "y",
    0x0445: "x",
    0x0456: "i",
    0xFF21: "A",  # fullwidth
    0xFF22: "B",
    0xFF23: "C",
    0xFF24: "D",
    0xFF25: "E",
    0xFF26: "F",
    0xFF27: "G",
    0xFF28: "H",
    0xFF29: "I",
    0xFF2A: "J",
    0xFF2B: "K",
    0xFF2C: "L",
    0xFF2D: "M",
    0xFF2E: "N",
    0xFF2F: "O",
    0xFF30: "P",
    0xFF31: "Q",
    0xFF32: "R",
    0xFF33: "S",
    0xFF34: "T",
    0xFF35: "U",
    0xFF36: "V",
    0xFF37: "W",
    0xFF38: "X",
    0xFF39: "Y",
    0xFF3A: "Z",
    0xFF41: "a",
    0xFF42: "b",
    0xFF43: "c",
    0xFF44: "d",
    0xFF45: "e",
    0xFF46: "f",
    0xFF47: "g",
    0xFF48: "h",
    0xFF49: "i",
    0xFF4A: "j",
    0xFF4B: "k",
    0xFF4C: "l",
    0xFF4D: "m",
    0xFF4E: "n",
    0xFF4F: "o",
    0xFF50: "p",
    0xFF51: "q",
    0xFF52: "r",
    0xFF53: "s",
    0xFF54: "t",
    0xFF55: "u",
    0xFF56: "v",
    0xFF57: "w",
    0xFF58: "x",
    0xFF59: "y",
    0xFF5A: "z",
}

# Variation selectors beyond FE0x (VS17–VS256 in Supplementary Special-purpose)
_VS_SUPPLEMENT = range(0xE0100, 0xE01F0)


# Bidi / directional format controls (subset of strip set, finer inspect labels)
_BIDI_CPS: frozenset[int] = frozenset(
    {
        0x061C,
        0x200E,
        0x200F,
        0x202A,
        0x202B,
        0x202C,
        0x202D,
        0x202E,
        0x2066,
        0x2067,
        0x2068,
        0x2069,
    }
)

# Zero-width family (common edit-based carriers)
_ZW_FAMILY: frozenset[int] = frozenset(
    {0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x180E}
)


def _is_strip_cp(cp: int) -> bool:
    if cp in STRIP_CODEPOINTS:
        return True
    if cp in _VS_SUPPLEMENT:
        return True
    # Tag characters used in some stego schemes (U+E0001–U+E007F)
    if 0xE0001 <= cp <= 0xE007F:
        return True
    return False


def _strip_kind(cp: int) -> str:
    """Finer-grained inspect kind for strip-class codepoints."""
    if 0xE0001 <= cp <= 0xE007F:
        return "tag_chars"
    if cp in _VS_SUPPLEMENT or 0xFE00 <= cp <= 0xFE0F or 0x180B <= cp <= 0x180D:
        return "variation_selector"
    if cp in _BIDI_CPS:
        return "bidi"
    if cp in _ZW_FAMILY:
        return "zwj_family"
    return "strip"


def _char_label(ch: str) -> str:
    cp = ord(ch)
    name = unicodedata.name(ch, "UNKNOWN")
    cat = unicodedata.category(ch)
    return f"U+{cp:04X} {name} ({cat})"


@dataclass
class CharHit:
    codepoint: int
    char: str
    label: str
    count: int
    kind: str  # strip | bidi | tag_chars | variation_selector | zwj_family | space | confusable | other_cf
    samples: list[int] = field(default_factory=list)  # character offsets


@dataclass
class TextInspectReport:
    length: int
    suspicious_total: int
    hits: list[CharHit]
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "length": self.length,
            "suspicious_total": self.suspicious_total,
            "hits": [
                {
                    "codepoint": f"U+{h.codepoint:04X}",
                    "label": h.label,
                    "count": h.count,
                    "kind": h.kind,
                    "sample_offsets": h.samples[:10],
                }
                for h in self.hits
            ],
            "notes": self.notes,
        }


def inspect_text(text: str, *, aggressive: bool = False) -> TextInspectReport:
    buckets: dict[tuple[int, str], list[int]] = {}
    for i, ch in enumerate(text):
        cp = ord(ch)
        kind: str | None = None
        if _is_strip_cp(cp):
            kind = _strip_kind(cp)
        elif cp in SPACE_HOMOGLYPHS:
            kind = "space"
        elif aggressive and cp in LATIN_CONFUSABLES:
            kind = "confusable"
        else:
            cat = unicodedata.category(ch)
            # Other format chars not already listed
            if cat == "Cf" and cp not in (0x00AD,):
                kind = "other_cf"
        if kind is None:
            continue
        key = (cp, kind)
        buckets.setdefault(key, []).append(i)

    hits: list[CharHit] = []
    total = 0
    for (cp, kind), offsets in sorted(buckets.items(), key=lambda x: (-len(x[1]), x[0][0])):
        ch = chr(cp)
        hits.append(
            CharHit(
                codepoint=cp,
                char=ch,
                label=_char_label(ch),
                count=len(offsets),
                kind=kind,
                samples=offsets[:10],
            )
        )
        total += len(offsets)

    notes = [
        "Layer A only: invisible/format Unicode and space homoglyphs (edit-based carriers).",
        "Statistical (token-sampling) watermarks are not detectable here; use Layer B rewrite.",
        "Inspect kinds: strip, bidi, tag_chars, variation_selector, zwj_family, space, confusable, other_cf.",
    ]
    if not hits:
        notes.append("No suspicious Unicode characters found.")
    return TextInspectReport(length=len(text), suspicious_total=total, hits=hits, notes=notes)


def clean_text(
    text: str,
    *,
    nfkc: bool = False,
    aggressive_homoglyphs: bool = False,
    normalize_spaces: bool = True,
) -> tuple[str, dict]:
    """Return cleaned text and a stats dict."""
    removed: Counter[str] = Counter()
    replaced: Counter[str] = Counter()
    out_chars: list[str] = []

    for ch in text:
        cp = ord(ch)
        if _is_strip_cp(cp):
            removed[_char_label(ch)] += 1
            continue
        if normalize_spaces and cp in SPACE_HOMOGLYPHS:
            replaced[_char_label(ch)] += 1
            out_chars.append(SPACE_HOMOGLYPHS[cp])
            continue
        if aggressive_homoglyphs and cp in LATIN_CONFUSABLES:
            replaced[_char_label(ch)] += 1
            out_chars.append(LATIN_CONFUSABLES[cp])
            continue
        # Other Cf: strip by default for hygiene
        if unicodedata.category(ch) == "Cf" and cp not in SPACE_HOMOGLYPHS:
            removed[_char_label(ch)] += 1
            continue
        out_chars.append(ch)

    result = "".join(out_chars)
    if nfkc:
        before = result
        result = unicodedata.normalize("NFKC", result)
        if result != before:
            replaced["NFKC_normalize"] += abs(len(before) - len(result)) or 1

    # Collapse runs of spaces only if we introduced space replacements? Keep conservative: no.

    stats = {
        "input_length": len(text),
        "output_length": len(result),
        "removed": dict(removed),
        "replaced": dict(replaced),
        "removed_count": sum(removed.values()),
        "replaced_count": sum(v for k, v in replaced.items() if k != "NFKC_normalize"),
    }
    return result, stats


def human_report(report: TextInspectReport) -> str:
    lines = [
        f"Length: {report.length} chars",
        f"Suspicious: {report.suspicious_total}",
    ]
    if report.hits:
        lines.append("Hits:")
        for h in report.hits:
            lines.append(f"  [{h.kind}] {h.label} x{h.count} @ {h.samples[:5]}")
    for n in report.notes:
        lines.append(f"Note: {n}")
    return "\n".join(lines)
