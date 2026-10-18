# mission-control

## Version

`MAJOR.MINOR.PATCH` ([Semantic Versioning](https://semver.org)), same value in both files:

- `.claude-plugin/marketplace.json`
- `plugins/mission-control/.claude-plugin/plugin.json`

Bumps:

- One bump per published change: without it, no update for installed copies.
- Default: PATCH only (`0.6.1` → `0.6.2`).
- MINOR or MAJOR (`0.7.0`, `1.0.0`): never an own decision. If the changes seem to need one, ask first, with the reason: "I think this needs a MINOR bump because …, but it's your call. Otherwise, PATCH." No clear yes: PATCH.

## Prices

- Source: `https://platform.claude.com/docs/en/about-claude/pricing.md`, table "Model pricing".
- Order: this session's fetch → last valid fetch in `$.store` → `PRICES` in `plugins/mission-control/hooks/register.tsx`.
- Fetch: at session start, never blocking the panel. Fixed URL, GET, no `auth`, no user data.
- Validation: size limit, at most 200 table rows, text content type, table found, opus, sonnet and haiku present, Haiku 5.5 with its long-prompt tier, no model twice, values in range and in order (cache read < input < output, cache write ≥ input). Any failure: whole fetch discarded, never mixed with `PRICES`.
- Stored table: same checks on read. Older than `PRICES_CHECKED_AT`: ignored. Unreadable store: fetch still tried.
- Model missing from the fetched table: its `PRICES` match.
- Fetched text: numbers only past the parser. Never to the model, never into the SVG.
- `PRICES`: refresh on a new model or a price change, with the check date in its comment, in `PRICES_CHECKED_AT` and in the README.
- Tests: `tests/prices.test.ts`, each source and the main discard reasons.
