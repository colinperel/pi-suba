---
title: Changelog
description: Release notes for pi-suba.
---

## v0.3.0 (2026-09-11)

- Launch subagents in isolated workmux worktrees and finish verified integrations with `suba_finish`.
- Send non-blocking progress updates with `suba_notify`; `suba_ask` replaces `suba_ping` for blocking questions.
- Explicit completion now requires a summary and supports optional artifact paths.
- Show last-request context tokens in completion reports and subagent listings.
- Expose active subagent counts to other extensions and fix stale activity indicators.
- Failed sends to finished children include their latest result and resume guidance.
- Children launch and resume only in splits in the parent's current tmux window; placement overrides and settings are no longer supported.

## v0.2.0 (2026-09-07)

- Separate Pi environments keep independent Suba settings, profiles, instructions, and artifacts;
  subagents use the parent's Pi environment.
- Profile selection offers only available profiles and is hidden when only the default profile
  exists.

## v0.1.2 (2026-08-30)

- Subagents survive interrupted turns and continue after compaction instead of reporting a failure.
- Subagent completion can be retried after a temporary write failure, so results still reach the
  parent.
- Subagents use the configured tmux placement unless a specific layout is requested.
- Shared subagent grids preserve the full-height workmux sidebar.
- Long-running subagents no longer show false stale warnings during quiet operations.

## v0.1.1 (2026-08-29)

- Multiple split-placement subagents share the available vertical space evenly.

## v0.1.0 (2026-08-28)

- Initial release of `pi-suba`, with visible tmux subagents, asynchronous parent notifications,
  configurable child profiles and models, and split or dedicated-window placement.
