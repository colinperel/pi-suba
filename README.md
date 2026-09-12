# pi-suba

`pi-suba` is my spin on subagents in [Pi](https://pi.dev): delegated Pi sessions running visibly
in tmux.

Each subagent opens in a split in the parent's current tmux window, so you can watch it work,
inspect its output, and type into its session. Launches return after target creation without
waiting for the child result. Results and help requests arrive asynchronously in the parent session.

## Why pi-suba?

- **Visible:** every child is a real Pi TUI, not a hidden background process.
- **Non-blocking:** the parent can keep working after each child target is created.
- **Interactive:** the parent or user can send guidance to a live child.
- **Asynchronous:** completion, failure, and help requests start a new parent turn automatically.
- **Flexible:** choose models, thinking levels, tool access, context, prompts, and extensions.
- **Resumable:** continue a completed or interrupted child's existing session.

## Requirements

- [Pi](https://pi.dev)
- `tmux` on `PATH`
- A parent Pi session running inside tmux
- A compatible `workmux` on `PATH` for launches with `worktree: true`

## Install

```sh
pi install npm:pi-suba
```

Start Pi inside tmux:

```sh
tmux new -s pi
pi
```

## Quick start

Ask the parent to delegate an objective:

```text
/suba investigate the flaky login tests and fix the root cause
```

The parent identifies focused workstreams, launches one or more children, and continues without
waiting. Each child appears in tmux. When a child finishes or asks for guidance, its message appears
in the parent conversation and starts a new turn.

Running `/suba` without arguments opens a multiline task editor. If the parent is busy, the request
is queued as a follow-up.

## How configuration fits together

`pi-suba` works without any configuration files. Add them only when you want to customize how the
parent delegates or how children launch:

| Resource | Controls |
| --- | --- |
| `config.json` | Global launch defaults, extensions, and activity display |
| `instructions.md` | When and how the parent should delegate |
| `profiles/*.md` | Reusable child models, tools, context loading, and system prompts |
| `suba` arguments | Overrides for one child launch |
| `artifacts/` | Generated child sessions and runtime state |

The parent uses `instructions.md` to decide whether delegation fits the task. A launch selects a
profile, then applies any explicit tool arguments. Where the same model, thinking, or completion
setting appears in multiple places, the launch value wins over the profile, and the profile wins
over `config.json`.

A typical setup starts with `instructions.md`. Add `config.json` when you want shared defaults, and
add profiles when distinct kinds of children need different capabilities.

## How it works

1. The parent calls `suba` with a name and a focused task.
2. `pi-suba` creates a child session and launches Pi in tmux.
3. The child reports activity and lifecycle events through files under `~/.pi/agent/suba/artifacts/`.
4. A parent-side watcher updates the activity widget and delivers results.
5. The child completes automatically when settled, unless automatic completion is disabled.

The parent tool call returns as soon as tmux accepts the launch. Worktree provisioning, including
configured hooks, completes before tmux target creation. Results are pushed to the parent, so the
parent should never sleep or repeatedly poll for completion.

## Delegation and context

Children use fresh context by default and receive no parent conversation. Prefer fresh context
for self-contained tasks and parallel children with separate scopes, especially when they can
modify files. Supply the required context in the task or point to accessible authoritative sources
instead of copying them into a handoff.

For an existing task, name its repository, workspace, reference, and commands to read it. For
example, an Aven assignment can give the task reference and workspace with `aven context REF` and
`aven show REF --full` as read commands. A reference without enough information to find and read
it is not self-contained.

Put task-relevant coordination in the launch prompt. Include coordination only when it affects
the child's scope, dependencies, shared resources, or authority. Omit unrelated parent activity.
Create a handoff only for reusable context not already available from those sources, such as a
shared design decision or cross-task constraint. Create it before launching dependent children,
and name the file and its purpose in their tasks.

Use `context: "fork"` only when essential conversation history cannot be supplied in the task or
referenced material. Forking copies the parent branch up to, but not including, the latest user
message. Inherited history is background; the latest assignment defines the child's scope.

### Resume or start fresh

When a follow-up arrives, resume the child when its accumulated knowledge is costly to
reconstruct, such as an active implementation failure, a subtle continuation of an
investigation, or retesting resources it created and owns. Prefer a fresh child, or parent
execution when that matches the coordinator role, for a self-contained mechanical correction
with a complete diagnosis or a different workstream.

A completed task or phase boundary alone is not a reason to discard useful context. Reuse can
preserve design rationale, rejected approaches, API discoveries, and resource ownership. Treat
[last-request context tokens](#last-request-context-tokens) as a decision aid, not an exact cost
estimate or automatic cutoff. Apply the same judgment when token metadata is unavailable.

## Parent tools

| Tool          | Purpose                                               |
| ------------- | ----------------------------------------------------- |
| `suba`        | Launch a child and return after target creation       |
| `suba_send`   | Send guidance to a live child by ID                   |
| `suba_finish` | Record a verified result and close an idle or awaiting-parent child pane |
| `suba_resume` | Continue a completed or exited child's session        |
| `suba_list`   | Take a one-time snapshot of child status and activity |

The `suba` tool accepts:

| Parameter      | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| `name`         | Short label for the child                                    |
| `task`         | Focused, self-contained assignment                           |
| `profile`      | Child profile name, exposed when multiple profiles exist     |
| `context`      | `fresh` or `fork`                                            |
| `model`        | Fully qualified `provider/model` identifier                  |
| `thinking`     | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `cwd`          | Source directory, resolved relative to the parent directory  |
| `worktree`     | Provision a persistent workmux worktree for the child        |
| `autoComplete` | Per-launch automatic completion override                     |

Explicit models must exist in Pi's model registry and belong to the active model scope.

## Worktree launches

Use `worktree: true` for children modifying code in parallel with the parent or
other children. Omit it for read-only tasks. To keep a child available for merge
approval, set `autoComplete: false` and ask it to request approval with `suba_ask`
instead of finishing with `suba_done`:

```json
{
  "name": "review parser",
  "task": "Fix the parser, validate, and commit the result. Request merge approval with suba_ask, then wait. After merging, report success or a blocker with suba_ask and wait for the parent to finish the session. Do not call suba_done.",
  "worktree": true,
  "autoComplete": false
}
```

`pi-suba` derives the branch and handle as
`suba-<slugged-name>-<child-id>`, then runs:

```sh
workmux add <handle> --name <handle> --headless --json
```

Workmux applies its normal worktree path configuration, file operations, and
`post_create` hooks. These hooks execute shell commands with the parent user's
permissions, so worktree launches require trusted workmux configuration. Workmux
does not create a workmux-managed session, window, pane, layout, or pane command.
Pi-suba launches the child in the effective working directory returned by
workmux.

The child owns implementation, validation, and commits within its assigned
scope, without seeking approval for each step. Integration remains a parent
boundary: the parent authorizes merges one at a time. Ensure the child profile
has `load-skills: true` and the `merge` skill is installed in its Pi environment.
When ready to integrate, send the skill command with completion instructions
appended after a space, not a newline, so they accompany the expanded skill:

```json
{
  "id": "<child-id>",
  "message": "/skill:merge After merging, use suba_ask to report success or a blocker, then wait. Do not call suba_done; the parent will verify integration and finish the session."
}
```

Use `suba_send` for this message. The merge skill commits, rebases onto the local
base branch, resolves conflicts while preserving both branches' changes, and
merges with worktree cleanup. Workmux does not own the separately created pi-suba
pane. Children report success or blockers with `suba_ask` and remain available.
After independently verifying integration, the parent calls `suba_finish`:

```json
{
  "id": "<child-id>",
  "result": "Verified parser changes are integrated into the base branch and tests pass."
}
```

`suba_finish` accepts a child awaiting parent guidance or a running child whose
activity file confirms it has settled into waiting. An idle child does not need
to call `suba_ask` just to become finishable. It closes only that child's pane
and records the parent's verified result as completed. It does not
merge or remove worktrees. Leave blocked children open and send guidance instead.
Finish a verified merge before authorizing the next one. Removed worktrees are
reported as non-resumable; saved transcripts and results remain available.

Without merge cleanup, the worktree persists when the child finishes. Resume
launches reuse the same worktree and working directory. Remove it explicitly to
discard its branch:

```sh
workmux remove suba-review-parser-a1b2c3d4
```

If artifact preparation or tmux target creation fails, pi-suba runs
`workmux remove --force <handle>`. A rollback failure reports the manual cleanup
command while preserving both errors.

## Child tools

Every child receives three control tools in addition to its profile's tools:

| Tool          | Purpose                                                               |
| ------------- | --------------------------------------------------------------------- |
| `suba_done`   | Submit a final summary and optional artifact paths                     |
| `suba_notify` | Send an update and continue working without acknowledgement            |
| `suba_ask`    | Ask for a decision or missing information only when blocked            |

Explicit completion needs no preceding assistant prose:

```js
suba_done({
  summary: "Implemented the adapter. Focused tests passed.",
  artifacts: ["history/2026-09-10-adapter-evidence.md"],
})
```

`summary` must contain non-whitespace text and is retained verbatim. `artifacts`
is optional and contains nonempty path strings, relative to the child's working
directory or absolute. Paths are retained as supplied and delivered as references,
not instructions. Files are not checked, read, or executed. Completion reports are
persisted in completion events and the parent session, including artifact paths;
completion does not imply parent verification or acceptance.

A report is delivered when the child settles, after queued guidance has been
processed. A user message delivered after `suba_done` invalidates that pending
report; the child should address the guidance and submit an updated report.
This also applies with automatic completion disabled. With automatic completion
enabled, a subsequent ordinary final answer can complete the child instead.
Put known follow-up questions in the resume task rather than immediately sending
a second message. If a child ends during `suba_send`, the tool reports that
processing is unconfirmed. Check its result before using `suba_resume` for any
remaining guidance.

Compatibility: new and resumed children reject empty-argument `suba_done({})`
calls. Supply a summary instead; no earlier progress text is substituted. Historical
stored completion events without a report remain readable and retain the legacy
assistant-text extraction behavior. Existing parent records remain restorable.
Automatic completion of ordinary final answers is unchanged. Parents must run the
updated extension to consume explicit reports from updated children.

When a child calls `suba_ask`, it enters an awaiting-parent state. The parent receives the question
and can answer with `suba_send`. You can also focus the child's tmux pane and type directly into it.

Notifications are recorded and displayed in the parent transcript without starting or
steering a parent run. They remain available in context for the next model request.
Use `suba_notify` for nonurgent updates and continue working. Use `suba_ask` for blockers,
decisions, or urgent issues that need parent action now; it wakes the parent and pauses
the child until guidance arrives. Results also wake the parent.

Historical `ping` event files remain supported as blocking questions, including on parent
restoration. Existing transcript calls to `suba_ping` remain historical records, but the old
tool is no longer registered or callable. Resumed children receive instructions to use
`suba_ask` instead; update custom prompts and tool allowlists that name `suba_ping`.
Already-running children can still emit legacy `ping` events to an updated parent.

## Configuration

Subagent resources live under `<agent-dir>/suba/`, where `<agent-dir>` is Pi's
`PI_CODING_AGENT_DIR` (default `~/.pi/agent`). For example,
`PI_CODING_AGENT_DIR=~/.pi-work/agent` uses `~/.pi-work/agent/suba/`.
Each agent directory has independent configuration, instructions, profiles, and artifacts.
Child processes receive the parent's resolved agent directory explicitly.

Default layout:

```text
~/.pi/agent/suba/
├── config.json
├── instructions.md
├── profiles/
└── artifacts/
```

All files are optional. Configuration and profiles have built-in defaults. Without
`instructions.md`, the extension adds no standing delegation policy to the parent prompt.

### `config.json`

```json
{
  "defaultProfile": "default",
  "model": "openai-codex/gpt-5.6-sol",
  "thinking": "medium",
  "autoComplete": true,
  "childExtensions": ["npm:some-pi-package"],
  "activity": {
    "pollMs": 500,
    "maxRows": 8
  }
}
```

| Setting                 | Built-in default      | Purpose                                     |
| ----------------------- | --------------------- | ------------------------------------------- |
| `defaultProfile`        | `"default"`           | Profile used when a launch omits one        |
| `model`                 | Pi default            | Default child model                         |
| `thinking`              | Pi default            | Default child thinking level                |
| `autoComplete`          | `true`                | Finish a child when its agent settles       |
| `childExtensions`       | `[]`                  | Additional extensions loaded in every child |
| `activity.pollMs`       | `500`                 | Parent watcher interval in milliseconds     |
| `activity.maxRows`      | `8`                   | Maximum rows in the activity widget         |

Model, thinking, and automatic completion settings resolve in this order:

1. Launch override
2. Profile
3. Global configuration
4. Pi default, where applicable

Children start with automatic extension discovery disabled. `childExtensions` lists the packages or
files loaded explicitly in every child. It accepts npm package sources, absolute paths, `~/` paths,
and relative paths. Relative paths resolve from the active Pi agent directory, matching relative
package sources in Pi settings.

Configuration and profiles are read when the parent session starts.

### `instructions.md`

`~/.pi/agent/suba/instructions.md` is appended to the parent system prompt. It is user policy, not
required configuration. Keep it to delegation decisions and model routing; the sections on
[context](#delegation-and-context) and [worktree integration](#worktree-launches) provide examples
and operational details.

This is a reasonable starting point:

```markdown
# Subagent delegation

Use suba for explicit delegation requests or a separate workstream the parent
will not also perform, not merely for second opinions, self-review, or
validation. Keep single-target reviews and investigations with the parent
unless the user requests delegated review. Use an active skill's specified
consultation mechanism.

Use fresh context with a self-contained task or authoritative references,
repository/workspace context, and commands to read them. Put task-relevant
coordination in the launch prompt; use handoffs only for additional reusable
context. Include coordination only when it affects the child's scope,
dependencies, shared resources, or authority. Omit unrelated parent activity.
Fork only when essential conversation history cannot be supplied this way.
The latest assignment defines scope; inherited history is background.

Resume when accumulated knowledge is costly to reconstruct. Prefer a fresh
child, or parent execution when its role permits, for a self-contained, fully
diagnosed mechanical correction or a different workstream. Completion or phase
boundaries alone do not justify restarting. Last-request context-token counts,
when available, are a decision aid, not a cutoff.

Delegate outcomes, not steps, with clear scope and authority. Require approval
only to cross ownership boundaries, change agreed contracts, or exceed
authorization. Worktree merges require parent approval and verification before
`suba_finish`.

Put known follow-up questions in the launch or resume task rather than sending
an immediate second message. For follow-up reviews, start with changes since
the last reviewed version and relevant tests; expand as needed. Report unresolved
findings and changed conclusions, with severity qualifications included.

Keep short findings inline. For substantial reviews another child must use,
allow a dated report in `history/` without allowing product-source edits. Return
a brief verdict and the report path; relay accepted actions and qualifications
with that path rather than rewriting the report. Do not require a file for every
exchange.

# Subagent model selection

Use configured model and thinking defaults unless another available model
better fits the task.
```

Replace the model-selection paragraph with concrete model and thinking guidance when you want the
parent to route different kinds of work differently.

## Profiles

Profiles are Markdown files under `~/.pi/agent/suba/profiles/`. Frontmatter controls how the child
launches, and the Markdown body becomes part of its system prompt.

```markdown
---
name: explore
description: Read-only investigation
model: anthropic/claude-haiku-4-5
thinking: low
tools: read-only
load-context: false
load-skills: false
system-prompt: append
auto-complete: true
---

Investigate the delegated task without modifying files. Report concrete findings with relevant file
paths.
```

Supported fields:

| Field           | Default        | Description                          |
| --------------- | -------------- | ------------------------------------ |
| `name`          | File name      | Profile identifier                   |
| `description`   | None           | Summary shown to the parent          |
| `model`         | Global setting | Fully qualified child model          |
| `thinking`      | Global setting | Child thinking level                 |
| `tools`         | `default`      | Tool policy                          |
| `load-context`  | `true`         | Load Pi context files                |
| `load-skills`   | `true`         | Load Pi skills                       |
| `system-prompt` | `append`       | Append or replace Pi's system prompt |
| `auto-complete` | Global setting | Profile completion behavior          |

Two tool policies are available:

| Policy      | Child tools                     |
| ----------- | ------------------------------- |
| `default`   | `read`, `bash`, `edit`, `write` |
| `read-only` | `read`, `bash`                  |

Both policies also include `suba_done`, `suba_notify`, and `suba_ask`. `read-only` limits Pi's direct tool
selection, but `bash` can still modify the filesystem. It is not a security boundary.

A built-in `default` profile is always available. It uses the default tool policy, loads context
files and skills, and adds no profile prompt. Create `profiles/default.md` to customize it.

## Tmux splits

Launch and resume always create a split in the parent's current tmux window. The first
child opens beside the parent; additional children stack below it with equal heights.
Only panes owned by that parent are grouped. There is no placement argument or setting.
Launch and resume schemas reject obsolete placement arguments; remove them from saved
launch recipes.

Legacy `placement` and `sharedWindowName` config keys are accepted but ignored and can
be removed. Stored child `placement` and `windowId` fields are discarded on restoration.
Existing live children stay in their panes and remain watchable, reachable, and finishable.
Resuming uses the current parent pane, never a historical child window. Historical tool
results remain readable without displaying obsolete placement metadata.

## Activity, completion, and resume

While children are live, the parent TUI shows an activity widget above the editor. It includes each
child's state, current model or tool activity, thinking level, and elapsed time.

Completed reports appear as compact previews. Expand the message with Pi's normal tool-output
control to read the full report and metadata.

With automatic completion enabled, a child finishes when its agent settles. Set `autoComplete` or
profile `auto-complete` to `false` to keep it interactive until it calls `suba_done`, exits, or
receives more input.

If a child closes before recording completion, it is marked interrupted. Use `suba_resume` with its
stable child ID to continue the same session with a new task.

`suba_send` delivers only to live children. If a known child has already reached a terminal state,
its failed response says the message was not delivered, includes the bounded latest result or failure
when available, and gives the stable ID for `suba_resume`. An unknown ID is reported separately and
is not presented as resumable. A failed send never resumes a child automatically.

### Last-request context tokens

Completion notifications and `suba_list` include the latest measured child
request context, including cached input. The JSON field
`lastRequestContextTokens` is the exact reported count; the accompanying label
is `Last request context`. It is not cumulative usage or a prediction of the
next request. Guidance, tool changes, or compaction can change the next size.

The measurement uses Pi's normalized assistant usage: `input + cacheRead + cacheWrite`. Output tokens and the `cacheWrite1h` subset are not added. Missing,
incomplete, or all-zero provider usage is unavailable, not a measured zero.
If a later request has no usable measurement, the latest known one is retained.
The value persists with child status and is reconstructed from the child
session's active branch on resume. This is informational only, with no cost
estimate, cutoff, or required status lookup.

### Inter-extension activity

The parent extension emits `suba:activity` on `pi.events` with an unversioned
`{ activeCount: number }` snapshot for the current parent session. The count includes children
starting or working, including newly launched children before their first activity file. Waiting
children and terminal records are excluded, independently of the TUI widget.

Snapshots are emitted when the count changes, after restored children have been checked, and as
`{ activeCount: 0 }` on session teardown. Other extensions can subscribe and then emit
`suba:activity:request` to request the current snapshot. Requests before restoration finishes are
satisfied by the restoration snapshot, not a provisional zero. The request listener is removed on
teardown. Child changes are observed at the configured `activity.pollMs` interval, also without a UI.

## Artifacts and environment variables

Each child stores its session, prompt files, activity, lifecycle events, launch script, and process
status under:

```text
~/.pi/agent/suba/artifacts/<parent-session-id>/<child-id>/
```

The parent registry is persisted in the parent Pi session, so reopening that session restores known
child records and resumes watching live children.

| Variable             | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `SUBA_ARTIFACT_ROOT` | Override the artifact directory                        |
| `SUBA_PI_EXECUTABLE` | Select the executable used to launch child Pi sessions |

## Development

```sh
npm install
npm test
npm run check
```

`npm run check` runs type checking, tests, and linting. Use `npm run format` to format source files.

Cua sandbox helpers provide deterministic desktop testing with fake child Pi processes and optional
real-model smoke coverage. See [`CUA_SANDBOX.md`](CUA_SANDBOX.md).

## Release

Releases require an upstream Git branch, npm authentication, and the `npm-release` command from
[`rust-release-tools`](https://github.com/raine/rust-release-tools).

```sh
just release          # patch release
just release minor
just release major
just release current  # release the current package version
```

See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
