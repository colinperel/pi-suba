import { execFile } from "node:child_process"
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

afterEach(() => vi.resetAllMocks())

function fixture() {
  const record: ChildRecord = {
    id: "child",
    revision: 2,
    state: "awaiting-parent",
    paneId: "%42",
    sessionFile: "/artifacts/session.jsonl",
    artifactDir: "/artifacts",
    placement: { type: "split" },
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
    for (const state of ["running", "launching"] as const) {
      host.records.get("child")!.state = state
      await expect(finishChild(host, "child", "verified")).rejects.toThrow("awaiting parent")
    }
    expect(tmuxExec).not.toHaveBeenCalled()
  })

  it("closes a real child pane without closing its sibling", async () => {
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
      const host = fixture()
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
