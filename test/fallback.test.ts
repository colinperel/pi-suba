import { mkdtemp, readFile, rm } from "node:fs/promises"
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
import { DEFAULT_CONFIG } from "../src/shared/config.ts"
import { BUILTIN_DEFAULT_PROFILE } from "../src/shared/profiles.ts"

let root: string

afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

it("launches and completes a child without tmux, Rex, or a TTY", async () => {
  root = await mkdtemp(join(tmpdir(), "suba-background-"))
  vi.stubEnv("TMUX_PANE", "")
  vi.stubEnv("REX_BLOCK", "")
  vi.stubEnv("WEZTERM_PANE", "42")
  vi.stubEnv("PI_CODING_AGENT_DIR", root)
  vi.stubEnv("SUBA_PI_EXECUTABLE", resolve("test/fixtures/rpc-pi"))
  const tools = new Map<string, ToolDefinition>()
  const host: ManagerHost = {
    config: DEFAULT_CONFIG,
    profiles: new Map([["default", BUILTIN_DEFAULT_PROFILE]]),
    records: new Map(),
    persist() {},
    refreshWidget() {},
    watch: (id) => watcher.check(id),
  }
  const watcher = new ChildWatcher(100, {
    list: () => [...host.records.values()],
    get: (id) => host.records.get(id),
    update: (record) => host.records.set(record.id, record),
    activity: (record) => host.records.set(record.id, record),
  })
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
  await tools
    .get("suba")!
    .execute(
      "launch",
      { name: "background", task: "A task with\nUnicode \u2028 and 'quotes'" },
      new AbortController().signal,
      undefined,
      ctx,
    )
  const child = [...host.records.values()][0]!
  await vi.waitFor(async () => {
    await watcher.check(child.id)
    expect(host.records.get(child.id)?.state).toBe("completed")
  })
  expect(host.records.get(child.id)?.result).toBe("A task with\nUnicode \u2028 and 'quotes'")
  const receipt = JSON.parse(await readFile(join(child.artifactDir, "rpc-input.json"), "utf8"))
  expect(receipt).toMatchObject({
    type: "prompt",
    message: "A task with\nUnicode \u2028 and 'quotes'",
  })
})
