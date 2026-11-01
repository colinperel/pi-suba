---
title: Changelog
description: Release notes for pi-suba.
---

## Unreleased

- Allow configured extension tools in children with the additive `childTools` setting.
- Launch visible children in tmux or Rex, with background RPC children everywhere else.
- Send guidance and orderly shutdown through per-launch inboxes instead of simulated typing.
- Track child processes independently of terminal panes, preserving artifacts and worktrees when a native launch cannot be confirmed.
- Keep pre-inbox children watchable and finishable; resume them to enable inbox guidance.
- Remove `worktree: true` and the workmux requirement: create a linked worktree with git and pass it as `cwd`. Children are resumable only while their working directory exists.

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
