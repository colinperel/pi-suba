import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as protocol from "../src/shared/protocol.ts"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "../src/shared/config.ts"
import { tmuxExec } from "../src/shared/tmux.ts"
import { finishChild, type ManagerHost } from "../src/parent/tools.ts"
import type { ChildRecord } from "../src/parent/registry.ts"

vi.mock("../src/shared/tmux.ts", async (original) => ({
  ...(await original<typeof import("../src/shared/tmux.ts")>()),
  tmuxExec: vi.fn(),
}))

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function runningFixture(state: protocol.ChildActivity["state"] = "waiting") {
  const host = fixture()
  const artifactDir = await mkdtemp(join(tmpdir(), "suba-finish-"))
  directories.push(artifactDir)
  const child = host.records.get("child")!
  child.state = "running"
  child.artifactDir = artifactDir
  await protocol.atomicWriteJson(join(artifactDir, "activity.json"), {
    version: 1,
    childId: child.id,
    sequence: 1,
    updatedAt: Date.now(),
    state,
  })
  return host
}

function fixture() {
  const record: ChildRecord = {
    id: "child",
    revision: 2,
    state: "awaiting-parent",
    paneId: "%42",
    sessionFile: "/artifacts/session.jsonl",
    artifactDir: "/artifacts",
    name: "merge-test",
    cwd: "/removed-worktree",
    profile: "default",
    resolvedLaunch: {
      profile: "default",
      tools: "default",
      loadContext: true,
      loadSkills: true,
      systemPrompt: "append",
      autoComplete: false,
    },
    lastEventSequence: 2,
    startedAt: 1,
    resultAfterEntry: 1,
  }
  return {
    config: DEFAULT_CONFIG,
    profiles: new Map(),
    records: new Map([[record.id, record]]),
    persist: vi.fn(),
    refreshWidget: vi.fn(),
    watch: vi.fn(),
  } satisfies ManagerHost
}

describe("parent completion", () => {
  it("records the verified result and closes only the child's pane", async () => {
    const host = fixture()
    Object.assign(host.records.get("child")!, {
      activity: {
        version: 1,
        childId: "child",
        sequence: 1,
        updatedAt: 1,
        state: "working",
        activity: "model",
      },
      activityError: "stale activity read error",
    })
    vi.mocked(tmuxExec).mockImplementation(async () => {
      expect(host.records.get("child")?.state).toBe("completed")
      return ""
    })
    const completed = await finishChild(host, "child", "Verified both changes on main")
    expect(tmuxExec).toHaveBeenCalledExactlyOnceWith(["kill-pane", "-t", "%42"])
    expect(completed).toMatchObject({
      state: "completed",
      revision: 3,
      result: "Verified both changes on main",
      sessionFile: "/artifacts/session.jsonl",
    })
    expect(completed.activity).toBeUndefined()
    expect(completed.activityError).toBeUndefined()
    expect(host.persist).toHaveBeenCalledWith(completed)
    expect(host.refreshWidget).toHaveBeenCalledOnce()
  })

  it("retries persistence without closing the pane twice", async () => {
    const host = fixture()
    vi.mocked(tmuxExec).mockResolvedValue("")
    vi.mocked(host.persist).mockImplementationOnce(() => {
      throw new Error("storage failed")
    })
    await expect(finishChild(host, "child", "verified")).rejects.toThrow("storage failed")
    expect((await finishChild(host, "child", "verified")).state).toBe("completed")
    expect(tmuxExec).toHaveBeenCalledOnce()
    expect(host.persist).toHaveBeenCalledTimes(2)
  })

  it("leaves the child waiting when pane cleanup fails", async () => {
    const host = fixture()
    const previous = host.records.get("child")
    vi.mocked(tmuxExec).mockRejectedValue(new Error("tmux unavailable"))
    await expect(finishChild(host, "child", "verified")).rejects.toThrow("tmux unavailable")
    expect(host.records.get("child")).toBe(previous)
    expect(host.persist).not.toHaveBeenCalled()
  })

  it("rejects unknown or working children and empty results", async () => {
    const host = fixture()
    await expect(finishChild(host, "unknown", "verified")).rejects.toThrow("Unknown")
    await expect(finishChild(host, "child", " ")).rejects.toThrow("summary")
    for (const state of ["launching", "failed", "interrupted", "orphaned"] as const) {
      host.records.get("child")!.state = state
      await expect(finishChild(host, "child", "verified")).rejects.toThrow("awaiting parent")
    }
    const working = await runningFixture("working")
    await expect(finishChild(working, "child", "verified")).rejects.toThrow("must be idle")
    expect(tmuxExec).not.toHaveBeenCalled()
  })

  it.each(["starting", "working", "done"] as const)(
    "rejects fresh %s activity despite a cached waiting state",
    async (state) => {
      const host = await runningFixture(state)
      host.records.get("child")!.activity = {
        version: 1,
        childId: "child",
        sequence: 0,
        updatedAt: 1,
        state: "waiting",
      }
      await expect(finishChild(host, "child", "verified")).rejects.toThrow("must be idle")
      expect(tmuxExec).not.toHaveBeenCalled()
    },
  )

  it.each(["missing", "malformed", "wrong-child"])(
    "rejects %s activity without closing the child",
    async (kind) => {
      const host = await runningFixture()
      const path = join(host.records.get("child")!.artifactDir, "activity.json")
      if (kind === "missing") await rm(path)
      else
        await writeFile(
          path,
          kind === "malformed"
            ? "{"
            : JSON.stringify({
                version: 1,
                childId: "other",
                sequence: 1,
                updatedAt: 1,
                state: "waiting",
              }),
        )
      await expect(finishChild(host, "child", "verified")).rejects.toThrow()
      expect(tmuxExec).not.toHaveBeenCalled()
      expect(host.records.get("child")!.state).toBe("running")
    },
  )

  it("rejects a registry change during the activity read", async () => {
    const host = await runningFixture()
    const read = protocol.readActivity
    vi.spyOn(protocol, "readActivity").mockImplementationOnce(async (...args) => {
      const activity = await read(...args)
      const child = host.records.get("child")!
      host.records.set("child", { ...child, revision: child.revision + 1 })
      return activity
    })
    await expect(finishChild(host, "child", "verified")).rejects.toThrow("changed")
    expect(tmuxExec).not.toHaveBeenCalled()
  })

  it("closes a real idle child pane without an ask or closing its sibling", async () => {
    const exec = promisify(execFile)
    const socket = `pi-suba-finish-${process.pid}`
    const run = async (args: string[]) =>
      (await exec("tmux", ["-L", socket, ...args])).stdout.trim()
    try {
      const sibling = await run([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        "finish",
        "sleep 60",
      ])
      const child = await run([
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        sibling,
        "sleep 60",
      ])
      const host = await runningFixture()
      host.records.get("child")!.paneId = child
      vi.mocked(tmuxExec).mockImplementation(run)
      await finishChild(host, "child", "Verified integration")
      expect(await run(["list-panes", "-t", "finish", "-F", "#{pane_id}"])).toBe(sibling)
      expect(host.records.get("child")?.state).toBe("completed")
    } finally {
      await run(["kill-server"]).catch(() => undefined)
    }
  })
})
