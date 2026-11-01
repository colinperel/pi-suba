import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readActivity, readEvents } from "../src/shared/protocol.ts"
import {
  CommandInbox,
  launchScriptPath,
  processExists,
  waitForReceipt,
  writeCommand,
  type ChildCommand,
} from "../src/shared/control.ts"
import childExtension from "../src/child/index.ts"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

const directories: string[] = []
const runId = "0123456789abcdef"
const stops: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "suba-control-"))
  directories.push(root)
  return root
}

describe("child control channel", () => {
  it("delivers concurrent multiline guidance in order without typing into a terminal", async () => {
    const root = await fixture()
    const messages: ChildCommand[] = []
    const inbox = new CommandInbox(root, runId, "child", async (message) => {
      messages.push(message)
    })
    const inputs = [
      "quotes: '\" and newline\nsecond line",
      "Unicode \u2028 stays in the message",
      "/skill:merge After merging, report success.",
    ]
    const sequence = await Promise.all(
      inputs.map((message) => writeCommand(root, runId, "child", { type: "guidance", message })),
    )
    expect(sequence).toEqual([1, 2, 3])
    await Promise.all([inbox.poll(), inbox.poll()])
    expect(
      messages.map((message) => (message.type === "guidance" ? message.message : "shutdown")),
    ).toEqual(inputs)
    await Promise.all(sequence.map((number) => waitForReceipt(root, runId, number)))
    const reloaded = new CommandInbox(root, runId, "child", async (message) => {
      messages.push(message)
    })
    expect(await reloaded.poll()).toBe(0)
    expect(messages).toHaveLength(3)
  })

  it("does not deliver commands from an earlier launch after resume", async () => {
    const root = await fixture()
    await writeCommand(root, runId, "child", { type: "shutdown" })
    const receive = vi.fn(async () => undefined)
    expect(await new CommandInbox(root, "fedcba9876543210", "child", receive).poll()).toBe(0)
    expect(receive).not.toHaveBeenCalled()
  })

  it("reports rejection without blocking subsequent guidance", async () => {
    const root = await fixture()
    const receive = vi.fn(async (command: ChildCommand) => {
      if (command.type === "shutdown") throw new Error("Child is still working")
    })
    const inbox = new CommandInbox(root, runId, "child", receive)
    await writeCommand(root, runId, "child", { type: "shutdown" })
    await writeCommand(root, runId, "child", { type: "guidance", message: "continue" })
    await inbox.poll()
    await expect(waitForReceipt(root, runId, 1)).rejects.toThrow("still working")
    await expect(waitForReceipt(root, runId, 2)).resolves.toBeUndefined()
  })

  it("rejects the wrong child identity and gives unconfirmed delivery a bounded error", async () => {
    const root = await fixture()
    const receive = vi.fn(async () => undefined)
    await writeCommand(root, runId, "wrong", { type: "guidance", message: "no" })
    await new CommandInbox(root, runId, "child", receive).poll()
    await expect(waitForReceipt(root, runId, 1)).rejects.toThrow("Invalid subagent command")
    expect(receive).not.toHaveBeenCalled()
    await expect(waitForReceipt(root, runId, 2, 1)).rejects.toThrow("processing is not confirmed")
    await expect(writeCommand(root, "../escape", "child", { type: "shutdown" })).rejects.toThrow(
      "run identity",
    )
  })

  it("acknowledges shutdown before requesting process exit", async () => {
    const root = await fixture()
    const sequence = await writeCommand(root, runId, "child", { type: "shutdown" })
    let receiptAtExit: string | undefined
    await new CommandInbox(root, runId, "child", async () => () => {
      receiptAtExit = "requested"
    }).poll()
    expect(receiptAtExit).toBe("requested")
    await expect(waitForReceipt(root, runId, sequence)).resolves.toBeUndefined()
  })

  it("recognizes a live child in a non-ASCII path under the C locale", async () => {
    const root = await fixture()
    const artifactDir = join(root, "josé workspace")
    await mkdir(artifactDir)
    const script = launchScriptPath(artifactDir, runId)
    await writeFile(
      script,
      '#!/bin/sh\nprintf "%s\\n" "$$" > "$SUBA_TEST_PID_FILE"\nread -r reply\n',
      { mode: 0o700 },
    )
    const child = spawn(script, [], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { SUBA_TEST_PID_FILE: join(artifactDir, "process-pid") },
    })
    const exited = once(child, "close")
    stops.push(async () => {
      child.stdin?.end()
      await exited
    })
    await once(child, "spawn")
    await vi.waitFor(async () => {
      await readFile(join(artifactDir, "process-pid"), "utf8")
    })
    vi.stubEnv("LC_ALL", "C")
    expect(await processExists(artifactDir, runId)).toBe(true)
  })

  it("does not mistake a reused PID for this child's process", async () => {
    const root = await fixture()
    expect(await processExists(root, runId)).toBeUndefined()
    await writeFile(join(root, "process-pid"), String(process.pid))
    expect(await processExists(root, runId)).toBe(false)
  })
})

it.each(["0", "1"])(
  "settles after command-only guidance queued at completion (automatic=%s)",
  async (automatic) => {
    const root = await fixture()
    vi.stubEnv("SUBA_CHILD_ID", "child")
    vi.stubEnv("SUBA_ARTIFACT_DIR", root)
    vi.stubEnv("SUBA_RUN_ID", runId)
    vi.stubEnv("SUBA_AUTO_COMPLETE", automatic)
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>()
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
    const sendUserMessage = vi.fn()
    childExtension({
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
        handlers.set(name, handler),
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
      sendUserMessage,
      getCommands: () => [{ name: "noop", source: "extension" }],
    } as unknown as ExtensionAPI)
    const shutdown = vi.fn()
    const ctx = {
      sessionManager: { getBranch: () => [] },
      thinkingLevel: "minimal",
      hasPendingMessages: () => false,
      isIdle: () => true,
      shutdown,
    } as unknown as ExtensionContext
    stops.push(() => handlers.get("session_shutdown")?.({}, ctx))
    await handlers.get("session_start")!({}, ctx)
    await handlers.get("agent_start")!({}, ctx)
    if (automatic === "0")
      await tools.get("suba_done")!.execute("call", { summary: "Verified completion" })
    await writeCommand(root, runId, "child", { type: "guidance", message: "/noop" })
    await handlers.get("agent_settled")!({}, ctx)
    expect(sendUserMessage).toHaveBeenCalledWith("/noop", {
      deliverAs: "steer",
      expandPromptTemplates: true,
    })
    expect(shutdown).toHaveBeenCalledOnce()
    const events = await readEvents(root, 0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "completed",
      ...(automatic === "0" ? { report: { summary: "Verified completion" } } : {}),
    })
    expect((await readActivity(join(root, "activity.json"), "child")).state).toBe("done")
  },
)

it("does not finish acknowledged guidance before model-visible delivery", async () => {
  const root = await fixture()
  vi.stubEnv("SUBA_CHILD_ID", "child")
  vi.stubEnv("SUBA_ARTIFACT_DIR", root)
  vi.stubEnv("SUBA_RUN_ID", runId)
  vi.stubEnv("SUBA_AUTO_COMPLETE", "1")
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>()
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
  const sendUserMessage = vi.fn()
  childExtension({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
      tools.set(tool.name, tool),
    sendUserMessage,
    getCommands: () => [],
  } as unknown as ExtensionAPI)
  const shutdown = vi.fn()
  const ctx = {
    sessionManager: { getBranch: () => [] },
    thinkingLevel: "minimal",
    hasPendingMessages: () => false,
    isIdle: () => true,
    shutdown,
  } as unknown as ExtensionContext
  stops.push(() => handlers.get("session_shutdown")?.({}, ctx))
  await handlers.get("session_start")!({}, ctx)
  const guidance = await writeCommand(root, runId, "child", {
    type: "guidance",
    message: "Continue with the correction",
  })
  // Let the normal inbox timer acknowledge dispatch while Pi's asynchronous
  // prompt path has not emitted message_start yet.
  await waitForReceipt(root, runId, guidance)
  await handlers.get("agent_settled")!({}, ctx)
  expect(shutdown).not.toHaveBeenCalled()
  expect(await readEvents(root, 0)).toEqual([])
  await tools
    .get("suba_ask")!
    .execute("call", { message: "A concurrent ask before the queued steer is delivered" })
  const finish = await writeCommand(root, runId, "child", { type: "shutdown" })
  await expect(waitForReceipt(root, runId, finish)).rejects.toThrow("must be idle")
  await handlers.get("message_start")!({ message: { role: "user" } }, ctx)
  await tools
    .get("suba_done")!
    .execute("call", { summary: "Corrected after actual guidance delivery" })
  await handlers.get("agent_settled")!({}, ctx)
  expect(shutdown).toHaveBeenCalledOnce()
  expect((await readEvents(root, 0)).at(-1)).toMatchObject({
    type: "completed",
    report: { summary: "Corrected after actual guidance delivery" },
  })
})

it("dispatches idle guidance one at a time and recovers from a lost dispatch", async () => {
  const root = await fixture()
  vi.stubEnv("SUBA_CHILD_ID", "child")
  vi.stubEnv("SUBA_ARTIFACT_DIR", root)
  vi.stubEnv("SUBA_RUN_ID", runId)
  vi.stubEnv("SUBA_AUTO_COMPLETE", "0")
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>()
  const sendUserMessage = vi.fn()
  childExtension({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    registerTool() {},
    sendUserMessage,
    getCommands: () => [],
  } as unknown as ExtensionAPI)
  const shutdown = vi.fn()
  const ctx = {
    sessionManager: { getBranch: () => [] },
    thinkingLevel: "minimal",
    hasPendingMessages: () => false,
    isIdle: () => true,
    shutdown,
  } as unknown as ExtensionContext
  stops.push(() => handlers.get("session_shutdown")?.({}, ctx))
  await handlers.get("session_start")!({}, ctx)
  const first = await writeCommand(root, runId, "child", { type: "guidance", message: "first" })
  const second = await writeCommand(root, runId, "child", { type: "guidance", message: "second" })
  await waitForReceipt(root, runId, first)
  // A second idle prompt would race the first prompt's preflight in Pi.
  await expect(waitForReceipt(root, runId, second, 300)).rejects.toThrow("not acknowledged")
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith("first", {
    deliverAs: "steer",
    expandPromptTemplates: true,
  })
  await handlers.get("message_start")!({ message: { role: "user" } }, ctx)
  await waitForReceipt(root, runId, second)
  expect(sendUserMessage).toHaveBeenLastCalledWith("second", {
    deliverAs: "steer",
    expandPromptTemplates: true,
  })
  // The second prompt fails before message_start, which Pi does not report.
  const early = await writeCommand(root, runId, "child", { type: "shutdown" })
  await expect(waitForReceipt(root, runId, early)).rejects.toThrow("must be idle")
  vi.useFakeTimers({ toFake: ["Date"] })
  try {
    vi.setSystemTime(Date.now() + 31000)
    await vi.waitFor(
      async () =>
        expect((await readActivity(join(root, "activity.json"), "child")).state).toBe("waiting"),
      { timeout: 3000 },
    )
    const finish = await writeCommand(root, runId, "child", { type: "shutdown" })
    await waitForReceipt(root, runId, finish)
    expect(shutdown).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it("defers idle guidance behind task or pane prompts and compaction", async () => {
  const root = await fixture()
  vi.stubEnv("SUBA_CHILD_ID", "child")
  vi.stubEnv("SUBA_ARTIFACT_DIR", root)
  vi.stubEnv("SUBA_RUN_ID", runId)
  vi.stubEnv("SUBA_AUTO_COMPLETE", "0")
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>()
  const sendUserMessage = vi.fn()
  childExtension({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    registerTool() {},
    sendUserMessage,
    getCommands: () => [],
  } as unknown as ExtensionAPI)
  const ctx = {
    sessionManager: { getBranch: () => [] },
    thinkingLevel: "minimal",
    hasPendingMessages: () => false,
    isIdle: () => true,
    shutdown() {},
  } as unknown as ExtensionContext
  stops.push(() => handlers.get("session_shutdown")?.({}, ctx))
  await handlers.get("session_start")!({}, ctx)
  // The launch task (or pane input) is in Pi's prompt preflight.
  await handlers.get("input")!({ source: "rpc", text: "Launch task" }, ctx)
  const guidance = await writeCommand(root, runId, "child", {
    type: "guidance",
    message: "guidance",
  })
  await expect(waitForReceipt(root, runId, guidance, 300)).rejects.toThrow("not acknowledged")
  await handlers.get("session_before_compact")!({}, ctx)
  await handlers.get("message_start")!({ message: { role: "user" } }, ctx)
  await expect(waitForReceipt(root, runId, guidance, 300)).rejects.toThrow("not acknowledged")
  expect(sendUserMessage).not.toHaveBeenCalled()
  await handlers.get("session_compact")!({}, ctx)
  await waitForReceipt(root, runId, guidance)
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith("guidance", {
    deliverAs: "steer",
    expandPromptTemplates: true,
  })
})

it.each(["typed", "guidance"])(
  "completes after a withdrawn %s steer is resubmitted",
  async (source) => {
    const root = await fixture()
    vi.stubEnv("SUBA_CHILD_ID", "child")
    vi.stubEnv("SUBA_ARTIFACT_DIR", root)
    vi.stubEnv("SUBA_RUN_ID", runId)
    vi.stubEnv("SUBA_AUTO_COMPLETE", "1")
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>()
    childExtension({
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
        handlers.set(name, handler),
      registerTool() {},
      sendUserMessage() {},
      getCommands: () => [],
    } as unknown as ExtensionAPI)
    const shutdown = vi.fn()
    let idle = false
    const ctx = {
      sessionManager: { getBranch: () => [] },
      thinkingLevel: "minimal",
      hasPendingMessages: () => false,
      isIdle: () => idle,
      shutdown,
    } as unknown as ExtensionContext
    const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx)
    stops.push(() => emit("session_shutdown"))
    await emit("session_start")
    await emit("agent_start")
    // A steer queued while streaming; Pi's Escape/dequeue withdraws it with no event.
    if (source === "typed")
      await emit("input", { source: "interactive", streamingBehavior: "steer" })
    else {
      const guidance = await writeCommand(root, runId, "child", {
        type: "guidance",
        message: "queued guidance",
      })
      await waitForReceipt(root, runId, guidance)
      await emit("input", { source: "extension", streamingBehavior: "steer" })
    }
    idle = true
    // The user resubmits the restored text as a new run.
    await emit("input", { source: "interactive" })
    idle = false
    await emit("agent_start")
    await emit("message_start", { message: { role: "user" } })
    idle = true
    await emit("agent_settled")
    expect(shutdown).toHaveBeenCalledOnce()
    expect((await readEvents(root, 0)).at(-1)).toMatchObject({ type: "completed" })
  },
)

it("resumes a waiting child through Pi's message API and expands skill commands", async () => {
  const root = await fixture()
  vi.stubEnv("SUBA_CHILD_ID", "child")
  vi.stubEnv("SUBA_ARTIFACT_DIR", root)
  vi.stubEnv("SUBA_RUN_ID", runId)
  vi.stubEnv("SUBA_AUTO_COMPLETE", "0")
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>()
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
  const sendUserMessage = vi.fn()
  childExtension({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
      tools.set(tool.name, tool),
    sendUserMessage,
    getCommands: () => [],
  } as unknown as ExtensionAPI)
  const shutdown = vi.fn()
  let pending = false
  const ctx = {
    sessionManager: { getBranch: () => [] },
    thinkingLevel: "minimal",
    hasPendingMessages: () => pending,
    isIdle: () => true,
    shutdown,
  } as unknown as ExtensionContext
  stops.push(() => handlers.get("session_shutdown")?.({}, ctx))
  await handlers.get("session_start")!({}, ctx)
  await tools.get("suba_ask")!.execute("call", { message: "help" })
  const sequence = await writeCommand(root, runId, "child", {
    type: "guidance",
    message: "/skill:merge Keep this argument.",
  })
  await handlers.get("agent_settled")!({}, ctx)
  await waitForReceipt(root, runId, sequence)
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith("/skill:merge Keep this argument.", {
    deliverAs: "steer",
    expandPromptTemplates: true,
  })
  expect(shutdown).not.toHaveBeenCalled()
  await handlers.get("message_start")!({ message: { role: "user" } }, ctx)
  pending = true
  const busyFinish = await writeCommand(root, runId, "child", { type: "shutdown" })
  await handlers.get("agent_settled")!({}, ctx)
  await expect(waitForReceipt(root, runId, busyFinish)).rejects.toThrow("must be idle")
  expect(shutdown).not.toHaveBeenCalled()
  pending = false
  const finish = await writeCommand(root, runId, "child", { type: "shutdown" })
  await handlers.get("agent_settled")!({}, ctx)
  await waitForReceipt(root, runId, finish)
  expect(shutdown).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(root, "activity.json"), "utf8"))).toMatchObject({
    state: "done",
  })
})
