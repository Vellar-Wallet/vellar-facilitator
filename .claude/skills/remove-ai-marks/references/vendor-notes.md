# Vendor notes (public / class-level)

This skill targets **mark classes**, not reverse-engineered private detectors. Details below are from public docs and the research literature. Algorithms may change.

## Industry two-layer model (context)

Product and regulatory guidance often frames AI disclosure as:

1. **C2PA Content Credentials** — signed, hard-bound metadata (easy to strip; what this skill removes).
2. **Imperceptible watermark** (SynthID-class) — survives strip/re-upload; includes **soft binding** that can re-attach a remote C2PA manifest.

See: [Institute of AI PM — C2PA and SynthID guide](https://www.institutepm.com/knowledge-hub/ai-content-provenance-watermarking) (SB 942 / EU AI Act Art. 50 framing). This project only implements the **hard-bound / Unicode / rewrite** side of that stack.

## Anthropic / Claude

- **Embedded text watermarks** at model level (imperceptible; survive copy-paste). Public description matches **statistical token-sampling** class, not only Unicode.
- **C2PA Content Credentials** on supported files (e.g. PNG, JPEG, SVG).
- Models launched on/after **2026-08-02**: marking at launch; older models in transition; **worldwide**.
- Detection APIs for third parties: described as forthcoming.
- Caveats: mark ⇒ may have been processed by Claude; no mark ≠ human-only; proofreading can stamp human text.

**Skill mapping:** Layer A (Unicode hygiene) + Layer B (rewrite) + container/image C2PA strip.

Source: [How Claude marks AI-generated content](https://support.claude.com/en/articles/16266773-how-claude-marks-ai-generated-content).

## Google Gemini / SynthID-Text

- Nature 2024 paper: *Scalable watermarking for identifying large language model outputs* (SynthID-Text).
- **Generative watermarking**: modifies next-token sampling (Tournament sampling); detection uses a scoring function + key; no need for the LLM at detect time.
- Paper also taxonomizes:
  - **Edit-based** (Unicode / synonym rules) → our Layer A (+ Layer B for synonyms)
  - **Data-driven / backdoor** (trigger phrases) → **out of scope**
  - **Generative** (sampling) → Layer B best-effort
- Productionized in Gemini-scale systems; open research code exists, but **production keys are not public** — this skill does **not** ship a SynthID detector.

**Skill mapping:** same Layer B rewrite attacks (paraphrase / back-translate / structural) used in the literature against sampling watermarks.

## OpenAI / ChatGPT

- Public provenance often surfaces as **labels**, **C2PA / Content Credentials** on some media exports, and product UI disclosure — not a fully public text-sampling watermark spec comparable to SynthID-Text.
- Treat **file metadata / C2PA** as in-scope when present; treat any **unpublished** text watermark as the same statistical class → Layer B only, best-effort.
- Do not invent algorithm claims.

**Skill mapping:** container/image metadata strip + Layer A/B on text.

## Open-weight / open-LLM (Kirchenbauer-style)

- Classic green-list / red-list sampling bias (Kirchenbauer et al.) and variants.
- Detectable with the **key** and tokenizer; removal still relies on heavy paraphrase or regeneration.

**Skill mapping:** Layer B multi-pass; prefer rewrite with a **different** model family when possible.

## Cross-vendor hygiene rule

| Suspected origin | Prefer rewrite backend |
| --- | --- |
| Claude | Non-Claude (local Ollama, other API) |
| Gemini | Non-Gemini |
| OpenAI | Non-OpenAI |
| Unknown | Local open-weight if available |

Then re-run Layer A on the rewritten text.
