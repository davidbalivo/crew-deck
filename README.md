# mission-control

A Claude Code mod that shows your session and its subagents in a live side panel.

## What it shows

- Workspace: folder, parent path and git branch.
- Main thread: model and effort, context used with a bar that turns from green to red, estimated cost, tokens sent and generated, and the 5-hour and 7-day limits.
- Subagent totals: how many ran, how many are running or failed, tokens, cost and time.
- One row per subagent, under "Running" or "Finished", indented under the agent that started it. Each row has a pixel crab, the title, model, effort, agent type, steps, cost, time, context and tokens.

## Using the panel

- The panel opens when a session starts. `/mission-control` opens and closes it.
- Finished and stopped runs fold to one line. The ▸ arrow unfolds them.
- The ■ button stops a running subagent once its current request or tool call ends. The agent that started it reads that it was stopped. The button exists only in the desktop app.
- The terminal shows the same data as text.

## Install

```text
/plugin marketplace add davidbalivo/mission-control
/plugin install mission-control@mission-control
```

Then run `/reload-plugins`.

## Cost is an estimate

Tokens from Claude Code × a price table. Price sources, first valid one wins:

1. Official pricing page, fetched at session start: `https://platform.claude.com/docs/en/about-claude/pricing.md`.
2. Last valid fetch, kept across sessions, if newer than the built-in table.
3. Built-in table `PRICES` in `hooks/register.tsx`, copied from that page on 2026-10-17.

A fetch with any doubtful value: discarded whole. No credentials and no user data in the request.

Not priced: fast mode, 1-hour cache writes, US-only inference. No signal from Claude Code for them.

## Step tool

Subagents report progress with the `step` tool, sending `done` and `total`. The panel draws it on the row as `3/5` and small blocks.

## Credits

mission-control started as a fork of `savvy-progress` from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit) (MIT).

## License

MIT. See [LICENSE](LICENSE).
