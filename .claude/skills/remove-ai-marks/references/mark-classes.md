# Mark classes

## 1. Edit-based text (Unicode / rules)

Invisible or near-invisible characters, exotic spaces, bidi controls, tag characters, synonym tables.

| Inspect kinds (Layer A) | Examples |
| --- | --- |
| `zwj_family` | ZWSP, ZWNJ, ZWJ, WJ, BOM |
| `bidi` | LRE/RLO/LRI/… |
| `tag_chars` | U+E0001–U+E007F |
| `variation_selector` | VS1–VS256 |
| `space` | NBSP, em space, ideographic space |
| `confusable` | Cyrillic/fullwidth Latin (aggressive) |

**Removal:** `clean_text.py` / Layer A — deterministic, verifiable.

Maps to Nature paper “edit-based watermarking.”

## 2. Generative / statistical text (token sampling)

Bias next-token sampling toward a pseudo-random green list / score (Kirchenbauer, SynthID-Text / Tournament sampling, etc.). Signal lives in **word choice**, not metadata.

**Removal:** Layer B rewrite (paraphrase → back-translate → structural). Best-effort; no gold cert without vendor detector/key.

Maps to Nature paper primary method (SynthID-Text).

## 3. Data-driven / backdoor

Model trained or fine-tuned so trigger prompts produce marked or identifiable behavior.

**Out of scope** for this skill (model-side).

## 4. File provenance metadata (C2PA / EXIF / XMP / props)

Signed Content Credentials and AI generator tags in containers (hard-bound to the file: JUMBF/APP11, PNG chunks, XMP packets, OOXML props, etc.).

Industry framing (C2PA + SynthID two-layer model; see Institute of AI PM guide in README references):

| Layer | Mechanism | Survives metadata strip? | This project |
| --- | --- | --- | --- |
| **Hard-bound C2PA** | Signed manifest *in* the file | No — strip/re-encode drops it | **In scope** — `clean_file` / `clean_image` |
| **Soft binding** | Imperceptible watermark *in content* that can resolve to a remote manifest | Yes (by design) | **Out of scope** — pixel/audio/video signal |
| **Standalone SynthID-class** | Pixel / waveform / token watermark without needing C2PA | Yes for media; text is weaker | Media OOS; text → Layer B best-effort |

| Format | Support |
| --- | --- |
| PNG / JPEG | Full strip (stdlib + optional exiftool) |
| SVG | Drop metadata/XMP blocks |
| PDF | Prefer exiftool; degraded stdlib XMP strip |
| DOCX / ODT | Scrub zip XML props / customXml |
| HTML | Meta generator / JSON-LD / data-ai* |
| Markdown | YAML frontmatter AI keys |

**Removal:** `clean_file.py` / `clean_image.py` — usually verifiable by re-inspect.

**Honest report:** after a successful C2PA strip, soft-bound / pixel SynthID (if the generator used them) may still be detectable by vendor tools (e.g. SynthID Detector, Content Credentials verify sites).

## 5. Pixel-domain image (and audio/video) watermarks

Invisible media marks (e.g. SynthID for images/audio/video) and C2PA **soft binding** that lives in the signal, not the metadata. **Out of scope.**
