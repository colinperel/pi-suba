import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createTarget,
  paneExists,
  PartialTmuxTargetError,
  type TmuxExec,
} from "../src/shared/tmux.ts"
const exec = promisify(execFile)
const socket = `pi-suba-test-${process.pid}`
const run: TmuxExec = async (args) => (await exec("tmux", ["-L", socket, ...args])).stdout.trim()

describe("tmux target transactions", () => {
  it("removes a partial split target", async () => {
    const calls: string[][] = []
    const run: TmuxExec = async (args) => {
      calls.push(args)
      const command = args[0]
      if (command === "display-message") {
        const format = args.at(-1)
        if (format === "#{window_id}") return "@1"
      }
      if (command === "list-panes") return ""
      if (command === "split-window") return "%9"
      if (command === "set-option") throw new Error("configuration failed")
      if (command === "kill-pane") return ""
      throw new Error(`Unexpected tmux command: ${args.join(" ")}`)
    }

    await expect(createTarget("%1", "sleep 60", run)).rejects.toThrow("configuration failed")
    expect(calls).toContainEqual(["kill-pane", "-t", "%9"])
  })

  it("reports when a partial pane may still be live", async () => {
    const run: TmuxExec = async (args) => {
      if (args[0] === "display-message") return "@1"
      if (args[0] === "list-panes") return ""
      if (args[0] === "split-window") return "%9"
      if (args[0] === "set-option") throw new Error("configuration failed")
      if (args[0] === "kill-pane") throw new Error("cleanup failed")
      throw new Error(`Unexpected tmux command: ${args.join(" ")}`)
    }

    const error = await createTarget("%1", "sleep 60", run).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PartialTmuxTargetError)
    expect((error as PartialTmuxTargetError).paneId).toBe("%9")
  })
})

describe.skipIf(!process.env.PATH)("tmux integration", () => {
  let parentPane = ""
  beforeAll(async () => {
    try {
      await exec("tmux", ["-V"])
    } catch {
      return
    }
    await run([
      "new-session",
      "-d",
      "-x",
      "200",
      "-y",
      "60",
      "-s",
      "test",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 60",
    ]).then((value) => (parentPane = value))
  })
  afterAll(async () => {
    try {
      await run(["kill-server"])
    } catch {}
  })
  it("creates stable panes", async () => {
    if (!parentPane) return
    const target = await createTarget(parentPane, "sleep 60", run)
    expect(target.paneId).toMatch(/^%/)
    expect(await paneExists(target.paneId, run)).toBe(true)
  })
  it("follows a moved parent without reusing its historical child window", async () => {
    if (!parentPane) return
    const root = await run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "test:",
      "sleep 60",
    ])
    const oldChild = await createTarget(root, "sleep 60", run)
    const oldWindow = await run(["display-message", "-p", "-t", root, "#{window_id}"])
    await run(["break-pane", "-d", "-s", root])
    const currentWindow = await run(["display-message", "-p", "-t", root, "#{window_id}"])
    const windowsBefore = await run(["list-windows", "-t", "test", "-F", "#{window_id}"])
    const calls: string[][] = []
    const tracked: TmuxExec = async (args) => {
      calls.push(args)
      return run(args)
    }
    const child = await createTarget(root, "sleep 60", tracked)
    expect(currentWindow).not.toBe(oldWindow)
    expect(await run(["display-message", "-p", "-t", child.paneId, "#{window_id}"])).toBe(
      currentWindow,
    )
    expect(await run(["display-message", "-p", "-t", oldChild.paneId, "#{window_id}"])).toBe(
      oldWindow,
    )
    expect(await run(["list-windows", "-t", "test", "-F", "#{window_id}"])).toBe(windowsBefore)
    expect(calls.some((args) => args[0] === "new-window")).toBe(false)
    expect(calls.find((args) => args[0] === "split-window")).toContain(root)
  })
  it("stacks concurrent splits in a right-hand column", async () => {
    if (!parentPane) return
    const root = await run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-n",
      "stacked",
      "-t",
      "test:",
      "sleep 60",
    ])
    const unrelated = await run([
      "split-window",
      "-h",
      "-d",
      "-p",
      "20",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      root,
      "sleep 60",
    ])
    const unrelatedWidth = await run(["display-message", "-p", "-t", unrelated, "#{pane_width}"])
    const children = await Promise.all([
      createTarget(root, "sleep 60", run),
      createTarget(root, "sleep 60", run),
      createTarget(root, "sleep 60", run),
    ])
    const geometry = await Promise.all(
      [root, ...children.map((child) => child.paneId)].map(async (pane) => {
        const [left, top, width, height] = (
          await run([
            "display-message",
            "-p",
            "-t",
            pane,
            "#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
          ])
        )
          .split("\t")
          .map(Number)
        return { left, top, width, height }
      }),
    )
    const [parent, ...childPanes] = geometry
    expect(childPanes.every((pane) => pane.left > parent.left)).toBe(true)
    expect(new Set(childPanes.map((pane) => pane.left)).size).toBe(1)
    expect(new Set(childPanes.map((pane) => pane.width)).size).toBe(1)
    expect(
      Math.max(...childPanes.map((pane) => pane.height)) -
        Math.min(...childPanes.map((pane) => pane.height)),
    ).toBeLessThanOrEqual(1)
    expect(
      childPanes.every((pane, index) => index === 0 || pane.top > childPanes[index - 1]!.top),
    ).toBe(true)
    expect(await run(["display-message", "-p", "-t", unrelated, "#{pane_width}"])).toBe(
      unrelatedWidth,
    )
  })
})
