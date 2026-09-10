import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import childExtension from "../src/child/index.ts"
import { readActivity, readEvents } from "../src/shared/protocol.ts"

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void
type RegisteredTool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    update: () => void,
    ctx: ExtensionContext,
  ) => Promise<{ terminate?: boolean }>
}

const originalChildId = process.env.SUBA_CHILD_ID
const originalArtifactDir = process.env.SUBA_ARTIFACT_DIR
const originalAutoComplete = process.env.SUBA_AUTO_COMPLETE
const temporaryDirectories: string[] = []

afterEach(async () => {
  if (originalChildId === undefined) delete process.env.SUBA_CHILD_ID
  else process.env.SUBA_CHILD_ID = originalChildId
  if (originalArtifactDir === undefined) delete process.env.SUBA_ARTIFACT_DIR
  else process.env.SUBA_ARTIFACT_DIR = originalArtifactDir
  if (originalAutoComplete === undefined) delete process.env.SUBA_AUTO_COMPLETE
  else process.env.SUBA_AUTO_COMPLETE = originalAutoComplete
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("child completion", () => {
  it.each([
    { summary: "  Exact report.\n\nSecond paragraph.  " },
    { summary: "Report", artifacts: ["missing/evidence.md", "/tmp/report file.md"] },
  ])("persists explicit completion without preceding prose: %j", async (report) => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-explicit-"))
    temporaryDirectories.push(artifactDir)
    process.env.SUBA_CHILD_ID = "explicit"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    const tools = new Map<string, RegisteredTool>()
    childExtension({
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool)
      },
      on() {},
    } as unknown as ExtensionAPI)
    let shutdowns = 0
    const ctx = {
      sessionManager: {
        getBranch() {
          throw new Error("must not extract prose")
        },
      },
      shutdown() {
        shutdowns++
      },
    } as unknown as ExtensionContext
    const execute = (params: Record<string, unknown>) =>
      tools.get("suba_done")!.execute("call", params, new AbortController().signal, () => {}, ctx)
    for (const invalid of [
      {},
      { summary: "" },
      { summary: " \n\t" },
      { summary: 42 },
      { summary: "ok", artifacts: [""] },
      { summary: "ok", artifacts: "path" },
    ]) {
      await expect(execute(invalid)).rejects.toThrow(/suba_done/)
      expect(await readEvents(artifactDir, 0)).toEqual([])
      expect(shutdowns).toBe(0)
    }
    expect((await execute(report)).terminate).toBe(true)
    expect(await readEvents(artifactDir, 0)).toMatchObject([
      { type: "completed", sequence: 1, report },
    ])
    expect(shutdowns).toBe(1)
  })

  it("reconstructs context on child resume and retains the latest measurement through completion", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-context-"))
    temporaryDirectories.push(artifactDir)
    process.env.SUBA_AUTO_COMPLETE = "1"
    process.env.SUBA_CHILD_ID = "context"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    const handlers = new Map<string, Handler>()
    childExtension({
      registerTool() {},
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
      },
    } as unknown as ExtensionAPI)
    const message = (input: number) => ({
      role: "assistant",
      usage: { input, cacheRead: 100, cacheWrite: 20 },
    })
    const ctx = {
      sessionManager: { getBranch: () => [{ type: "message", message: message(1000) }] },
      shutdown() {},
    } as unknown as ExtensionContext
    const snapshot = () => readActivity(join(artifactDir, "activity.json"), "context")
    await handlers.get("session_start")!({}, ctx)
    expect((await snapshot()).lastRequestContextTokens).toBe(1120)
    await handlers.get("message_end")!({ message: message(5) }, ctx)
    await handlers.get("message_end")!({ message: { role: "assistant" } }, ctx)
    await handlers.get("agent_settled")!({}, ctx)
    expect((await snapshot()).lastRequestContextTokens).toBe(125)
    expect((await snapshot()).state).toBe("done")
  })

  it("keeps ping waiting and completion done through trailing tool events", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-child-"))
    temporaryDirectories.push(artifactDir)
    process.env.SUBA_CHILD_ID = "ping"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    process.env.SUBA_AUTO_COMPLETE = "0"
    const handlers = new Map<string, Handler>()
    const tools = new Map<string, RegisteredTool>()
    childExtension({
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool)
      },
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
      },
    } as unknown as ExtensionAPI)
    const ctx = {
      sessionManager: { getBranch: () => [] },
      shutdown() {},
    } as unknown as ExtensionContext
    const snapshot = () => readActivity(join(artifactDir, "activity.json"), "ping")
    const trailingEvents = async () => {
      await handlers.get("tool_execution_end")?.({}, ctx)
      await handlers.get("tool_execution_update")?.({ toolName: "bash" }, ctx)
      await handlers.get("message_update")?.({}, ctx)
      await handlers.get("agent_settled")?.({}, ctx)
    }
    const question = await tools
      .get("suba_ask")!
      .execute("call", { message: "help" }, new AbortController().signal, () => undefined, ctx)
    expect(question.terminate).toBe(true)
    await trailingEvents()
    expect((await snapshot()).state).toBe("waiting")
    await handlers.get("input")?.({}, ctx)
    await handlers.get("agent_start")?.({}, ctx)
    expect((await snapshot()).state).toBe("working")
    await tools
      .get("suba_done")!
      .execute("call", { summary: "done" }, new AbortController().signal, () => undefined, ctx)
    await trailingEvents()
    expect((await snapshot()).state).toBe("done")
    expect((await readEvents(artifactDir, 0)).map((event) => event.type)).toEqual([
      "ask",
      "completed",
    ])
  })
  it("notifies and continues to completion without parent input", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-child-"))
    temporaryDirectories.push(artifactDir)
    process.env.SUBA_CHILD_ID = "ping"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    process.env.SUBA_AUTO_COMPLETE = "0"
    const handlers = new Map<string, Handler>()
    const tools = new Map<string, RegisteredTool>()
    childExtension({
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool)
      },
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
      },
    } as unknown as ExtensionAPI)
    const ctx = {
      sessionManager: { getBranch: () => [] },
      shutdown() {},
    } as unknown as ExtensionContext
    const snapshot = () => readActivity(join(artifactDir, "activity.json"), "ping")
    const trailingEvents = async () => {
      await handlers.get("tool_execution_end")?.({}, ctx)
      await handlers.get("tool_execution_update")?.({ toolName: "bash" }, ctx)
      await handlers.get("message_update")?.({}, ctx)
      await handlers.get("agent_settled")?.({}, ctx)
    }
    const notification = await tools
      .get("suba_notify")!
      .execute("call", { message: "help" }, new AbortController().signal, () => undefined, ctx)
    expect(notification.terminate).not.toBe(true)
    expect(tools.has("suba_ping")).toBe(false)
    await handlers.get("tool_execution_start")?.({ toolName: "write" }, ctx)
    expect((await snapshot()).state).toBe("working")
    await tools
      .get("suba_done")!
      .execute("call", { summary: "done" }, new AbortController().signal, () => undefined, ctx)
    await trailingEvents()
    expect((await snapshot()).state).toBe("done")
    expect((await readEvents(artifactDir, 0)).map((event) => event.type)).toEqual([
      "notify",
      "completed",
    ])
  })
  it("marks manual agents waiting after settling and resumes activity on the next run", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-child-"))
    temporaryDirectories.push(artifactDir)
    process.env.SUBA_CHILD_ID = "manual"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    process.env.SUBA_AUTO_COMPLETE = "0"

    const handlers = new Map<string, Handler>()
    const tools = new Map<string, RegisteredTool>()
    childExtension({
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool)
      },
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
      },
    } as unknown as ExtensionAPI)

    let shutdowns = 0
    const ctx = {
      sessionManager: { getBranch: () => [] },
      shutdown: () => {
        shutdowns += 1
      },
    } as unknown as ExtensionContext
    const snapshot = () => readActivity(join(artifactDir, "activity.json"), "manual")

    await handlers.get("message_update")?.({}, ctx)
    expect((await snapshot()).activity).toBe("streaming")
    await handlers.get("agent_settled")?.({}, ctx)
    expect(await snapshot()).toMatchObject({ state: "waiting" })
    expect((await snapshot()).activity).toBeUndefined()
    expect((await snapshot()).toolName).toBeUndefined()
    expect(shutdowns).toBe(0)
    expect(await readEvents(artifactDir, 0)).toEqual([])

    await handlers.get("agent_start")?.({}, ctx)
    expect(await snapshot()).toMatchObject({ state: "working", activity: "model" })
    await tools
      .get("suba_done")
      ?.execute("call", { summary: "done" }, new AbortController().signal, () => undefined, ctx)
    await handlers.get("agent_settled")?.({}, ctx)
    expect((await snapshot()).state).toBe("done")
    expect(shutdowns).toBe(1)
    expect((await readEvents(artifactDir, 0)).map((event) => event.type)).toEqual(["completed"])
  })

  it("allows completion to retry after an artifact write fails", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-child-"))
    temporaryDirectories.push(artifactDir)
    await writeFile(join(artifactDir, "events"), "blocks event directory creation")
    process.env.SUBA_CHILD_ID = "retry"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    process.env.SUBA_AUTO_COMPLETE = "1"

    const handlers = new Map<string, Handler>()
    const tools = new Map<string, RegisteredTool>()
    const pi = {
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool)
      },
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
      },
    } as unknown as ExtensionAPI
    childExtension(pi)

    let shutdowns = 0
    const ctx = {
      sessionManager: { getBranch: () => [] },
      shutdown: () => {
        shutdowns += 1
      },
    } as unknown as ExtensionContext

    await expect(handlers.get("agent_settled")?.({}, ctx)).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect(shutdowns).toBe(0)

    await rm(join(artifactDir, "events"))
    await mkdir(join(artifactDir, "events"))
    const result = await tools
      .get("suba_done")
      ?.execute("call", { summary: "done" }, new AbortController().signal, () => undefined, ctx)

    expect(result?.terminate).toBe(true)
    expect(shutdowns).toBe(1)
    expect((await readEvents(artifactDir, 0)).map((event) => event.type)).toEqual(["completed"])
  })

  it("waits for a continuation after an aborted provider turn", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "pi-suba-child-"))
    temporaryDirectories.push(artifactDir)
    process.env.SUBA_CHILD_ID = "compaction"
    process.env.SUBA_ARTIFACT_DIR = artifactDir
    process.env.SUBA_AUTO_COMPLETE = "1"

    const handlers = new Map<string, Handler>()
    const pi = {
      registerTool() {},
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
      },
    } as unknown as ExtensionAPI
    childExtension(pi)

    let branch: Array<{
      type: string
      message: { role: string; stopReason: string; errorMessage?: string }
    }> = [
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "The operation was aborted.",
        },
      },
    ]
    let shutdowns = 0
    const ctx = {
      sessionManager: { getBranch: () => branch },
      shutdown: () => {
        shutdowns += 1
      },
    } as unknown as ExtensionContext

    await handlers.get("agent_settled")?.({}, ctx)
    expect(shutdowns).toBe(0)
    expect(await readEvents(artifactDir, 0)).toEqual([])
    expect((await readActivity(join(artifactDir, "activity.json"), "compaction")).state).toBe(
      "waiting",
    )
    await handlers.get("agent_start")?.({}, ctx)
    expect((await readActivity(join(artifactDir, "activity.json"), "compaction")).state).toBe(
      "working",
    )

    branch = [
      ...branch,
      {
        type: "message",
        message: { role: "assistant", stopReason: "stop" },
      },
    ]
    await handlers.get("agent_settled")?.({}, ctx)

    expect(shutdowns).toBe(1)
    expect((await readEvents(artifactDir, 0)).map((event) => event.type)).toEqual(["completed"])
  })
})
