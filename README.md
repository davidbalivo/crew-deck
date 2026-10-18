# crew-deck

A Claude Code mod for the desktop app: a side panel with your session at the top and every subagent below it, live.

## What it shows

- Session header:
  - Project folder, its parent path and the current git branch.
  - Context used by the main thread, with a thin bar. It turns from green (below 40%) to amber (below 50%), orange (below 60%) and red.
  - Totals for all subagents: tokens, estimated cost and time.
- One row per subagent, grouped under "Running" and "Finished":
  - A pixel crab with its own body color, indented under the agent that spawned it.
  - Title, model and effort, agent type, and the steps it reports (`3/5` plus small blocks).
  - A borderless table on the right: cost and time, context (`ctx 9% 88k`), and tokens (`307k in 304k out 2k`). Its columns line up with the header and down the whole list.
- Runs that end well fold to one line. The arrow on the right unfolds them, and foldable rows light up on hover.
- In the terminal the same content is drawn as text rows.

## Install

In Claude Code:

```text
/plugin marketplace add davidbalivo/crew-deck
/plugin install crew-deck@crew-deck
```

Then run `/reload-plugins`. The panel opens on its own; `/crew-deck` opens and closes it.

## Cost is an estimate

Claude Code reports tokens, not money. crew-deck multiplies each kind of token (input, output, cache read, cache write) by a fixed price table in `hooks/register.tsx` (`PRICES`), taken from the [official pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-17. Fast mode, 1-hour cache writes and US-only inference are not priced, because the engine does not say when they apply.

## Tool for subagents

The mod registers one tool, `step`. A subagent reports its own steps with it (`done`, `total`, a short note). The panel draws them as the blocks on its row.

## Credits

crew-deck started as a fork of `savvy-progress` from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit) (MIT). The row layout, palette, header and pricing were reworked here.

## License

MIT. See [LICENSE](LICENSE).
