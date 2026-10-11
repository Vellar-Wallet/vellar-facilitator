# Intended use

This skill removes machine-readable provenance marks and hygiene problems from content **you own or are authorized to process**.

## Appropriate

- Privacy: strip tool/device/AI provenance from your own files before sharing
- Engineering hygiene: remove invisible Unicode that breaks diffs, search, or paste
- Research: understand how text and C2PA marks work across vendors
- Cleaning your own drafts where policy allows unmarked local copies

## Not appropriate

- Academic fraud or misrepresenting AI assistance where disclosure is required
- Circumventing lawful transparency or platform disclosure rules
- Claiming cleaned content is “human-written” for compliance theater

A removed mark does **not** mean the content was never AI-assisted. Use this toolkit honestly.

## Honesty in reports

Always separate:

1. **Verifiable** removals (Unicode counts, metadata actions)
2. **Best-effort** statistical rewrite (no gold undetection claim)
3. **Out of scope** channels (pixel/audio/video watermarks, **C2PA soft binding**, secret-key detectors, training backdoors)

Do not imply that a successful C2PA/metadata strip means “no AI provenance left.” Soft-bound and SynthID-class media signals can survive. Point users at vendor verify tools when they need residual checks (see README *Residual risk after a clean*).
