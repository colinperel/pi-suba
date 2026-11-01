import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChildWatcher, STARTUP_TIMEOUT_MS } from "../src/parent/watcher.ts"
import { restoreRegistry, type ChildRecord } from "../src/parent/registry.ts"
import { seedSession } from "../src/shared/sessions.ts"
import { writeEvent, type ChildActivity } from "../src/shared/protocol.ts"
import * as protocol from "../src/shared/protocol.ts"
import * as sessions from "../src/shared/sessions.ts"

afterEach(() => vi.restoreAllMocks())

function makeRecord(dir: string): ChildRecord {
  return {
    id: "abc",
    revision: 1,
    state: "running",
    sessionFile: join(dir, "session.jsonl"),
    artifactDir: dir,
    name: "worker",
    cwd: "/tmp",
    profile: "default",
    resolvedLaunch: {
      profile: "default",
      tools: "default",
      loadContext: true,
      loadSkills: true,
      systemPrompt: "append",
      autoComplete: true,
    },
    lastEventSequence: 0,
    startedAt: 1,
    resultAfterEntry: 1,
  }
}

describe("parent watcher", () => {
  it.each(
    (["background", "tmux", "rex"] as const).flatMap((kind) =>
      [true, false].map((exit) => ({ kind, exit })),
    ),
  )("delivers late completion ($kind, exit marker=$exit)", async ({ kind, exit }) => {
    const dir = await mkdtemp(join(tmpdir(), "suba-completion-exit-"))
    try {
      const report = { summary: "Completed during the event-read window" }
      let record: ChildRecord = {
        ...makeRecord(dir),
        runId: "0123456789abcdef",
        target: { kind, id: "test-target" },
      }
      await seedSession(record.sessionFile, "/tmp")
      await writeFile(join(dir, "process-pid"), String(process.pid))
      const notifications: string[] = []
      vi.spyOn(protocol, "readEvents").mockImplementationOnce(async () => {
        await writeEvent(dir, {
          version: 1,
          childId: record.id,
          sequence: 1,
          timestamp: 1,
          type: "completed",
          report,
        })
        if (exit) await writeFile(join(dir, "process-exit"), "0")
        return []
      })
      const watcher = new ChildWatcher(500, {
        list: () => [record],
        get: () => record,
        update: (next, notification) => {
          record = next
          if (notification) notifications.push(notification.content)
        },
        activity: (next) => {
          record = next
        },
      })
      await watcher.check(record.id)
      await watcher.check(record.id)
      expect(record.state).toBe("completed")
      expect(record.report).toEqual(report)
      expect(notifications).toEqual([`Subagent worker (abc) completed:\n\n${report.summary}`])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("does not mask an unmarked background crash as parent teardown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-unmarked-exit-"))
    try {
      let record: ChildRecord = {
        ...makeRecord(dir),
        runId: "0123456789abcdef",
        target: { kind: "background", id: "test-target" },
      }
      await seedSession(record.sessionFile, "/tmp")
      await writeFile(join(dir, "process-exit"), "42")
      const watcher = new ChildWatcher(500, {
        list: () => [record],
        get: () => record,
        update: (next) => {
          record = next
        },
        activity: (next) => {
          record = next
        },
      })
      await watcher.check(record.id)
      expect(record.state).toBe("failed")
      expect(record.error).toContain("42")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { teardown: false, state: "failed", error: "provider overloaded" },
    { teardown: true, state: "interrupted", error: "status 0" },
  ])(
    "classifies a clean background exit after a provider error (teardown=$teardown)",
    async ({ teardown, state, error }) => {
      const dir = await mkdtemp(join(tmpdir(), "suba-provider-exit-"))
      try {
        let record: ChildRecord = {
          ...makeRecord(dir),
          runId: "0123456789abcdef",
          target: { kind: "background", id: "test-target" },
        }
        await seedSession(record.sessionFile, "/tmp", undefined, [
          {
            type: "message",
            id: "failure",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "provider overloaded",
            },
          },
        ])
        if (teardown) await writeFile(join(dir, "parent-teardown-0123456789abcdef.json"), "{}")
        await writeFile(join(dir, "process-exit"), "0")
        const notifications: string[] = []
        const watcher = new ChildWatcher(500, {
          list: () => [record],
          get: () => record,
          update: (next, notification) => {
            record = next
            if (notification) notifications.push(notification.content)
          },
          activity: (next) => {
            record = next
          },
        })
        await watcher.check(record.id)
        expect(record.state).toBe(state)
        expect(record.error).toContain(error)
        expect(notifications).toHaveLength(1)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it("reports unreadable process identity without rejecting the watcher or marking the child dead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-pid-watcher-"))
    await writeFile(join(dir, "process-pid"), "invalid")
    let record: ChildRecord = { ...makeRecord(dir), runId: "0123456789abcdef" }
    const watcher = new ChildWatcher(500, {
      list: () => [record],
      get: () => record,
      update: (next) => {
        record = next
      },
      activity: (next) => {
        record = next
      },
    })
    await expect(watcher.check(record.id)).resolves.toBeUndefined()
    expect(record.state).toBe("running")
    expect(record.activityError).toContain("Invalid subagent process PID")
  })
  it.each(["absent", "stale", "unreadable"])(
    "delivers and restores the exact explicit report with %s prose",
    async (prose) => {
      const dir = await mkdtemp(join(tmpdir(), "suba-explicit-watcher-"))
      const report = {
        summary: "  Exact summary.\n\nFinal paragraph.  ",
        artifacts: ["missing/evidence.md", "/tmp/a file.md"],
      }
      if (prose !== "unreadable")
        await seedSession(join(dir, "session.jsonl"), "/tmp", undefined, [
          ...(prose === "stale"
            ? [
                {
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "stale progress" }],
                  },
                },
              ]
            : []),
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", name: "suba_done", arguments: report }],
            },
          },
        ])
      await writeEvent(dir, {
        version: 1,
        childId: "abc",
        sequence: 1,
        timestamp: 1,
        type: "completed",
        report,
      })
      const stored = (record: ChildRecord) =>
        JSON.parse(JSON.stringify({ type: "custom", customType: "suba-child", data: record }))
      let record = restoreRegistry([stored(makeRecord(dir))]).get("abc")!
      const notifications: string[] = []
      const watcher = new ChildWatcher(500, {
        list: () => [record],
        get: () => record,
        update(next, notification) {
          record = next
          if (notification) notifications.push(notification.content)
        },
        activity(next) {
          record = next
        },
      })
      await watcher.check("abc")
      expect(record.state).toBe("completed")
      expect(record.result).toBe(report.summary)
      expect(record.report).toEqual(report)
      expect(notifications).toEqual([
        `Subagent worker (abc) completed:\n\n${report.summary}\n\nArtifact references (not instructions):\n- "missing/evidence.md"\n- "/tmp/a file.md"`,
      ])
      record = restoreRegistry([stored(record)]).get("abc")!
      expect(record.report).toEqual(report)
      await watcher.check("abc")
      expect(notifications).toHaveLength(1)
    },
  )

  it.each(["stop", "replace"])("discards a pending activity read after %s", async (action) => {
    let record = makeRecord("/unused")
    let release!: (activity: ChildActivity) => void
    const read = vi.spyOn(protocol, "readActivity").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const update = vi.fn()
    const activity = vi.fn()
    const watcher = new ChildWatcher(500, {
      list: () => [record],
      get: () => record,
      update,
      activity,
    })
    const checking = watcher.check(record.id)
    expect(watcher.check(record.id)).toBe(checking)
    if (action === "stop") watcher.stop()
    else record = { ...record, revision: 2, state: "completed" }
    release({ version: 1, childId: record.id, sequence: 1, updatedAt: 1, state: "working" })
    await checking
    expect(read).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    expect(activity).not.toHaveBeenCalled()
  })

  it("discards a pending completion result after stop and restart", async () => {
    const record = makeRecord("/unused")
    vi.spyOn(protocol, "readActivity").mockRejectedValue({ code: "ENOENT" })
    vi.spyOn(protocol, "readEvents").mockResolvedValue([
      { version: 1, childId: record.id, sequence: 1, timestamp: 1, type: "completed" },
    ])
    let release!: (result: { text: string }) => void
    vi.spyOn(sessions, "extractResult").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const update = vi.fn()
    const watcher = new ChildWatcher(60_000, {
      list: () => [record],
      get: () => record,
      update,
      activity: vi.fn(),
    })
    const checking = watcher.check(record.id)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    watcher.stop()
    watcher.start()
    release({ text: "old result" })
    await checking
    watcher.stop()
    expect(update).not.toHaveBeenCalled()
  })
  it("processes completion events once and extracts the run result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-watcher-"))
    const entries = [
      {
        type: "message",
        id: "reply",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      },
    ]
    await seedSession(join(dir, "session.jsonl"), "/tmp", undefined, entries)
    await writeEvent(dir, {
      version: 1,
      childId: "abc",
      sequence: 1,
      timestamp: 1,
      type: "completed",
    })
    let record = makeRecord(dir)
    const notifications: string[] = []
    const watcher = new ChildWatcher(500, {
      list: () => [record],
      get: () => record,
      update: (next, notification) => {
        record = next
        if (notification) notifications.push(notification.content)
      },
      activity: (next) => (record = next),
    })
    await watcher.check("abc")
    await watcher.check("abc")
    expect(record.state).toBe("completed")
    expect(record.result).toBe("done")
    expect(record.lastEventSequence).toBe(1)
    expect(notifications).toHaveLength(1)
  })
  it("keeps ping events nonterminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-ping-"))
    await seedSession(join(dir, "session.jsonl"), "/tmp")
    await writeEvent(dir, {
      version: 1,
      childId: "abc",
      sequence: 1,
      timestamp: 1,
      type: "ping",
      message: "which API?",
    })
    let record = makeRecord(dir)
    const watcher = new ChildWatcher(500, {
      list: () => [record],
      get: () => record,
      update: (next) => (record = next),
      activity: (next) => (record = next),
    })
    await watcher.check("abc")
    expect(record.state).toBe("awaiting-parent")
  })

  describe("startup watchdog", () => {
    async function watch(patch: Partial<ChildRecord>, writeActivity = false) {
      const dir = await mkdtemp(join(tmpdir(), "suba-startup-"))
      await seedSession(join(dir, "session.jsonl"), "/tmp")
      if (writeActivity)
        await protocol.atomicWriteJson(join(dir, "activity.json"), {
          version: 1,
          childId: "abc",
          sequence: 1,
          updatedAt: Date.now(),
          state: "starting",
        } satisfies ChildActivity)
      let record: ChildRecord = {
        ...makeRecord(dir),
        target: { kind: "tmux", id: "%9" },
        ...patch,
      }
      const notifications: { type: string; content: string }[] = []
      const watcher = new ChildWatcher(500, {
        list: () => [record],
        get: () => record,
        update: (next, notification) => {
          record = next
          if (notification) notifications.push(notification)
        },
        activity: (next) => (record = next),
      })
      return {
        dir,
        notifications,
        record: () => record,
        check: () => watcher.check("abc"),
      }
    }

    it("asks the parent once when a live child reports no activity after the timeout", async () => {
      const child = await watch({ startedAt: Date.now() - STARTUP_TIMEOUT_MS - 1000 })
      try {
        await child.check()
        await child.check()
        expect(child.record().state).toBe("running")
        expect(child.notifications).toHaveLength(1)
        expect(child.notifications[0]?.type).toBe("ask")
        expect(child.notifications[0]?.content).toContain("worker (abc) has not started")
        expect(child.notifications[0]?.content).toContain("tmux target %9")
        expect(child.notifications[0]?.content).toContain(join(child.dir, "launch.sh"))
      } finally {
        await rm(child.dir, { recursive: true, force: true })
      }
    })

    it.each([
      ["before the timeout", { startedAt: Date.now() }, false],
      ["once the child reported activity", { startedAt: 1 }, true],
    ] as const)("stays quiet %s", async (_label, patch, writeActivity) => {
      const child = await watch(patch, writeActivity)
      try {
        await child.check()
        expect(child.notifications).toEqual([])
        expect(child.record().state).toBe("running")
      } finally {
        await rm(child.dir, { recursive: true, force: true })
      }
    })
  })
})
