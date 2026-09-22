---
name: stellar-competitive-landscape
description: Map the competitive landscape for a Stellar project idea. Use when a user says "who are my competitors on Stellar", "competitive analysis Stellar", "what already exists in this space on Stellar", "show me similar Stellar projects", "is anyone else building this on Stellar", "map the Stellar landscape for X" — or the Spanish/mixed-language equivalents, e.g. "cual es la competencia de X", "que tan saturado está este espacio", "que aspectos están menos explorados y la SDF/SCF están dispuestos a fondear", or "analiza la competencia de estos bounties". Also fires when a user (directly, or via a BMAD persona like justin-analyst) names a specific protocol/idea inline and asks about its competition, viability, or market whitespace — including "should we integrate [external protocol]" or "does anything like this already exist on Stellar" research, where the deliverable is the same landscape map applied to a build-vs-integrate decision. Queries the 728-project LumenLoop ecosystem database and Electric Capital developer activity to rank competitors by SCF funding history and repo activity.
---

## What this skill does

### 1. Get the project context

If the user hasn't described their idea, ask: "What are you building, in one sentence?"

Then ask: "Any specific category to compare against? — Financial Protocols, Applications, Developer Tooling, Infrastructure & Services, Payments, Education & Community, or other."

Skip both questions if the user already named their idea/protocol and a category (or category-like scope, e.g. "bounty 3A" or "institutional vertical") is inferable from the prompt — go straight to the search. This is the common case when the ask arrives already-scoped, including via a persona handoff (e.g. justin-analyst).

### 2. Search the ecosystem DB

Read `~/.claude/skills/data/lumenloop/projects.json`. If missing, fetch from `https://raw.githubusercontent.com/lumenloop/stellar-ecosystem-db/main/` (the YAML files in `projects/` — convert on the fly if needed).

Filter by:

- `attributes.category` matching the user's stated category (case-insensitive partial match)
- Description keyword overlap with the user's idea — extract 3-5 keywords from the idea, score each project by how many keywords appear in its description

Return top 10-15 matches ranked by relevance score.

When the question is about whitespace or what's underexplored ("que está menos explorado", "what should I build") rather than a single named competitor, also cross-check against SDF's current public strategy (stellar.org/foundation/strategy) — pair category counts from the DB with SDF's stated priorities so the answer is grounded in both what's built and what's officially wanted.

### 2.5 Mine Electric Capital for what LumenLoop doesn't show

`~/.claude/skills/data/electric-capital/stellar-repos.json` has ~9000 repos tagged as Stellar — a much wider net than LumenLoop's curated 728. Use it to surface what LumenLoop misses:

- **Emerging players**: GitHub orgs with 2+ Stellar repos that aren't in LumenLoop yet (proto-projects, soon-to-launch)
- **Dormant competitors**: repos whose names match the user's keywords but show no recent activity (these were attempts that didn't ship — useful signal about why the category might be hard)
- **Cluster detection**: if 5+ different orgs are working on the user's exact keyword (e.g., "perps", "vault", "wallet"), the space has more friction than LumenLoop suggests
- **Name collisions**: a similarly-named project elsewhere is not a real competitor — check whether it's actually building on Stellar (repo activity, chain mentions) before listing it as overlap; note the mismatch explicitly rather than silently dropping or silently including it

Filter out noise:
- Repos with `whitebelt`, `orangebelt`, `yellowbelt`, `greenbelt`, `redbelt` in the name (Stellar's tiered training program)
- Forks of `stellar/*` official repos with no meaningful divergence
- Student/tutorial repos (`-tutorial`, `-exercise`, `-demo` suffixes)

The cleaned signal vs LumenLoop catalog gives you the real picture: who's documented, who's stealth-building, who tried and abandoned.

### 3. Enrich with developer activity

For each top match, look up its GitHub org/repo in `~/.claude/skills/data/electric-capital/stellar-repos.jsonl`. Note: last-commit recency, total contributors if available. Flag dormant repos (no commits in 6+ months) as "low activity."

### 4. Build the competitive map

Present as a markdown table, sorted by SCF funding desc, then dev activity desc:

| Project | Category | SCF rounds + total | GitHub activity | One-line description | Overlap with user's idea |
|---------|----------|----------------------|-----------------|----------------------|--------------------------|

Use `scf.awarded_total` from the project entry. If null, mark as "—" (community-listed but not SCF-funded).

### 5. Differentiation guidance

After the table, write 2-3 sentences answering:

- **Strongest competitor**: which project is closest to the user's idea, what they do, and where their visible gap is (missing feature, dormant repo, narrow scope)
- **Saturated vs open space**: does the category have 1-2 dominant players (saturated) or many small players (fragmented, possibly open). Saturation is judged on SCF-funded count, not community-listed count.
- **Recommended differentiation**: one concrete angle the user could lean into

Close with: "Want me to route you to `validate-stellar-idea` to stress-test against the top competitor, or back to `find-stellar-idea` to pivot the angle?"

### 6. If the user pushes back asking for critique or brainstorming instead of another table

If, after a landscape map, the user asks to go deeper — "critica la idea en su completitud", risk analysis, a real brainstorm — don't re-send the same intro/menu text. That reads as the skill not having listened. Either use the competitive findings already gathered as direct input to a critical pass (strongest competitor's gap = the risk; saturation = the risk), or hand off explicitly to `brainstorming` / `advanced-elicitation`, carrying the findings forward instead of restarting from a blank menu.

## Constraints

- Only count SCF-funded projects toward "saturation" — unfunded community-listed projects are weaker competitive signal
- If user's category isn't recognized, ask for clarification rather than guessing
- If `projects.json` returns 0 matches, the category may be genuinely open — surface that as a *finding*, not a failure
- Do not invent project names. If the DB doesn't have something, say so honestly

<!-- LEARNED:BEGIN (auto-generated by optimize-skills — safe to delete/regenerate) -->
## Learned from your usage

_Compiled from 6 local traces on 2026-08-08. These are personalized defaults and
examples mined from how you actually use this skill. Edit or delete freely; rerun
`/optimize-skills` to regenerate. Undo with `stellar-loop restore stellar-competitive-landscape`._

**Defaults you tend to want:**
- Prompts usually arrive in Spanish, already naming the protocol/idea — skip the clarifying questions and go straight to the table
- When the ask is about whitespace ("menos explorado", "que fondearía la SDF") rather than one named rival, ground the answer in SDF's public strategy alongside the DB counts
- Always call out name-collision false positives (same-sounding project, different chain) instead of quietly including or dropping them
- When the ask is really "should we integrate X" rather than "who competes with us", check first whether X is already live on Stellar (repo + mainnet activity) before answering the strategic question — that fact usually changes the recommendation
- End with the routing question to `validate-stellar-idea` / `find-stellar-idea`, or offer a day-by-day plan when the analysis covers multiple options (e.g. bounties)
- If the user follows up asking for critique or brainstorming instead of more competitor data, don't repeat the standard intro — pivot straight into the critical analysis or hand off to `brainstorming`, carrying findings forward

**Example interactions that worked well:**
- _When the user asked_ "cual es la competencia de [my protocol]?", _the effective move was_ a ranked SCF-funding table plus an explicit "zero funded competitors" or "closest rival is X, here's their visible gap" finding, flagging any same-named-but-different-chain project rather than treating it as real overlap.
- _When the user asked_ "que aspectos están menos explorados y que la SDF/SCF fondearían", _the effective move was_ pulling SDF's current published strategy pillars verbatim, then cross-tabbing each pillar against category counts in the DB to show which stated priorities are underbuilt.
- _When the user asked whether an external protocol was worth integrating_, _the effective move was_ confirming first whether it already had a live Stellar/Soroban deployment (not just a cross-chain roadmap mention), since that fact flips the recommendation from "integrate" to "already exists, differentiate or skip."
<!-- LEARNED:END -->
