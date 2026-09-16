# Removal matrix

| Target | Method | Script / action | Side effects | Verifiable today? |
| --- | --- | --- | --- | --- |
| Invisible Unicode / exotic spaces / bidi / tags | Strip / normalize | `inspect_text.py`, `clean_text.py`, `clean_file.py` | Minimal | Yes (codepoint report) |
| Statistical text watermark (SynthID-class / Kirchenbauer) | Multi-pass paraphrase / back-translate / structural | Agent Layer B + optional `rewrite_text.py` | Meaning/style drift | No without vendor key/detector |
| C2PA on PNG/JPEG | Drop APP11 / text chunks / exiftool | `clean_image.py` | Loses provenance metadata | Yes |
| SVG metadata / XMP | Drop `<metadata>`, xmpmeta | `clean_file.py` | Loses SVG metadata | Yes (re-inspect) |
| PDF XMP / info | exiftool `-all=` preferred | `clean_file.py` | Loses PDF metadata; degraded without exiftool | Partial |
| DOCX props / customXml | Rewrite OOXML zip | `clean_file.py` | Loses doc properties | Yes |
| ODT meta:generator | Scrub `meta.xml` | `clean_file.py` | Loses generator tag | Yes |
| HTML generator / JSON-LD provenance | Strip tags | `clean_file.py` | Loses meta | Yes |
| Markdown AI frontmatter keys | Drop keys | `clean_file.py` | Loses YAML keys | Yes |
| Pixel / audio / video watermarks (SynthID-media) | — | Out of scope | — | — |
| C2PA soft binding (in-content link to manifest) | — | Out of scope (survives our metadata strip) | — | Vendor detector only |
| Data-driven model backdoors | — | Out of scope | — | — |

## Default pipeline

1. **Inspect** (`inspect_file.py` or specific inspect_*).
2. **Deterministic clean** — Layer A text and/or container/image metadata.
3. **Always offer Layer B** rewrite for prose (paraphrase → optional strong pass).
4. Prefer a **non-origin** rewrite model when available (avoid re-stamping).
5. Layer A again after rewrite.
6. Report: Layer B is best-effort; residual risk remains.

## Code vs prose

- **Prose / Markdown / HTML body:** full A + B.
- **Code:** Layer A + formatter; statistical marks are weak; light rewrite only with user OK.

## Layer B strengths

| Strength | When |
| --- | --- |
| `paraphrase` | Default |
| `backtranslate` | Stronger token reshuffle |
| `structural` | Strongest; most drift |
