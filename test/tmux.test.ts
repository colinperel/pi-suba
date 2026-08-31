import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createTarget,
  paneExists,
  PartialTmuxTargetError,
  sendToPane,
  subaWindowName,
  type TmuxExec,
} from "../src/shared/tmux.ts"
const exec = promisify(execFile)
const socket = `pi-suba-test-${process.pid}`
const run: TmuxExec = async (args, input) => {
  if (input === undefined) return (await exec("tmux", ["-L", socket, ...args])).stdout.trim()
  const child = execFile("tmux", ["-L", socket, ...args])
  child.stdin?.end(input)
  return await new Promise((resolve, reject) => {
    let out = "",
      err = ""
    child.stdout?.on("data", (d) => (out += d))
    child.stderr?.on("data", (d) => (err += d))
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))))
  })
}

describe("tmux window names", () => {
  it("uses one suba prefix and sanitizes the name", () => {
    expect(subaWindowName("review task")).toBe("suba-review-task")
    expect(subaWindowName("suba-review")).toBe("suba-review")
    expect(subaWindowName("suba")).toBe("suba")
  })
})

describe("tmux target transactions", () => {
  it.each([
    [{ type: "split" } as const, "split-window"],
    [{ type: "window" } as const, "new-window"],
    [{ type: "shared-window", windowName: "agents" } as const, "new-window"],
  ])("removes a partial %s target", async (placement, createCommand) => {
    const calls: string[][] = []
    const run: TmuxExec = async (args) => {
      calls.push(args)
      const command = args[0]
      if (command === "display-message") {
        const format = args.at(-1)
        if (format === "#{window_id}") return "@1"
        if (format === "#{session_id}") return "$1"
      }
      if (command === "list-panes" || command === "list-windows") return ""
      if (command === createCommand) return "%9"
      if (command === "set-option") throw new Error("configuration failed")
      if (command === "kill-pane") return ""
      throw new Error(`Unexpected tmux command: ${args.join(" ")}`)
    }

    await expect(createTarget(placement, "%1", "sleep 60", "child", "suba", run)).rejects.toThrow(
      "configuration failed",
    )
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

    const error = await createTarget(
      { type: "split" },
      "%1",
      "sleep 60",
      "child",
      "suba",
      run,
    ).catch((caught: unknown) => caught)
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
  it("creates stable panes and sends literal and multiline input", async () => {
    if (!parentPane) return
    const target = await createTarget(
      { type: "split" },
      parentPane,
      "cat > /tmp/pi-suba-tmux-input",
      "child",
      "suba",
      run,
    )
    expect(target.paneId).toMatch(/^%/)
    expect(await paneExists(target.paneId, run)).toBe(true)
    await sendToPane(target.paneId, "one line", run)
  })
  it("creates a prefixed dedicated window", async () => {
    if (!parentPane) return
    const target = await createTarget(
      { type: "window" },
      parentPane,
      "sleep 60",
      "watcher-research",
      "suba",
      run,
    )
    expect(await run(["display-message", "-p", "-t", target.paneId, "#{window_name}"])).toBe(
      "suba-watcher-research",
    )
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
      createTarget({ type: "split" }, root, "sleep 60", "one", "suba", run),
      createTarget({ type: "split" }, root, "sleep 60", "two", "suba", run),
      createTarget({ type: "split" }, root, "sleep 60", "three", "suba", run),
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
  it("stacks panes in a shared window", async () => {
    if (!parentPane) return
    const [first, second] = await Promise.all([
      createTarget(
        { type: "shared-window", windowName: "agents" },
        parentPane,
        "sleep 60",
        "one",
        "suba",
        run,
      ),
      createTarget(
        { type: "shared-window", windowName: "agents" },
        parentPane,
        "sleep 60",
        "two",
        "suba",
        run,
      ),
    ])
    expect(first.paneId).not.toBe(second.paneId)
    expect(first.windowId).toBe(second.windowId)
    expect(await run(["display-message", "-p", "-t", first.paneId, "#{window_name}"])).toBe(
      "suba-agents",
    )
    const widths = await Promise.all(
      [first.paneId, second.paneId].map((pane) =>
        run(["display-message", "-p", "-t", pane, "#{pane_width}"]),
      ),
    )
    expect(new Set(widths).size).toBe(1)
  })
  it("keeps a workmux sidebar beside shared-window panes", async () => {
    if (!parentPane) return
    const first = await createTarget(
      { type: "shared-window", windowName: "sidebar-agents" },
      parentPane,
      "sleep 60",
      "one",
      "suba",
      run,
    )
    const sidebar = await run([
      "split-window",
      "-hbf",
      "-l",
      "20",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      first.paneId,
      "sleep 60",
    ])
    await run(["set-option", "-p", "-t", sidebar, "@workmux_role", "sidebar"])
    const second = await createTarget(
      { type: "shared-window", windowName: "sidebar-agents" },
      parentPane,
      "sleep 60",
      "two",
      "suba",
      run,
    )
    const third = await createTarget(
      { type: "shared-window", windowName: "sidebar-agents" },
      parentPane,
      "sleep 60",
      "three",
      "suba",
      run,
    )
    const fourth = await createTarget(
      { type: "shared-window", windowName: "sidebar-agents" },
      parentPane,
      "sleep 60",
      "four",
      "suba",
      run,
    )
    const geometry = await Promise.all(
      [sidebar, first.paneId, second.paneId, third.paneId, fourth.paneId].map(async (pane) => {
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
    const [sidebarPane, ...agents] = geometry
    expect(sidebarPane.top).toBe(0)
    expect(sidebarPane.height).toBe(60)
    expect(agents.every((pane) => pane.left > sidebarPane.left)).toBe(true)
    expect(new Set(agents.map((pane) => pane.left)).size).toBe(2)
    expect(new Set(agents.map((pane) => pane.top)).size).toBe(2)
    expect(new Set(agents.map((pane) => pane.width)).size).toBe(1)
    expect(
      Math.max(...agents.map((pane) => pane.height)) -
        Math.min(...agents.map((pane) => pane.height)),
    ).toBeLessThanOrEqual(1)
  })
})
