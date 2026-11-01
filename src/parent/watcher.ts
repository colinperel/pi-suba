import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  completionReportText,
  readActivity,
  readEvents,
  type ChildEvent,
} from "../shared/protocol.ts"
import { extractResult } from "../shared/sessions.ts"
import {
  launchScriptPath,
  parentTeardownPath,
  processExists,
  rpcFailurePath,
} from "../shared/control.ts"
import { closeTerminal, legacyPaneExists } from "../shared/terminal.ts"
import type { ChildRecord } from "./registry.ts"

export interface WatcherCallbacks {
  list(): ChildRecord[]
  get(id: string): ChildRecord | undefined
  update(record: ChildRecord, notify?: { type: "result" | "ask" | "notify"; content: string }): void
  activity(record: ChildRecord): void
}

// A child's Pi session writes activity.json as soon as it starts. A live child
// with none by then is stuck before Pi loads, typically on an interactive
// prompt in its terminal that nobody watches.
export const STARTUP_TIMEOUT_MS = 60_000

export class ChildWatcher {
  private timer?: NodeJS.Timeout
  private generation = 0
  private checks = new Map<string, Promise<void>>()
  private startupWarned = new Set<string>()
  constructor(
    private readonly pollMs: number,
    private readonly callbacks: WatcherCallbacks,
  ) {}
  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.pollMs)
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.generation += 1
    this.checks.clear()
  }
  async tick(): Promise<void> {
    await Promise.all(this.callbacks.list().map((record) => this.check(record.id)))
  }
  check(id: string): Promise<void> {
    const pending = this.checks.get(id)
    if (pending) return pending
    const check = this.checkRecord(id).finally(() => {
      if (this.checks.get(id) === check) this.checks.delete(id)
    })
    this.checks.set(id, check)
    return check
  }
  private async checkRecord(id: string): Promise<void> {
    let record = this.callbacks.get(id)
    if (!record || !["launching", "running", "awaiting-parent"].includes(record.state)) return
    const generation = this.generation
    const current = () => generation === this.generation && this.callbacks.get(id) === record
    let freshWorking = false
    try {
      const activity = await readActivity(join(record.artifactDir, "activity.json"), id)
      if (!current()) return
      if (!record.activity || activity.sequence > record.activity.sequence) {
        freshWorking = activity.state === "working"
        record = {
          ...record,
          activity,
          lastRequestContextTokens:
            activity.lastRequestContextTokens ?? record.lastRequestContextTokens,
          activityError: undefined,
        }
        this.callbacks.activity(record)
      }
    } catch (error) {
      if (!current()) return
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        record = {
          ...record,
          activityError: error instanceof Error ? error.message : String(error),
        }
        this.callbacks.activity(record)
      }
    }
    // A visible exit marker implies terminal events/RPC failures were already
    // published. Take that snapshot before reading either outcome channel.
    const exitPath = join(record.artifactDir, "process-exit")
    let exitCode: number | undefined
    let exitReadError: unknown
    try {
      exitCode = Number.parseInt((await readFile(exitPath, "utf8")).trim(), 10)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") exitReadError = error
    }
    if (!current()) return
    let events: ChildEvent[]
    try {
      events = await readEvents(record.artifactDir, record.lastEventSequence)
      if (!current()) return
    } catch (error) {
      if (!current()) return
      this.callbacks.activity({
        ...record,
        activityError: error instanceof Error ? error.message : String(error),
      })
      return
    }
    for (const event of events) {
      if (event.childId !== id || event.sequence !== record.lastEventSequence + 1) {
        this.callbacks.activity({
          ...record,
          activityError: `invalid event sequence ${event.sequence}`,
        })
        return
      }
      record = {
        ...record,
        revision: record.revision + 1,
        lastEventSequence: event.sequence,
      }
      if (event.type === "notify") {
        this.callbacks.update(record, {
          type: "notify",
          content: `Subagent ${record.name} (${id}) update (no response required):\n\n${event.message}`,
        })
      } else if (event.type === "ask" || event.type === "ping") {
        freshWorking =
          record.activity?.state === "working" && record.activity.updatedAt >= event.timestamp
        record.state = freshWorking ? "running" : "awaiting-parent"
        this.callbacks.update(record, {
          type: "ask",
          content: `Subagent ${record.name} (${id}) needs guidance:\n\n${event.message}`,
        })
      } else if (event.type === "failed") {
        record.state = "failed"
        record.error = event.error
        const stored = this.callbacks.get(id)
        if (record.target?.kind === "background") await closeTerminal(record.target)
        if (generation !== this.generation || this.callbacks.get(id) !== stored) return
        this.callbacks.update(record, {
          type: "result",
          content: `Subagent ${record.name} (${id}) failed: ${event.error}`,
        })
        return
      } else if (event.type === "completed") {
        // The event revision is local until the result has been read.
        const stored = this.callbacks.get(id)
        const result = event.report
          ? { text: event.report.summary, error: undefined, lastRequestContextTokens: undefined }
          : await extractResult(record.sessionFile, record.resultAfterEntry)
        if (generation !== this.generation || this.callbacks.get(id) !== stored) return
        record.state = result.error ? "failed" : "completed"
        record.error = result.error
        record.result = result.text
        record.report = event.report
        record.lastRequestContextTokens =
          result.lastRequestContextTokens ?? record.lastRequestContextTokens
        const content = result.error
          ? `Subagent ${record.name} (${id}) failed: ${result.error}`
          : `Subagent ${record.name} (${id}) completed:\n\n${event.report ? completionReportText(event.report) : (result.text ?? "(no assistant text)")}`
        if (record.target?.kind === "background") await closeTerminal(record.target)
        if (generation !== this.generation || this.callbacks.get(id) !== stored) return
        this.callbacks.update(record, { type: "result", content })
        return
      }
    }
    if (record.state === "awaiting-parent" && freshWorking) {
      record = { ...record, revision: record.revision + 1, state: "running" }
      this.callbacks.update(record)
    }
    if (!current()) return
    if (!["launching", "running", "awaiting-parent"].includes(record.state)) return
    if (record.target?.kind === "background" && record.runId) {
      try {
        const failure = JSON.parse(
          await readFile(rpcFailurePath(record.artifactDir, record.runId), "utf8"),
        ) as { error?: unknown }
        if (!current()) return
        if (typeof failure?.error !== "string") throw new Error("Invalid background RPC failure")
        await closeTerminal(record.target)
        if (!current()) return
        this.callbacks.update(
          { ...record, revision: record.revision + 1, state: "failed", error: failure.error },
          {
            type: "result",
            content: `Subagent ${record.name} (${id}) failed: ${failure.error}`,
          },
        )
        return
      } catch (error) {
        if (!current()) return
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.callbacks.activity({
            ...record,
            activityError: error instanceof Error ? error.message : String(error),
          })
          return
        }
      }
    }
    if (exitReadError !== undefined) throw exitReadError
    if (exitCode !== undefined) {
      let parentTeardown = false
      if (record.target?.kind === "background" && record.runId) {
        try {
          await readFile(parentTeardownPath(record.artifactDir, record.runId), "utf8")
          parentTeardown = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      if (!current()) return
      const result: Awaited<ReturnType<typeof extractResult>> = parentTeardown
        ? {}
        : await extractResult(record.sessionFile, record.resultAfterEntry)
      if (!current()) return
      // RPC Pi exits 0 for both parent stdin closure and a child-initiated
      // shutdown, so background exits are never inferred as completed.
      if (
        record.target?.kind === "background" &&
        (parentTeardown || (exitCode === 0 && !result.error))
      ) {
        this.callbacks.update(
          {
            ...record,
            revision: record.revision + 1,
            state: "interrupted",
            error: `background process exited with status ${exitCode} before completion`,
          },
          {
            type: "result",
            content: `Subagent ${record.name} (${id}) was interrupted because its process exited with status ${exitCode} before completion.`,
          },
        )
        return
      }
      const failed = exitCode !== 0 || !!result.error
      const next = {
        ...record,
        revision: record.revision + 1,
        state: failed ? ("failed" as const) : ("completed" as const),
        result: result.text,
        lastRequestContextTokens:
          result.lastRequestContextTokens ?? record.lastRequestContextTokens,
        error: result.error ?? (exitCode ? `Pi exited with status ${exitCode}` : undefined),
      }
      this.callbacks.update(next, {
        type: "result",
        content: failed
          ? `Subagent ${record.name} (${id}) failed: ${next.error}`
          : `Subagent ${record.name} (${id}) completed:\n\n${next.result ?? "(no assistant text)"}`,
      })
      return
    }
    let alive: boolean | undefined
    try {
      alive = record.runId
        ? await processExists(record.artifactDir, record.runId)
        : record.paneId
          ? await legacyPaneExists(record.paneId)
          : true
    } catch (error) {
      if (current())
        this.callbacks.activity({
          ...record,
          activityError: error instanceof Error ? error.message : String(error),
        })
      return
    }
    if (!current()) return
    if (alive === false || (alive === undefined && Date.now() - record.startedAt > 10000)) {
      // Recheck the exit marker on the next tick: the wrapper may have written it
      // between our first read and the process check.
      try {
        await readFile(exitPath, "utf8")
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (!current()) return
      try {
        const lateEvents = await readEvents(record.artifactDir, record.lastEventSequence)
        if (!current() || lateEvents.length > 0) return
      } catch (error) {
        if (current())
          this.callbacks.activity({
            ...record,
            activityError: error instanceof Error ? error.message : String(error),
          })
        return
      }
      const next = {
        ...record,
        revision: record.revision + 1,
        state: "interrupted" as const,
        error: "child process exited before completion",
      }
      this.callbacks.update(next, {
        type: "result",
        content: `Subagent ${record.name} (${id}) was interrupted because its process exited before completion.`,
      })
      return
    }
    this.warnIfNotStarted(record)
  }
  private warnIfNotStarted(record: ChildRecord): void {
    if (record.state !== "running" || record.activity) return
    const waited = Date.now() - record.startedAt
    if (waited < STARTUP_TIMEOUT_MS) return
    const key = `${record.id}:${record.runId ?? record.startedAt}`
    if (this.startupWarned.has(key)) return
    this.startupWarned.add(key)
    const script = record.runId
      ? launchScriptPath(record.artifactDir, record.runId)
      : join(record.artifactDir, "launch.sh")
    const terminal = record.target
      ? `${record.target.kind} target ${record.target.id}`
      : record.paneId
        ? `tmux pane ${record.paneId}`
        : "its terminal"
    this.callbacks.update(
      { ...record, revision: record.revision + 1 },
      {
        type: "ask",
        content: `Subagent ${record.name} (${record.id}) has not started ${Math.round(waited / 1000)}s after launch: its Pi session has reported no activity. The launch may be waiting on an interactive prompt or stuck before Pi loads. Inspect ${terminal}; launch script: ${script}`,
      },
    )
  }
}
