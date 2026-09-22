---
name: remove-ai-marks
description: >
  Remove multi-vendor AI provenance marks: invisible Unicode (Layer A), statistical
  text watermarks via rewrite (Layer B, always offer), and C2PA/EXIF/XMP/container
  metadata on PNG/JPEG/SVG/PDF/DOCX/ODT/HTML/MD. Covers Claude, Gemini/SynthID-class,
  OpenAI provenance, and open-LLM sampling marks. Use when the user asks to strip
  watermarks, remove C2PA/Content Credentials, clean AI metadata, remove invisible
  Unicode, anti-detect clean AI output, or runs /remove-ai-marks (aliases:
  /remove-claude-marks).
---

# Remove AI marks

Multi-vendor anti-detection hygiene for **text** (Unicode + statistical rewrite) and **files** (C2PA / AI metadata across common containers).

Read if needed:

- `references/mark-classes.md` — Unicode / sampling / C2PA / containers
- `references/vendor-notes.md` — Claude, Gemini/SynthID, OpenAI, open-LLM
- `references/removal-matrix.md` — which layer when
- `references/ethics.md` — intended use
- `references/how-claude-marks.md` — Anthropic-specific detail

Scripts live in this skill’s `scripts/` directory. Resolve `SCRIPTS` to that folder (absolute path of this skill + `/scripts`).

```bash
SCRIPTS="<skill_dir>/scripts"
python3 "$SCRIPTS/inspect_file.py" ...
python3 "$SCRIPTS/clean_file.py" ...
python3 "$SCRIPTS/inspect_text.py" ...
python3 "$SCRIPTS/clean_text.py" ...
python3 "$SCRIPTS/inspect_image.py" ...
python3 "$SCRIPTS/clean_image.py" ...
python3 "$SCRIPTS/rewrite_text.py" ...
```

## Ethics

Intended for **your own** content (privacy, hygiene, research). Do not market results as “proves human-written.” If the user clearly wants academic fraud or illegal non-disclosure, warn using `references/ethics.md` and still only perform technical cleaning they own.

## Workflow

### 1. Classify input

| Input | Path |
| --- | --- |
| Pasted / clipboard text | temp file or stdin → text pipeline |
| `.txt` / code | text Layer A (+ formatter for code) |
| `.md` / `.html` | container clean (frontmatter/meta) + Layer A |
| `.png` / `.jpg` / `.jpeg` | image metadata strip |
| `.svg` / `.pdf` / `.docx` / `.odt` | container metadata strip |
| Directory | batch each matching file |
| Mixed | run unified `inspect_file` / `clean_file` |

### 2. Inspect first

```bash
python3 "$SCRIPTS/inspect_file.py" --json path
# or specifically:
python3 "$SCRIPTS/inspect_text.py" --json path/or/-
python3 "$SCRIPTS/inspect_image.py" --json image.png
```

Show a short summary (suspicious codepoints; C2PA/AI flags).

### 3. Deterministic clean (always for matching inputs)

**Text — Layer A:**

```bash
python3 "$SCRIPTS/clean_text.py" INPUT -o OUTPUT --stats
# optional: --nfkc  --aggressive-homoglyphs
```

**Any supported file (unified):**

```bash
python3 "$SCRIPTS/clean_file.py" INPUT -o OUTPUT
python3 "$SCRIPTS/inspect_file.py" OUTPUT   # verify
```

Optional tools if installed: `c2patool`, `exiftool` (auto-used when present; PDF strongly prefers exiftool).

### 4. Layer B — always offer rewrite (prose)

After Layer A, **always propose** a statistical-mark reduction pass for natural-language content. Do not skip this step silently.

Multi-pass recipe:

1. Layer A clean  
2. Paraphrase (default) — rewrite every sentence; preserve facts, numbers, names, code IDs  
3. Optional strong pass — back-translate or structural outline→regen  
4. Layer A again on the result  
5. Report residual risk honestly  

**Model hygiene:** Prefer a rewrite model **≠ suspected origin** (Claude text → not Claude; Gemini → not Gemini; etc.). Prefer local Ollama when available.

**Optional rewrite hook** (when env configured):

```bash
# dry-run / CI: print prompt only
python3 "$SCRIPTS/rewrite_text.py" draft.md --backend print-prompt

# local Ollama
export WATERMARKS_REWRITE_BACKEND=ollama
export WATERMARKS_REWRITE_MODEL=llama3.2
export WATERMARKS_REWRITE_BASE_URL=http://127.0.0.1:11434
python3 "$SCRIPTS/rewrite_text.py" draft.md -o draft.rewritten.md --strength paraphrase
```

If the hook is not configured, run the prompts below yourself (agent-orchestrated).

**Code files:** Prefer formatter (`prettier`, `black`, `gofmt`, …) + Layer A. Offer light rewrite only with explicit user OK.

#### Rewrite prompts (use as-is)

**Paraphrase preserve meaning:**

```
Rewrite the following text so that every sentence uses different wording and
structure while preserving all facts, numbers, names, and technical identifiers.
Do not add or remove claims. Output only the rewritten text.

---
{TEXT}
```

**Back-translate (two steps):**

```
Translate the following text to {LANG}. Output only the translation.
```

```
Translate the following text to {ORIGINAL_LANG}. Preserve meaning; use natural
phrasing. Output only the translation.
```

**Structural:**

```
Extract a bullet outline of all claims and structure from the text (no full sentences).
```

Then:

```
Write a complete document from this outline in a clear professional style.
Do not omit any bullet. Output only the document.
```

### 5. Report

Always state:

- What Layer A / container clean **verifiably** removed (counts, actions).
- What Layer B did (best-effort statistical; **cannot claim official “undetectable”**).
- Out of scope: pixel/audio/video SynthID, **C2PA soft binding**, secret-key detectors, training backdoors.
- Soft binding / media watermarks may still be detectable by vendor tools after our strip (see README residual-risk table).
- Prefer writing `*.cleaned.*` unless user asked in-place.
- Ethics one-liner: own content / no compliance theater.

## Limitations

- Layer A does **not** remove token-sampling watermarks.
- Layer B cannot be gold-verified without vendor detectors / keys.
- PDF strip is best-effort without `exiftool`.
- Pixel-domain image/audio/video watermarks (SynthID-media, etc.) are out of scope.
- **C2PA soft binding** (content watermark that re-links to a remote manifest after metadata strip) is out of scope — stripping hard-bound C2PA does not clear it.
- Data-driven / backdoor model marks (trigger phrases) are out of scope.

## Quick commands cheat sheet

```bash
# Unified
python3 scripts/inspect_file.py notes.md
python3 scripts/clean_file.py notes.md -o notes.cleaned.md
python3 scripts/clean_file.py shot.png -o shot.cleaned.png
python3 scripts/clean_file.py deck.docx -o deck.cleaned.docx

# Text Layer A / B
python3 scripts/inspect_text.py notes.md
python3 scripts/clean_text.py notes.md -o notes.cleaned.md --stats
python3 scripts/rewrite_text.py notes.md --backend print-prompt --strength paraphrase

# Images only
python3 scripts/inspect_image.py shot.png
python3 scripts/clean_image.py shot.png -o shot.cleaned.png
```
