import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import parentExtension from "../src/parent/index.ts"
import type { ChildRecord } from "../src/parent/registry.ts"
import { ChildWatcher } from "../src/parent/watcher.ts"
import { atomicWriteJson, type ChildActivity, writeEvent } from "../src/shared/protocol.ts"
import { seedSession } from "../src/shared/sessions.ts"
import { createTarget, paneExists, sendToPane } from "../src/shared/tmux.ts"

vi.mock("../src/shared/tmux.ts", () => ({
  createTarget: vi.fn(async () => ({ paneId: "%child", placement: { type: "split" } })),
  paneExists: vi.fn(async () => true),
  sendToPane: vi.fn(async () => undefined),
  tmuxExec: vi.fn(async () => "tmux 3.5"),
  applySharedWindowGrid: vi.fn(async () => undefined),
}))

type Handler = (event: unknown, ctx: ExtensionContext) => unknown
interface Tool {
  name: string
  execute(
    id: string,
    params: any,
    signal: AbortSignal,
    update: undefined,
    ctx: ExtensionContext,
  ): Promise<any>
}

let root: string
const shutdowns: Array<() => Promise<unknown>> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "suba-parent-activity-"))
  vi.stubEnv("PI_CODING_AGENT_DIR", root)
  vi.stubEnv("TMUX_PANE", "%parent")
  vi.stubEnv("SUBA_PI_EXECUTABLE", "")
})
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function record(id: string, patch: Partial<ChildRecord> = {}): Promise<ChildRecord> {
  const artifactDir = join(root, id)
  const sessionFile = join(artifactDir, "session.jsonl")
  await seedSession(sessionFile, root)
  return {
    id,
    revision: 1,
    state: "running",
    sessionFile,
    artifactDir,
    paneId: `%${id}`,
    placement: { type: "split" },
    name: id,
    cwd: root,
    profile: "default",
    resolvedLaunch: {
      profile: "default",
      tools: "default",
      loadContext: true,
      loadSkills: true,
      systemPrompt: "append",
      autoComplete: false,
    },
    lastEventSequence: 0,
    startedAt: 1,
    resultAfterEntry: 1,
    ...patch,
  }
}
async function activity(
  child: ChildRecord,
  state: ChildActivity["state"],
  sequence = 1,
  updatedAt = sequence,
) {
  await atomicWriteJson(join(child.artifactDir, "activity.json"), {
    version: 1,
    childId: child.id,
    sequence,
    updatedAt,
    state,
  })
}

async function harness(children: ChildRecord[] = [], hasUI = false) {
  const events = createEventBus()
  const snapshots: unknown[] = []
  events.on("suba:activity", (data) => {
    snapshots.push(data)
  })
  const handlers = new Map<string, Handler>()
  const tools = new Map<string, Tool>()
  const appendEntry = vi.fn()
  const sendMessage = vi.fn()
  const setWidget = vi.fn()
  const start = vi.spyOn(ChildWatcher.prototype, "start").mockImplementation(() => undefined)
  await parentExtension({
    events,
    appendEntry,
    sendMessage,
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand() {},
    registerMessageRenderer() {},
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI)
  const ctx = {
    hasUI,
    cwd: root,
    ui: { setWidget },
    sessionManager: {
      getEntries: () =>
        children.map((data) => ({ type: "custom", customType: "suba-child", data })),
      getSessionId: () => "parent",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext
  const emit = async (name: string) => handlers.get(name)!({}, ctx)
  shutdowns.push(() => emit("session_shutdown"))
  const execute = (name: string, params: any = {}) =>
    tools.get(name)!.execute("call", params, new AbortController().signal, undefined, ctx)
  return {
    events,
    snapshots,
    appendEntry,
    sendMessage,
    setWidget,
    emit,
    execute,
    tick: () => (start.mock.contexts.at(-1) as ChildWatcher).tick(),
    list: async (): Promise<ChildRecord[]> => (await execute("suba_list")).details.records,
  }
}

describe("parent activity event bus", () => {
  it("publishes authoritative snapshots after restoration and on requests regardless of listener order", async () => {
    const child = await record("worker")
    await activity(child, "working")
    const parent = await harness([child])
    parent.events.emit("suba:activity:request", undefined)
    expect(parent.snapshots).toEqual([])
    const starting = parent.emit("session_start")
    parent.events.emit("suba:activity:request", undefined)
    expect(parent.snapshots).toEqual([])
    await starting
    expect(parent.snapshots).toEqual([{ activeCount: 1 }])
    const late = vi.fn()
    parent.events.on("suba:activity", late)
    parent.events.emit("suba:activity:request", undefined)
    expect(late).toHaveBeenCalledWith({ activeCount: 1 })
    await parent.tick()
    await activity(child, "working", 2)
    await parent.tick()
    expect(parent.snapshots).toEqual([{ activeCount: 1 }, { activeCount: 1 }])
    expect(parent.setWidget).not.toHaveBeenCalled()
  })

  it("counts concurrent children without counting waiting or terminal widget rows", async () => {
    const children = await Promise.all([
      record("one"),
      record("two"),
      record("waiting"),
      record("done", { state: "completed" }),
    ])
    await activity(children[0]!, "starting")
    await activity(children[1]!, "working")
    await activity(children[2]!, "waiting")
    await activity(children[3]!, "working")
    const parent = await harness(children, true)
    await parent.emit("session_start")
    expect(parent.snapshots).toEqual([{ activeCount: 2 }])
    expect(parent.setWidget).toHaveBeenCalled()
    await activity(children[0]!, "waiting", 2)
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 1 })
    await activity(children[1]!, "done", 2)
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 0 })
    await activity(children[2]!, "working", 2)
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 1 })
  })

  it("reconciles stale restored work, dead panes and terminal events before publishing", async () => {
    const children = await Promise.all([record("waiting"), record("dead"), record("completed")])
    await activity(children[0]!, "waiting")
    await writeEvent(children[2]!.artifactDir, {
      version: 1,
      childId: "completed",
      sequence: 1,
      timestamp: 1,
      type: "completed",
    })
    vi.mocked(paneExists).mockImplementation(async (pane) => pane !== "%dead")
    const parent = await harness(children)
    await parent.emit("session_start")
    expect(parent.snapshots).toEqual([{ activeCount: 0 }])
    expect((await parent.list()).map((child) => child.state)).toEqual([
      "running",
      "interrupted",
      "completed",
    ])
  })

  it("handles ping, guidance and direct child input without stale awaiting-parent state", async () => {
    const child = await record("ping")
    await activity(child, "working")
    const parent = await harness([child])
    await parent.emit("session_start")
    await writeEvent(child.artifactDir, {
      version: 1,
      childId: child.id,
      sequence: 1,
      timestamp: 2,
      type: "ping",
      message: "help",
    })
    await activity(child, "waiting", 2)
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 0 })
    expect((await parent.list())[0]?.state).toBe("awaiting-parent")
    await activity(child, "working", 3)
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 1 })
    expect((await parent.list())[0]?.state).toBe("running")
    await writeEvent(child.artifactDir, {
      version: 1,
      childId: child.id,
      sequence: 2,
      timestamp: 4,
      type: "ping",
      message: "help again",
    })
    await activity(child, "waiting", 4)
    await parent.tick()
    await parent.execute("suba_send", { id: child.id, message: "continue" })
    expect(sendToPane).toHaveBeenCalledWith(child.paneId, "continue")
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 0 })
    await activity(child, "working", 5)
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 1 })
    expect(parent.sendMessage).toHaveBeenCalledTimes(2)
  })

  it.each([2, 3])(
    "recognizes direct input at timestamp %s with a ping in the same poll",
    async (timestamp) => {
      const child = await record("fast")
      await writeEvent(child.artifactDir, {
        version: 1,
        childId: child.id,
        sequence: 1,
        timestamp: 2,
        type: "ping",
        message: "help",
      })
      await activity(child, "working", 3, timestamp)
      const parent = await harness([child])
      await parent.emit("session_start")
      expect(parent.snapshots).toEqual([{ activeCount: 1 }])
      expect((await parent.list())[0]?.state).toBe("running")
    },
  )

  it.each(["completed", "failed", "exit", "interrupted"])(
    "clears active work on %s",
    async (ending) => {
      const child = await record("ending")
      const parent = await harness([child])
      await parent.emit("session_start")
      if (ending === "completed")
        await writeEvent(child.artifactDir, {
          version: 1,
          childId: child.id,
          sequence: 1,
          timestamp: 1,
          type: "completed",
        })
      else if (ending === "failed")
        await writeEvent(child.artifactDir, {
          version: 1,
          childId: child.id,
          sequence: 1,
          timestamp: 1,
          type: "failed",
          error: "failure",
        })
      else if (ending === "exit") await writeFile(join(child.artifactDir, "process-exit"), "23")
      else vi.mocked(paneExists).mockResolvedValueOnce(false)
      await parent.tick()
      expect(parent.snapshots).toEqual([{ activeCount: 1 }, { activeCount: 0 }])
    },
  )

  it("publishes successful launches and resumes without reusing the previous activity sequence", async () => {
    const parent = await harness()
    await parent.emit("session_start")
    const launched = await parent.execute("suba", { name: "launch", task: "work" })
    expect(parent.snapshots).toEqual([{ activeCount: 0 }, { activeCount: 1 }])
    await parent.tick()
    const child = await parent.list().then((children) => children[0]!)
    const artifactDir = join(root, "suba", "artifacts", "parent", child.id)
    await atomicWriteJson(join(artifactDir, "activity.json"), {
      version: 1,
      childId: child.id,
      sequence: 100,
      updatedAt: 100,
      state: "done",
    })
    await writeEvent(artifactDir, {
      version: 1,
      childId: child.id,
      sequence: 1,
      timestamp: 100,
      type: "completed",
    })
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 0 })
    await parent.execute("suba_resume", { id: launched.details.id, task: "more work" })
    await parent.tick()
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 1 })
    await atomicWriteJson(join(artifactDir, "activity.json"), {
      version: 1,
      childId: child.id,
      sequence: 1,
      updatedAt: 101,
      state: "working",
    })
    await parent.tick()
    expect((await parent.list())[0]?.activity?.sequence).toBe(1)
    expect(parent.snapshots.at(-1)).toEqual({ activeCount: 1 })
  })

  it("does not resurrect a child that finishes while guidance is being sent", async () => {
    const child = await record("send", { state: "awaiting-parent" })
    await activity(child, "waiting")
    const parent = await harness([child])
    await parent.emit("session_start")
    let release!: () => void
    vi.mocked(sendToPane).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const sending = parent.execute("suba_send", { id: child.id, message: "continue" })
    await writeEvent(child.artifactDir, {
      version: 1,
      childId: child.id,
      sequence: 1,
      timestamp: 2,
      type: "completed",
    })
    await parent.tick()
    release()
    await sending
    expect((await parent.list())[0]?.state).toBe("completed")
    expect(parent.snapshots).toEqual([{ activeCount: 0 }])
  })

  it("does not publish phantom work after a failed launch", async () => {
    const parent = await harness()
    await parent.emit("session_start")
    vi.mocked(createTarget).mockRejectedValueOnce(new Error("no pane"))
    await expect(parent.execute("suba", { name: "failure", task: "work" })).rejects.toThrow(
      "no pane",
    )
    expect(parent.snapshots).toEqual([{ activeCount: 0 }])
  })

  it("publishes teardown zero, removes requests and discards a pending watcher result", async () => {
    const child = await record("shutdown")
    const parent = await harness([child])
    await parent.emit("session_start")
    let release!: (exists: boolean) => void
    vi.mocked(paneExists).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const ticking = parent.tick()
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    const persisted = parent.appendEntry.mock.calls.length
    await parent.emit("session_shutdown")
    release(false)
    await ticking
    parent.events.emit("suba:activity:request", undefined)
    expect(parent.snapshots).toEqual([{ activeCount: 1 }, { activeCount: 0 }])
    expect(parent.appendEntry).toHaveBeenCalledTimes(persisted)
    expect(parent.sendMessage).not.toHaveBeenCalled()
    expect(parent.setWidget).not.toHaveBeenCalled()
  })

  it("does not let an old restoration overwrite a replacement session", async () => {
    const child = await record("replace")
    const parent = await harness([child])
    let release!: (exists: boolean) => void
    vi.mocked(paneExists).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const starting = parent.emit("session_start")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    await parent.emit("session_shutdown")
    await activity(child, "waiting")
    await parent.emit("session_start")
    release(false)
    await starting
    parent.events.emit("suba:activity:request", undefined)
    expect(parent.snapshots).toEqual([{ activeCount: 0 }, { activeCount: 0 }, { activeCount: 0 }])
    expect((await parent.list())[0]?.state).toBe("running")
    expect(parent.sendMessage).not.toHaveBeenCalled()
  })
})
