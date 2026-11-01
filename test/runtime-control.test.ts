import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { execFile, spawnSync } from "node:child_process"
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
import { DEFAULT_CONFIG } from "../src/shared/config.ts"
import { BUILTIN_DEFAULT_PROFILE } from "../src/shared/profiles.ts"
import { waitForReceipt, writeCommand } from "../src/shared/control.ts"
import { closeTerminal } from "../src/shared/terminal.ts"

let root: string
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

const exec = promisify(execFile)
const hasRex = spawnSync("rex", ["version"]).status === 0
const hasTmux = spawnSync("tmux", ["-V"]).status === 0

for (const terminal of ["background", "tmux", "rex"] as const) {
  it.skipIf((terminal === "rex" && !hasRex) || (terminal === "tmux" && !hasTmux))(
    `guides, finishes, and observes real Pi exits in ${terminal} without model calls`,
    async () => {
      root = await mkdtemp(join(tmpdir(), "suba-runtime-"))
      vi.stubEnv("TMUX_PANE", "")
      vi.stubEnv("REX_BLOCK", "")
      vi.stubEnv("PI_CODING_AGENT_DIR", root)
      vi.stubEnv(
        "SUBA_PI_EXECUTABLE",
        resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      )
      if (terminal === "tmux") {
        const socket = `suba-runtime-${process.pid}`
        const run = async (args: string[]) =>
          (await exec("tmux", ["-L", socket, ...args])).stdout.trim()
        const parent = await run([
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-s",
          "runtime",
          "sleep 120",
        ])
        cleanups.push(async () => {
          await run(["kill-server"]).catch(() => undefined)
        })
        const context = await run([
          "display-message",
          "-p",
          "-t",
          parent,
          "#{socket_path},#{pid},0",
        ])
        vi.stubEnv("TMUX", context)
        vi.stubEnv("TMUX_PANE", parent)
      } else if (terminal === "rex") {
        const rexDir = await mkdtemp("/tmp/suba-rex-")
        cleanups.push(() => rm(rexDir, { recursive: true, force: true }))
        vi.stubEnv("REX_RUNTIME_DIR", rexDir)
        vi.stubEnv("REX_SERVER", "")
        const config = join(root, "empty.lua")
        await writeFile(config, "")
        await exec("rex", [
          "server",
          "start",
          "--restore=false",
          "--env",
          "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
          "--state-dir",
          join(root, "rex-state"),
          "--config",
          config,
        ])
        cleanups.push(async () => {
          await exec("rex", ["server", "stop"])
        })
        const { stdout } = await exec("rex", ["new", "runtime", "--json", "--", "sleep", "120"])
        const session = JSON.parse(stdout) as {
          session_id: string
          initial_windows: Array<{ block_ids: string[] }>
        }
        vi.stubEnv("REX_SESSION", session.session_id)
        vi.stubEnv("REX_BLOCK", session.initial_windows[0]!.block_ids[0]!)
      }
      const tools = new Map<string, ToolDefinition>()
      const host: ManagerHost = {
        config: {
          ...DEFAULT_CONFIG,
          childExtensions: [resolve("test/fixtures/control-commands.ts")],
        },
        profiles: new Map([
          [
            "default",
            {
              ...BUILTIN_DEFAULT_PROFILE,
              loadContext: false,
              loadSkills: false,
              autoComplete: false,
            },
          ],
        ]),
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
      const execute = (name: string, params: Record<string, unknown>) =>
        tools.get(name)!.execute("call", params, new AbortController().signal, undefined, ctx)
      await execute("suba", { name: "runtime", task: "/suba-test-wait" })
      const child = [...host.records.values()][0]!
      cleanups.push(async () => {
        const state = host.records.get(child.id)?.state
        if (state !== "running" && state !== "awaiting-parent") return
        const sequence = await writeCommand(child.artifactDir, child.runId!, child.id, {
          type: "shutdown",
        })
        await waitForReceipt(child.artifactDir, child.runId!, sequence).catch(() => undefined)
      })
      await vi.waitFor(
        async () => {
          await watcher.check(child.id)
          expect(host.records.get(child.id)?.state).toBe("awaiting-parent")
        },
        { timeout: 20000 },
      )
      await execute("suba_send", {
        id: child.id,
        message: "/suba-test-guidance preserve these 'quotes'",
      })
      await vi.waitFor(async () => {
        expect(await readFile(join(child.artifactDir, "guidance.txt"), "utf8")).toBe(
          "preserve these 'quotes'",
        )
        await watcher.check(child.id)
        expect(host.records.get(child.id)?.activity?.state).toBe("waiting")
      })
      await execute("suba_finish", {
        id: child.id,
        result: "Verified real Pi guidance and graceful shutdown",
      })
      expect(host.records.get(child.id)?.state).toBe("completed")
      await vi.waitFor(
        async () => {
          expect((await readFile(join(child.artifactDir, "process-exit"), "utf8")).trim()).toBe("0")
        },
        { timeout: 10000 },
      )
      await execute("suba", { name: "completed", task: "/suba-test-complete", autoComplete: true })
      const completed = [...host.records.values()].at(-1)!
      const target = completed.target
      if (target?.kind === "background") cleanups.push(() => closeTerminal(target))
      await vi.waitFor(
        async () => {
          await watcher.check(completed.id)
          expect(host.records.get(completed.id)?.state).toBe("completed")
          expect(host.records.get(completed.id)?.result).toBe("completed without a model")
        },
        { timeout: 20000 },
      )
      await vi.waitFor(
        async () => {
          expect((await readFile(join(completed.artifactDir, "process-exit"), "utf8")).trim()).toBe(
            "0",
          )
        },
        { timeout: 10000 },
      )
    },
    60000,
  )
}
