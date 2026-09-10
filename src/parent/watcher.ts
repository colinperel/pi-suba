import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  completionReportText,
  readActivity,
  readEvents,
  type ChildEvent,
} from "../shared/protocol.ts"
import { extractResult } from "../shared/sessions.ts"
import { paneExists } from "../shared/tmux.ts"
import type { ChildRecord } from "./registry.ts"

export interface WatcherCallbacks {
  list(): ChildRecord[]
  get(id: string): ChildRecord | undefined
  update(record: ChildRecord, notify?: { type: "result" | "ask" | "notify"; content: string }): void
  activity(record: ChildRecord): void
}

export class ChildWatcher {
  private timer?: NodeJS.Timeout
  private generation = 0
  private checks = new Map<string, Promise<void>>()
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
    const exitPath = join(record.artifactDir, "process-exit")
    try {
      const exitCode = Number.parseInt((await readFile(exitPath, "utf8")).trim(), 10)
      if (!current()) return
      const result = await extractResult(record.sessionFile, record.resultAfterEntry)
      if (!current()) return
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
    } catch (error) {
      if (!current()) return
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (record.paneId && !(await paneExists(record.paneId))) {
      if (!current()) return
      const next = {
        ...record,
        revision: record.revision + 1,
        state: "interrupted" as const,
        error: "tmux pane closed before completion",
      }
      this.callbacks.update(next, {
        type: "result",
        content: `Subagent ${record.name} (${id}) was interrupted because its tmux pane closed.`,
      })
    }
  }
}
