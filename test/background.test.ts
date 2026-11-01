import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { afterEach, expect, it, vi } from "vitest"
import { registerTools, type ManagerHost } from "../src/parent/tools.ts"
import { ChildWatcher } from "../src/parent/watcher.ts"
import { restoreRegistry, type ChildRecord } from "../src/parent/registry.ts"
import { DEFAULT_CONFIG } from "../src/shared/config.ts"
import { BUILTIN_DEFAULT_PROFILE } from "../src/shared/profiles.ts"
import { closeTerminal } from "../src/shared/terminal.ts"
import { shellQuote } from "../src/shared/control.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "suba-background-runtime-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv("TMUX_PANE", "")
  vi.stubEnv("REX_BLOCK", "")
  vi.stubEnv("PI_CODING_AGENT_DIR", root)
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
  vi.stubEnv("SUBA_PI_EXECUTABLE", cli)
  const tools = new Map<string, ToolDefinition>()
  const host: ManagerHost = {
    config: { ...DEFAULT_CONFIG, childExtensions: [resolve("test/fixtures/control-commands.ts")] },
    profiles: new Map([
      [
        "default",
        { ...BUILTIN_DEFAULT_PROFILE, loadContext: false, loadSkills: false, autoComplete: false },
      ],
    ]),
    records: new Map(),
    persist() {},
    refreshWidget() {},
    watch: (id) => watcher.check(id),
  }
  const notifications: string[] = []
  const watcherFor = (records: Map<string, ChildRecord>) =>
    new ChildWatcher(100, {
      list: () => [...records.values()],
      get: (id) => records.get(id),
      update: (record, notification) => {
        records.set(record.id, record)
        if (notification) notifications.push(notification.content)
      },
      activity: (record) => {
        records.set(record.id, record)
      },
    })
  const watcher = watcherFor(host.records)
  registerTools(
    {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI,
    host,
  )
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined },
  } as unknown as ExtensionContext
  const execute = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute("call", params, new AbortController().signal, undefined, ctx)
  const cleanupChild = (child: ChildRecord) => {
    const target = child.target
    if (target?.kind !== "background") throw new Error("Expected a background target")
    cleanups.push(async () => {
      await closeTerminal(target)
      // EOF is asynchronous: let the wrapper and its last writes finish before
      // removing the temporary directory, including on a regression failure.
      await vi.waitFor(
        async () => {
          await readFile(join(child.artifactDir, "process-exit"), "utf8")
        },
        { timeout: 10000 },
      )
    })
    return target
  }
  const launch = async (task: string) => {
    await execute("suba", { name: "background", task })
    const child = [...host.records.values()].at(-1)!
    return { ...child, target: cleanupChild(child) }
  }
  const waitForState = async (child: ChildRecord, state: ChildRecord["state"]) =>
    vi.waitFor(
      async () => {
        await watcher.check(child.id)
        expect(host.records.get(child.id)?.state).toBe(state)
      },
      { timeout: 10000 },
    )
  return { root, cli, host, watcherFor, execute, launch, waitForState, notifications, cleanupChild }
}

it("restores a background child stopped by parent teardown as interrupted, never completed", async () => {
  const app = await runtime()
  const child = await app.launch("/suba-test-wait")
  await app.waitForState(child, "awaiting-parent")
  const saved = JSON.parse(
    JSON.stringify({
      type: "custom",
      customType: "suba-child",
      data: app.host.records.get(child.id),
    }),
  )
  await closeTerminal(child.target!)
  await vi.waitFor(async () =>
    expect((await readFile(join(child.artifactDir, "process-exit"), "utf8")).trim()).toBe("0"),
  )
  const restored = restoreRegistry([saved])
  app.notifications.length = 0
  await app.watcherFor(restored).check(child.id)
  expect(restored.get(child.id)?.state).toBe("interrupted")
  expect(app.notifications).toHaveLength(1)
  expect(app.notifications[0]).toContain("interrupted")
  expect(app.notifications[0]).not.toContain("completed")
}, 20000)

it("restores an interrupted child after the parent process actually exits", async () => {
  const app = await runtime()
  const suba = join(app.root, "suba")
  await mkdir(join(suba, "profiles"), { recursive: true })
  await writeFile(
    join(suba, "config.json"),
    JSON.stringify({ childExtensions: [resolve("test/fixtures/control-commands.ts")] }),
  )
  await writeFile(
    join(suba, "profiles/runtime.md"),
    "---\nname: runtime\nload-context: false\nload-skills: false\nauto-complete: false\n---\n",
  )
  let child!: ChildRecord
  try {
    await promisify(execFile)(
      process.execPath,
      ["--experimental-transform-types", resolve("test/fixtures/exiting-parent.ts"), app.root],
      { timeout: 15000 },
    )
  } finally {
    child = JSON.parse(
      await readFile(join(app.root, "exiting-parent-record.json"), "utf8"),
    ) as ChildRecord
    app.cleanupChild(child)
  }
  let exitCode!: number
  await vi.waitFor(async () => {
    exitCode = Number((await readFile(join(child.artifactDir, "process-exit"), "utf8")).trim())
    expect(Number.isInteger(exitCode)).toBe(true)
  })
  const restored = restoreRegistry([{ type: "custom", customType: "suba-child", data: child }])
  await app.watcherFor(restored).check(child.id)
  expect(restored.get(child.id)?.state).toBe("interrupted")
  expect(app.notifications).toHaveLength(1)
  expect(app.notifications[0]).toContain("interrupted")
}, 25000)

it("reports a rejected unauthenticated RPC prompt and lets the parent resume the child", async () => {
  const app = await runtime()
  const executable = join(app.root, "isolated-pi")
  // A fresh HOME/agent directory and env -i guarantee there are no credentials
  // or model requests. Keep only the runtime identity and executable search path.
  await writeFile(
    executable,
    `#!/bin/sh\nexec /usr/bin/env -i PATH=${shellQuote(process.env.PATH!)} HOME=${shellQuote(app.root)} PI_CODING_AGENT_DIR=${shellQuote(app.root)} SUBA_CHILD_ID="$SUBA_CHILD_ID" SUBA_RUN_ID="$SUBA_RUN_ID" SUBA_ARTIFACT_DIR="$SUBA_ARTIFACT_DIR" SUBA_AUTO_COMPLETE="$SUBA_AUTO_COMPLETE" SUBA_SESSION_FILE="$SUBA_SESSION_FILE" ${shellQuote(process.execPath)} ${shellQuote(app.cli)} --model anthropic/claude-opus-5-5 "$@"\n`,
    { mode: 0o700 },
  )
  vi.stubEnv("SUBA_PI_EXECUTABLE", executable)
  const child = await app.launch("This must fail before any model request")
  await app.waitForState(child, "failed")
  expect(app.host.records.get(child.id)?.error).toContain("prompt")
  expect(app.notifications.at(-1)).toContain("failed")
  expect(await readFile(join(child.artifactDir, "process.log"), "utf8")).toContain("No API key")
  await vi.waitFor(async () =>
    expect((await readFile(join(child.artifactDir, "process-exit"), "utf8")).trim()).toBe("0"),
  )
  vi.stubEnv("SUBA_PI_EXECUTABLE", app.cli)
  const resumed = await app.execute("suba_resume", { id: child.id, task: "/suba-test-wait" })
  const next = app.host.records.get(child.id)!
  app.cleanupChild(next)
  expect(resumed.content).toEqual([
    { type: "text", text: expect.stringContaining("in background") },
  ])
  expect(resumed.content).not.toEqual([
    { type: "text", text: expect.stringContaining("undefined") },
  ])
  await app.waitForState(next, "awaiting-parent")
  await app.execute("suba_finish", {
    id: child.id,
    result: "Verified recovery after rejected prompt",
  })
}, 30000)

it("cancels unsupported background dialogs instead of leaving a command stuck", async () => {
  const app = await runtime()
  const child = await app.launch("/suba-test-dialog")
  await app.waitForState(child, "awaiting-parent")
  expect(JSON.parse(await readFile(join(child.artifactDir, "dialog.json"), "utf8"))).toBe(false)
  await app.execute("suba_finish", {
    id: child.id,
    result: "Verified headless dialog cancellation",
  })
}, 20000)

it("reports a failed guidance command instead of leaving a live unfinishable child", async () => {
  const app = await runtime()
  const child = await app.launch("/suba-test-wait")
  await app.waitForState(child, "awaiting-parent")
  await app
    .execute("suba_send", { id: child.id, message: "/suba-test-error" })
    .catch(() => undefined)
  await app.waitForState(child, "failed")
  expect(app.notifications.at(-1)).toContain("failed")
}, 20000)

it("continues after a recoverable extension hook error", async () => {
  const app = await runtime()
  vi.stubEnv("SUBA_TEST_HOOK_ERROR", "1")
  const child = await app.launch("/suba-test-wait")
  await app.waitForState(child, "awaiting-parent")
  await app.execute("suba_finish", {
    id: child.id,
    result: "Verified recoverable hook does not abort the child",
  })
  expect(app.host.records.get(child.id)?.state).toBe("completed")
  expect(await readFile(join(child.artifactDir, "process.log"), "utf8")).toContain(
    "Synthetic recoverable hook failure",
  )
}, 20000)

it("delivers parallel guidance during slow prompt preflight and remains finishable", async () => {
  const app = await runtime()
  vi.stubEnv("SUBA_TEST_FAKE_MODEL", "1")
  const child = await app.launch("/suba-test-wait")
  await app.waitForState(child, "awaiting-parent")
  await Promise.all([
    app.execute("suba_send", { id: child.id, message: "first parallel guidance" }),
    app.execute("suba_send", { id: child.id, message: "second parallel guidance" }),
  ])
  await vi.waitFor(
    async () => {
      const inputs = await readFile(join(child.artifactDir, "model-inputs.jsonl"), "utf8")
      expect(inputs).toContain("first parallel guidance")
      expect(inputs).toContain("second parallel guidance")
    },
    { timeout: 10000 },
  )
  await vi.waitFor(
    async () =>
      app.execute("suba_finish", {
        id: child.id,
        result: "Verified both parallel guidance messages reached the model",
      }),
    { timeout: 10000 },
  )
  expect(app.host.records.get(child.id)?.state).toBe("completed")
  expect(await readFile(join(child.artifactDir, "process.log"), "utf8")).not.toContain(
    "already processing",
  )
}, 30000)

it("can finish after command-only guidance without another model turn", async () => {
  const app = await runtime()
  const child = await app.launch("/suba-test-wait")
  await app.waitForState(child, "awaiting-parent")
  await app.execute("suba_send", { id: child.id, message: "/suba-test-noop" })
  await vi.waitFor(async () =>
    expect(await readFile(join(child.artifactDir, "noop.txt"), "utf8")).toBe("handled"),
  )
  await app.execute("suba_finish", {
    id: child.id,
    result: "Verified command-only guidance remains finishable",
  })
  expect(app.host.records.get(child.id)?.state).toBe("completed")
}, 20000)
