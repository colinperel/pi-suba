import { execFile, spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  createRexTarget,
  REX_FIRST_WORKER_RATIO,
  UncertainRexLaunchError,
  type RexExec,
  type RexLayoutNode,
  type RexSessionView,
} from "../src/shared/rex.ts"
import { openTerminal } from "../src/shared/terminal.ts"

const exec = promisify(execFile)
const hasRex = spawnSync("rex", ["version"]).status === 0

function recomputeRects(node: RexLayoutNode, rect: [number, number, number, number]): void {
  node.rect = rect
  if (!node.split) return
  const [x, y, w, h] = rect
  if (node.split.direction === "horizontal") {
    const beforeW = w * node.split.ratio
    recomputeRects(node.split.before, [x, y, beforeW, h])
    recomputeRects(node.split.after, [x + beforeW, y, w - beforeW, h])
  } else {
    const beforeH = h * node.split.ratio
    recomputeRects(node.split.before, [x, y, w, beforeH])
    recomputeRects(node.split.after, [x, y + beforeH, w, h - beforeH])
  }
}

function collectRects(
  node: RexLayoutNode,
  into = new Map<string, [number, number, number, number]>(),
): Map<string, [number, number, number, number]> {
  if (node.block_id) {
    into.set(node.block_id, node.rect)
    return into
  }
  if (node.split) {
    collectRects(node.split.before, into)
    collectRects(node.split.after, into)
  }
  return into
}

function containsBlock(node: RexLayoutNode, blockId: string): boolean {
  if (node.block_id === blockId) return true
  if (!node.split) return false
  return containsBlock(node.split.before, blockId) || containsBlock(node.split.after, blockId)
}

function replaceBlockWithSplit(
  node: RexLayoutNode,
  anchorId: string,
  direction: "horizontal" | "vertical",
  ratio: number,
  newBlockId: string,
  splitId: string,
): boolean {
  if (node.block_id === anchorId) {
    node.block_id = undefined
    node.split = {
      split_id: splitId,
      direction,
      ratio,
      before: { rect: [...node.rect], block_id: anchorId },
      after: { rect: [...node.rect], block_id: newBlockId },
    }
    return true
  }
  if (!node.split) return false
  return (
    replaceBlockWithSplit(node.split.before, anchorId, direction, ratio, newBlockId, splitId) ||
    replaceBlockWithSplit(node.split.after, anchorId, direction, ratio, newBlockId, splitId)
  )
}

function removeBlock(node: RexLayoutNode, blockId: string): RexLayoutNode | null {
  if (node.block_id === blockId) return null
  if (!node.split) return node
  const before = removeBlock(node.split.before, blockId)
  const after = removeBlock(node.split.after, blockId)
  if (!before) return after
  if (!after) return before
  node.split.before = before
  node.split.after = after
  return node
}

function resizeInnermostSplit(
  node: RexLayoutNode,
  direction: "horizontal" | "vertical",
  beforeBlockId: string,
  afterBlockId: string,
  ratio: number,
): boolean {
  if (!node.split) return false
  if (
    resizeInnermostSplit(node.split.before, direction, beforeBlockId, afterBlockId, ratio) ||
    resizeInnermostSplit(node.split.after, direction, beforeBlockId, afterBlockId, ratio)
  ) {
    return true
  }
  if (
    node.split.direction === direction &&
    containsBlock(node.split.before, beforeBlockId) &&
    containsBlock(node.split.after, afterBlockId)
  ) {
    node.split.ratio = ratio
    return true
  }
  return false
}

class FakeRexServer {
  readonly sessionId: string
  readonly calls: string[][] = []
  windows: Array<{
    window_id: string
    focused_block_id: string
    layout: RexLayoutNode
  }>
  private nextId = 1

  constructor(sessionId: string, initialParentId: string) {
    this.sessionId = sessionId
    this.windows = [
      {
        window_id: "window:1",
        focused_block_id: initialParentId,
        layout: { rect: [0, 0, 1, 1], block_id: initialParentId },
      },
    ]
  }

  view(): RexSessionView {
    for (const win of this.windows) recomputeRects(win.layout, [0, 0, 1, 1])
    return {
      session_id: this.sessionId,
      windows: this.windows.map((win) => ({
        window_id: win.window_id,
        focused_block_id: win.focused_block_id,
        layers: [{ layer_id: `${win.window_id}:tiled`, layout: structuredClone(win.layout) }],
      })),
    }
  }

  rects(windowIndex = 0): Map<string, [number, number, number, number]> {
    const win = this.windows[windowIndex]!
    recomputeRects(win.layout, [0, 0, 1, 1])
    return collectRects(win.layout)
  }

  split(anchorId: string, direction: "right" | "below", ratioPct: number, newBlockId?: string) {
    const id = newBlockId ?? `block:w${this.nextId++}`
    const splitId = `split:${this.nextId++}`
    const splitDir = direction === "right" ? "horizontal" : "vertical"
    const beforeRatio = 1 - ratioPct / 100
    for (const win of this.windows) {
      if (replaceBlockWithSplit(win.layout, anchorId, splitDir, beforeRatio, id, splitId)) {
        recomputeRects(win.layout, [0, 0, 1, 1])
        return { anchor_id: anchorId, block_ids: [id], split_ids: [splitId], revision: this.nextId }
      }
    }
    throw new Error(`No such block: ${anchorId}`)
  }

  close(blockId: string): void {
    for (const win of this.windows) {
      if (!containsBlock(win.layout, blockId)) continue
      const remaining = removeBlock(win.layout, blockId)
      if (remaining) {
        win.layout = remaining
        recomputeRects(win.layout, [0, 0, 1, 1])
      }
    }
  }

  moveToNewWindow(blockId: string, windowId: string): void {
    this.close(blockId)
    this.windows.push({
      window_id: windowId,
      focused_block_id: blockId,
      layout: { rect: [0, 0, 1, 1], block_id: blockId },
    })
  }

  exec(options: { delaySplitMs?: number; failResize?: boolean } = {}): RexExec {
    return async (args) => {
      this.calls.push(args)
      if (args[0] === "block" && args[1] === "inspect") {
        const blockId = args[2]!
        if (!this.windows.some((win) => containsBlock(win.layout, blockId))) {
          throw new Error(`No such block: ${blockId}`)
        }
        return JSON.stringify({ session_id: this.sessionId, block: { block_id: blockId } })
      }
      if (args[0] === "session" && args[1] === "inspect") {
        if (args[2] !== this.sessionId) throw new Error(`No such session: ${args[2]}`)
        return JSON.stringify(this.view())
      }
      if (args[0] === "split") {
        if (options.delaySplitMs) {
          await new Promise((resolve) => setTimeout(resolve, options.delaySplitMs))
        }
        const anchorIdx = args.indexOf("-b")
        const anchorId = anchorIdx >= 0 ? args[anchorIdx + 1]! : ""
        const splitFlag = args.find((arg) => arg.startsWith("--split=")) ?? "--split=right"
        const ratioFlag = args.find((arg) => arg.startsWith("--ratio=")) ?? "--ratio=50"
        const direction = splitFlag.slice("--split=".length) as "right" | "below"
        const ratioPct = Number(ratioFlag.slice("--ratio=".length))
        return JSON.stringify(this.split(anchorId, direction, ratioPct))
      }
      if (args[0] === "api" && args[1] === "call") {
        const methodIdx = args.indexOf("session.resize_pane")
        if (methodIdx === -1) throw new Error(`Unexpected api call: ${args.join(" ")}`)
        if (options.failResize) throw new Error("resize failed")
        const payload = JSON.parse(args[methodIdx + 1]!) as {
          direction: "horizontal" | "vertical"
          before_block_id: string
          after_block_id: string
          ratio: number
        }
        for (const win of this.windows) {
          if (
            resizeInnermostSplit(
              win.layout,
              payload.direction,
              payload.before_block_id,
              payload.after_block_id,
              payload.ratio,
            )
          ) {
            recomputeRects(win.layout, [0, 0, 1, 1])
            return JSON.stringify({ revision: this.nextId++ })
          }
        }
        throw new Error("No matching split for resize_pane")
      }
      throw new Error(`Unexpected rex command: ${args.join(" ")}`)
    }
  }
}

describe("rex layout management", () => {
  it("opens the first worker at 65/35 and stacks sequential workers vertically at equal heights", async () => {
    const server = new FakeRexServer("session:seq", "block:parent")
    const ownedBlocks = new Set<string>()
    const run = server.exec()
    const host = { parentId: "block:parent", sessionId: "session:seq" }

    const w1 = await createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run })
    expect(server.calls[0]).toContain(`--ratio=${REX_FIRST_WORKER_RATIO}`)
    expect(server.calls[0]).toContain("--split=right")
    expect(server.calls[0]).toContain("--focus=false")
    expect(server.rects().get("block:parent")?.[2]).toBeCloseTo(0.65, 6)
    expect(server.rects().get(w1.id)?.[2]).toBeCloseTo(0.35, 6)

    const w2 = await createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run })
    const rectsAfter2 = server.rects()
    expect(rectsAfter2.get("block:parent")).toEqual([0, 0, 0.65, 1])
    expect(rectsAfter2.get(w1.id)?.[3]).toBeCloseTo(0.5, 6)
    expect(rectsAfter2.get(w2.id)?.[3]).toBeCloseTo(0.5, 6)

    const w3 = await createRexTarget(host, "/tmp/w3.sh", { ownedBlocks, run })
    const rectsAfter3 = server.rects()
    expect(rectsAfter3.get("block:parent")).toEqual([0, 0, 0.65, 1])
    for (const id of [w1.id, w2.id, w3.id]) {
      const rect = rectsAfter3.get(id)!
      expect(rect[0]).toBeCloseTo(0.65, 6)
      expect(rect[2]).toBeCloseTo(0.35, 6)
      expect(rect[3]).toBeCloseTo(1 / 3, 5)
    }
    expect(rectsAfter3.get(w1.id)![1]).toBeLessThan(rectsAfter3.get(w2.id)![1])
    expect(rectsAfter3.get(w2.id)![1]).toBeLessThan(rectsAfter3.get(w3.id)![1])
    expect(server.windows[0]!.focused_block_id).toBe("block:parent")

    const w4 = await createRexTarget(host, "/tmp/w4.sh", { ownedBlocks, run })
    const rectsAfter4 = server.rects()
    expect(rectsAfter4.get("block:parent")).toEqual([0, 0, 0.65, 1])
    for (const id of [w1.id, w2.id, w3.id, w4.id]) {
      expect(rectsAfter4.get(id)![3]).toBeCloseTo(0.25, 5)
    }
  })

  it("serializes concurrent launches into one equal-height right column", async () => {
    const server = new FakeRexServer("session:conc", "block:parent")
    const ownedBlocks = new Set<string>()
    const run = server.exec({ delaySplitMs: 15 })
    const host = { parentId: "block:parent", sessionId: "session:conc" }

    const workers = await Promise.all([
      createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run }),
      createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run }),
      createRexTarget(host, "/tmp/w3.sh", { ownedBlocks, run }),
    ])

    const rects = server.rects()
    expect(rects.get("block:parent")).toEqual([0, 0, 0.65, 1])
    for (const worker of workers) {
      const rect = rects.get(worker.id)!
      expect(rect[0]).toBeCloseTo(0.65, 6)
      expect(rect[2]).toBeCloseTo(0.35, 6)
      expect(rect[3]).toBeCloseTo(1 / 3, 5)
    }
    expect(rects.get(workers[0]!.id)![1]).toBeLessThan(rects.get(workers[1]!.id)![1])
    expect(rects.get(workers[1]!.id)![1]).toBeLessThan(rects.get(workers[2]!.id)![1])
    expect(server.windows[0]!.focused_block_id).toBe("block:parent")
  })

  it("groups only workers owned by that parent and leaves unrelated panes untouched", async () => {
    const server = new FakeRexServer("session:iso", "block:p1")
    // Create an unrelated pane on the right (20%) and a second parent (block:p2)
    server.split("block:p1", "right", 20, "block:unrelated")
    server.split("block:p1", "right", 50, "block:p2")
    const initialRects = server.rects()
    const unrelatedRect = [...initialRects.get("block:unrelated")!]
    const p1Width = initialRects.get("block:p1")![2]
    const p2Width = initialRects.get("block:p2")![2]

    const run = server.exec()
    const p1Owned = new Set<string>()
    const p2Owned = new Set<string>()

    const [p1w1, p1w2, p1w3] = [
      await createRexTarget({ parentId: "block:p1", sessionId: "session:iso" }, "/tmp/p1w1.sh", {
        ownedBlocks: p1Owned,
        run,
      }),
      await createRexTarget({ parentId: "block:p1", sessionId: "session:iso" }, "/tmp/p1w2.sh", {
        ownedBlocks: p1Owned,
        run,
      }),
      await createRexTarget({ parentId: "block:p1", sessionId: "session:iso" }, "/tmp/p1w3.sh", {
        ownedBlocks: p1Owned,
        run,
      }),
    ]
    const [p2w1, p2w2] = await Promise.all([
      createRexTarget({ parentId: "block:p2", sessionId: "session:iso" }, "/tmp/p2w1.sh", {
        ownedBlocks: p2Owned,
        run,
      }),
      createRexTarget({ parentId: "block:p2", sessionId: "session:iso" }, "/tmp/p2w2.sh", {
        ownedBlocks: p2Owned,
        run,
      }),
    ])

    const rects = server.rects()
    expect(rects.get("block:unrelated")).toEqual(unrelatedRect)
    expect(rects.get("block:p1")![2]).toBeCloseTo(p1Width * 0.65, 6)
    expect(rects.get("block:p2")![2]).toBeCloseTo(p2Width * 0.65, 6)
    for (const worker of [p1w1, p1w2, p1w3]) {
      expect(rects.get(worker.id)![2]).toBeCloseTo(p1Width * 0.35, 6)
      expect(rects.get(worker.id)![3]).toBeCloseTo(1 / 3, 5)
    }
    for (const worker of [p2w1, p2w2]) {
      expect(rects.get(worker.id)![2]).toBeCloseTo(p2Width * 0.35, 6)
      expect(rects.get(worker.id)![3]).toBeCloseTo(0.5, 5)
    }
  })

  it("does not resize unrelated panes placed inside the worker column", async () => {
    const server = new FakeRexServer("session:mixed", "block:parent")
    const ownedBlocks = new Set<string>()
    const run = server.exec()
    const host = { parentId: "block:parent", sessionId: "session:mixed" }

    const w1 = await createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run })
    server.split(w1.id, "below", 30, "block:unrelated-bottom")
    const unrelatedBefore = [...server.rects().get("block:unrelated-bottom")!]

    const w2 = await createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run })
    const w3 = await createRexTarget(host, "/tmp/w3.sh", { ownedBlocks, run })

    const rects = server.rects()
    expect(rects.get("block:parent")![2]).toBeCloseTo(0.65, 6)
    expect(rects.get("block:unrelated-bottom")).toEqual(unrelatedBefore)
    for (const id of [w1.id, w2.id, w3.id]) {
      expect(rects.get(id)![3]).toBeCloseTo(0.7 / 3, 5)
    }
  })

  it("follows a moved parent without reusing its historical worker window", async () => {
    const server = new FakeRexServer("session:move", "block:parent")
    const ownedBlocks = new Set<string>()
    const run = server.exec()
    const host = { parentId: "block:parent", sessionId: "session:move" }

    const oldWorker = await createRexTarget(host, "/tmp/old.sh", { ownedBlocks, run })
    server.moveToNewWindow("block:parent", "window:2")

    const newWorker = await createRexTarget(host, "/tmp/new.sh", { ownedBlocks, run })
    expect(server.rects(0).has(oldWorker.id)).toBe(true)
    expect(server.rects(0).has(newWorker.id)).toBe(false)
    expect(server.rects(1).get("block:parent")![2]).toBeCloseTo(0.65, 6)
    expect(server.rects(1).get(newWorker.id)![2]).toBeCloseTo(0.35, 6)
  })

  it("recovers when the previous worker exits right before stacking onto it", async () => {
    const server = new FakeRexServer("session:vanish", "block:parent")
    const ownedBlocks = new Set<string>()
    const baseRun = server.exec()
    let closedOnce = false
    const run: RexExec = async (args) => {
      if (args[0] === "split" && args.includes("--split=below") && !closedOnce) {
        closedOnce = true
        const anchorId = args[args.indexOf("-b") + 1]!
        server.close(anchorId)
        throw new Error(`Error: block target "${anchorId}" not found`)
      }
      return baseRun(args)
    }
    const host = { parentId: "block:parent", sessionId: "session:vanish" }

    await createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run })
    const w2 = await createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run })

    expect(server.rects().get("block:parent")![2]).toBeCloseTo(0.65, 6)
    expect(server.rects().get(w2.id)![2]).toBeCloseTo(0.35, 6)
    expect(server.rects().get(w2.id)![3]).toBeCloseTo(1, 6)
  })

  it("does not retry when a split response is lost even if the anchor exits before re-inspect", async () => {
    const server = new FakeRexServer("session:eof", "block:parent")
    const ownedBlocks = new Set<string>()
    const baseRun = server.exec()
    let splitCalls = 0
    const run: RexExec = async (args) => {
      if (args[0] === "split" && args.includes("--split=below")) {
        splitCalls += 1
        const anchorId = args[args.indexOf("-b") + 1]!
        // Simulate Rex creating the worker, losing the response, and the anchor exiting.
        server.split(anchorId, "below", 50)
        server.close(anchorId)
        throw new Error("unexpected EOF")
      }
      return baseRun(args)
    }
    const host = { parentId: "block:parent", sessionId: "session:eof" }

    await createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run })
    await expect(createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run })).rejects.toBeInstanceOf(
      UncertainRexLaunchError,
    )
    expect(splitCalls).toBe(1)
  })

  it("ignores argv paths in execFile messages when deciding whether to retry a missing anchor", async () => {
    const server = new FakeRexServer("session:argv", "block:parent")
    const ownedBlocks = new Set<string>()
    const baseRun = server.exec()
    let notFoundPathSplitCalls = 0
    const runNotFoundPath: RexExec = async (args) => {
      if (args[0] === "split" && args.includes("--split=below")) {
        notFoundPathSplitCalls += 1
        const anchorId = args[args.indexOf("-b") + 1]!
        server.split(anchorId, "below", 50)
        server.close(anchorId)
        const error = Object.assign(
          new Error(
            `Command failed: rex split -b ${anchorId} -- /tmp/not_found/launch.sh\nconnection reset by peer`,
          ),
          { stderr: "connection reset by peer\n" },
        )
        throw error
      }
      return baseRun(args)
    }
    const host = { parentId: "block:parent", sessionId: "session:argv" }
    await createRexTarget(host, "/tmp/not_found/w1.sh", { ownedBlocks, run: runNotFoundPath })
    await expect(
      createRexTarget(host, "/tmp/not_found/w2.sh", { ownedBlocks, run: runNotFoundPath }),
    ).rejects.toBeInstanceOf(UncertainRexLaunchError)
    expect(notFoundPathSplitCalls).toBe(1)

    const server2 = new FakeRexServer("session:deadline-path", "block:parent")
    const owned2 = new Set<string>()
    const baseRun2 = server2.exec()
    let closedOnce = false
    const runDeadlinePath: RexExec = async (args) => {
      if (args[0] === "split" && args.includes("--split=below") && !closedOnce) {
        closedOnce = true
        const anchorId = args[args.indexOf("-b") + 1]!
        server2.close(anchorId)
        const stderr = `Error: block target "${anchorId}" not found\n`
        const error = Object.assign(
          new Error(`Command failed: rex split -b ${anchorId} -- /tmp/deadline/w2.sh\n${stderr}`),
          { stderr },
        )
        throw error
      }
      return baseRun2(args)
    }
    const host2 = { parentId: "block:parent", sessionId: "session:deadline-path" }
    await createRexTarget(host2, "/tmp/deadline/w1.sh", {
      ownedBlocks: owned2,
      run: runDeadlinePath,
    })
    const recovered = await createRexTarget(host2, "/tmp/deadline/w2.sh", {
      ownedBlocks: owned2,
      run: runDeadlinePath,
    })
    expect(server2.rects().get(recovered.id)![2]).toBeCloseTo(0.35, 6)
    expect(server2.rects().get(recovered.id)![3]).toBeCloseTo(1, 6)
  })

  it("reinspects before each resize so an unrelated split inserted mid-equalization stays untouched", async () => {
    const server = new FakeRexServer("session:mid-resize", "block:parent")
    const ownedBlocks = new Set<string>()
    const baseRun = server.exec()
    const host = { parentId: "block:parent", sessionId: "session:mid-resize" }

    await createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run: baseRun })
    const w2 = await createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run: baseRun })
    await createRexTarget(host, "/tmp/w3.sh", { ownedBlocks, run: baseRun })

    let resizeCalls = 0
    let unrelatedHeightAfterInsert = 0
    const run: RexExec = async (args) => {
      const result = await baseRun(args)
      if (args[0] === "api" && args.includes("session.resize_pane")) {
        resizeCalls += 1
        if (resizeCalls === 1) {
          server.split(w2.id, "below", 50, "block:unrelated-mid")
          unrelatedHeightAfterInsert = server.rects().get("block:unrelated-mid")![3]
        }
      }
      return result
    }

    await createRexTarget(host, "/tmp/w4.sh", { ownedBlocks, run })
    expect(resizeCalls).toBe(1)
    expect(server.rects().get("block:unrelated-mid")![3]).toBeCloseTo(unrelatedHeightAfterInsert, 6)
  })

  it("chooses the taller owned group when an unrelated pane splits the bottom worker", async () => {
    const server = new FakeRexServer("session:taller-group", "block:parent")
    const ownedBlocks = new Set<string>()
    const run = server.exec()
    const host = { parentId: "block:parent", sessionId: "session:taller-group" }

    const w1 = await createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run })
    const w2 = await createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run })
    server.split(w2.id, "below", 50, "block:unrelated-bottom")
    const unrelatedBefore = [...server.rects().get("block:unrelated-bottom")!]

    const w3 = await createRexTarget(host, "/tmp/w3.sh", { ownedBlocks, run })
    const rects = server.rects()

    expect(rects.get("block:parent")![2]).toBeCloseTo(0.65, 6)
    expect(rects.get("block:unrelated-bottom")).toEqual(unrelatedBefore)
    for (const id of [w1.id, w2.id, w3.id]) {
      expect(rects.get(id)![3]).toBeCloseTo(0.25, 5)
    }
  })

  it("resolves session_id from block inspect when omitted and seeds knownChildren across restarts", async () => {
    const server = new FakeRexServer("session:resume", "block:parent")
    const existing = server.split("block:parent", "right", 35, "block:persisted-w1")
    const run = server.exec()
    const ownedBlocks = new Set<string>()

    const w2 = await createRexTarget({ parentId: "block:parent" }, "/tmp/w2.sh", {
      knownChildren: [existing.block_ids[0]!],
      ownedBlocks,
      run,
    })
    expect(w2.sessionId).toBe("session:resume")
    expect(server.calls.some((call) => call[0] === "block" && call[1] === "inspect")).toBe(true)

    const w3 = await createRexTarget({ parentId: "block:parent" }, "/tmp/w3.sh", {
      ownedBlocks,
      run,
    })
    const rects = server.rects()
    expect(rects.get("block:parent")![2]).toBeCloseTo(0.65, 6)
    for (const id of ["block:persisted-w1", w2.id, w3.id]) {
      expect(rects.get(id)![3]).toBeCloseTo(1 / 3, 5)
    }
  })

  it("keeps the launched worker when post-split equalization fails", async () => {
    const server = new FakeRexServer("session:noresize", "block:parent")
    const ownedBlocks = new Set<string>()
    const run = server.exec({ failResize: true })
    const host = { parentId: "block:parent", sessionId: "session:noresize" }

    await createRexTarget(host, "/tmp/w1.sh", { ownedBlocks, run })
    await createRexTarget(host, "/tmp/w2.sh", { ownedBlocks, run })
    const w3 = await createRexTarget(host, "/tmp/w3.sh", { ownedBlocks, run })

    expect(w3.id).toBeTruthy()
    expect(server.rects().get("block:parent")![2]).toBeCloseTo(0.65, 6)
    expect(server.rects().has(w3.id)).toBe(true)
  })
})

describe.skipIf(!hasRex)("rex integration", () => {
  let rexDir = ""
  let stateDir = ""
  let scriptPath = ""
  let env: NodeJS.ProcessEnv = {}
  let serverStarted = false

  const runRex: RexExec = async (args) => (await exec("rex", args, { env })).stdout

  async function inspectRects(sessionId: string) {
    const view = JSON.parse(
      await runRex(["session", "inspect", sessionId, "--json"]),
    ) as RexSessionView
    const win = view.windows?.[0]
    const layout = win?.layers?.[0]?.layout
    return {
      view,
      focusedBlockId: win?.focused_block_id,
      rects: layout ? collectRects(layout) : new Map<string, [number, number, number, number]>(),
    }
  }

  async function createSession(label: string) {
    const created = JSON.parse(await runRex(["new", label, "--json", "--", "sleep", "120"])) as {
      session_id: string
      initial_windows: Array<{ block_ids: string[] }>
    }
    return {
      sessionId: created.session_id,
      parentId: created.initial_windows[0]!.block_ids[0]!,
    }
  }

  beforeAll(async () => {
    rexDir = await mkdtemp("/tmp/suba-rex-layout-")
    env = { ...process.env, REX_RUNTIME_DIR: rexDir, REX_SERVER: "" }
    stateDir = join(rexDir, "state")
    const configPath = join(rexDir, "empty.lua")
    scriptPath = join(rexDir, "worker.sh")
    await writeFile(configPath, "")
    await writeFile(scriptPath, "#!/bin/sh\nsleep 120\n", { mode: 0o700 })
    await runRex([
      "server",
      "start",
      "--restore=false",
      "--env",
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "--state-dir",
      stateDir,
      "--config",
      configPath,
    ])
    serverStarted = true
  }, 30000)

  afterAll(async () => {
    if (!rexDir) return
    if (serverStarted && env.REX_RUNTIME_DIR === rexDir) {
      await runRex(["server", "stop"]).catch(() => undefined)
    }
    await rm(rexDir, { recursive: true, force: true })
  })

  it("keeps the parent at 65% and stacks three sequential workers equally without stealing focus", async () => {
    const { sessionId, parentId } = await createSession("seq-3")
    const ownedBlocks = new Set<string>()
    const host = { parentId, sessionId }

    const w1 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })
    const w2 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })
    const w3 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })

    const { focusedBlockId, rects } = await inspectRects(sessionId)
    expect(focusedBlockId).toBe(parentId)
    expect(rects.get(parentId)?.[0]).toBeCloseTo(0, 5)
    expect(rects.get(parentId)?.[2]).toBeCloseTo(0.65, 4)
    expect(rects.get(parentId)?.[3]).toBeCloseTo(1, 5)

    for (const worker of [w1, w2, w3]) {
      const rect = rects.get(worker.id)!
      expect(rect[0]).toBeCloseTo(0.65, 4)
      expect(rect[2]).toBeCloseTo(0.35, 4)
      expect(rect[3]).toBeCloseTo(1 / 3, 2)
    }
    expect(rects.get(w1.id)![1]).toBeLessThan(rects.get(w2.id)![1])
    expect(rects.get(w2.id)![1]).toBeLessThan(rects.get(w3.id)![1])
  }, 30000)

  it("stacks three concurrent workers equally in the right column without shrinking the parent", async () => {
    const { sessionId, parentId } = await createSession("conc-3")
    const ownedBlocks = new Set<string>()
    const host = { parentId, sessionId }

    const workers = await Promise.all([
      createRexTarget(host, scriptPath, { ownedBlocks, run: runRex }),
      createRexTarget(host, scriptPath, { ownedBlocks, run: runRex }),
      createRexTarget(host, scriptPath, { ownedBlocks, run: runRex }),
    ])

    const { focusedBlockId, rects } = await inspectRects(sessionId)
    expect(focusedBlockId).toBe(parentId)
    expect(rects.get(parentId)?.[2]).toBeCloseTo(0.65, 4)
    expect(rects.get(parentId)?.[3]).toBeCloseTo(1, 5)
    for (const worker of workers) {
      const rect = rects.get(worker.id)!
      expect(rect[0]).toBeCloseTo(0.65, 4)
      expect(rect[2]).toBeCloseTo(0.35, 4)
      expect(rect[3]).toBeCloseTo(1 / 3, 2)
    }
    expect(rects.get(workers[0]!.id)![1]).toBeLessThan(rects.get(workers[1]!.id)![1])
    expect(rects.get(workers[1]!.id)![1]).toBeLessThan(rects.get(workers[2]!.id)![1])
  }, 30000)

  it("leaves unrelated panes untouched and isolates multiple parents in the same tab", async () => {
    const { sessionId, parentId: p1 } = await createSession("iso-real")
    const unrelated = (
      JSON.parse(
        await runRex([
          "split",
          "-s",
          sessionId,
          "-b",
          p1,
          "--split=right",
          "--ratio=20",
          "--focus=false",
          "--json",
          "--",
          "sleep",
          "120",
        ]),
      ) as { block_ids: string[] }
    ).block_ids[0]!
    const p2 = (
      JSON.parse(
        await runRex([
          "split",
          "-s",
          sessionId,
          "-b",
          p1,
          "--split=right",
          "--ratio=50",
          "--focus=false",
          "--json",
          "--",
          "sleep",
          "120",
        ]),
      ) as { block_ids: string[] }
    ).block_ids[0]!

    const before = (await inspectRects(sessionId)).rects
    const unrelatedBefore = before.get(unrelated)!
    const p1BeforeWidth = before.get(p1)![2]
    const p2BeforeWidth = before.get(p2)![2]

    const p1Owned = new Set<string>()
    const p2Owned = new Set<string>()
    const p1Workers = await Promise.all([
      createRexTarget({ parentId: p1, sessionId }, scriptPath, {
        ownedBlocks: p1Owned,
        run: runRex,
      }),
      createRexTarget({ parentId: p1, sessionId }, scriptPath, {
        ownedBlocks: p1Owned,
        run: runRex,
      }),
    ])
    const p2Workers = await Promise.all([
      createRexTarget({ parentId: p2, sessionId }, scriptPath, {
        ownedBlocks: p2Owned,
        run: runRex,
      }),
      createRexTarget({ parentId: p2, sessionId }, scriptPath, {
        ownedBlocks: p2Owned,
        run: runRex,
      }),
    ])

    const { focusedBlockId, rects } = await inspectRects(sessionId)
    expect(focusedBlockId).toBe(p1)
    expect(rects.get(unrelated)).toEqual(unrelatedBefore)
    expect(rects.get(p1)![2]).toBeCloseTo(p1BeforeWidth * 0.65, 4)
    expect(rects.get(p2)![2]).toBeCloseTo(p2BeforeWidth * 0.65, 4)
    for (const w of p1Workers) {
      expect(rects.get(w.id)![2]).toBeCloseTo(p1BeforeWidth * 0.35, 4)
      expect(rects.get(w.id)![3]).toBeCloseTo(0.5, 2)
    }
    for (const w of p2Workers) {
      expect(rects.get(w.id)![2]).toBeCloseTo(p2BeforeWidth * 0.35, 4)
      expect(rects.get(w.id)![3]).toBeCloseTo(0.5, 2)
    }
  }, 30000)

  it("re-equalizes after a worker closes and starts fresh after all workers close", async () => {
    const { sessionId, parentId } = await createSession("churn-real")
    const ownedBlocks = new Set<string>()
    const host = { parentId, sessionId }

    const w1 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })
    const w2 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })
    const w3 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })

    await runRex(["block", "close", "-s", sessionId, w2.id])
    const w4 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })
    const afterReplace = (await inspectRects(sessionId)).rects
    expect(afterReplace.get(parentId)![2]).toBeCloseTo(0.65, 4)
    for (const id of [w1.id, w3.id, w4.id]) {
      expect(afterReplace.get(id)![3]).toBeCloseTo(1 / 3, 2)
    }

    for (const id of [w1.id, w3.id, w4.id]) {
      await runRex(["block", "close", "-s", sessionId, id])
    }
    const w5 = await createRexTarget(host, scriptPath, { ownedBlocks, run: runRex })
    const afterReset = (await inspectRects(sessionId)).rects
    expect(afterReset.get(parentId)![2]).toBeCloseTo(0.65, 4)
    expect(afterReset.get(w5.id)![2]).toBeCloseTo(0.35, 4)
    expect(afterReset.get(w5.id)![3]).toBeCloseTo(1, 5)
  }, 30000)

  it("stacks three workers through openTerminal in a scratch Rex session", async () => {
    const { sessionId, parentId } = await createSession("open-terminal-3")
    vi.stubEnv("REX_RUNTIME_DIR", rexDir)
    vi.stubEnv("REX_SERVER", "")
    try {
      const host = { kind: "rex" as const, parentId, sessionId }
      const targets = await Promise.all([
        openTerminal(host, scriptPath, rexDir, "worker 1", "run-1"),
        openTerminal(host, scriptPath, rexDir, "worker 2", "run-2"),
        openTerminal(host, scriptPath, rexDir, "worker 3", "run-3"),
      ])
      const { focusedBlockId, rects } = await inspectRects(sessionId)
      expect(focusedBlockId).toBe(parentId)
      expect(rects.get(parentId)?.[2]).toBeCloseTo(0.65, 4)
      expect(rects.get(parentId)?.[3]).toBeCloseTo(1, 5)
      for (const target of targets) {
        expect(target).toMatchObject({ kind: "rex", sessionId, parentId })
        const rect = rects.get(target.id)!
        expect(rect[0]).toBeCloseTo(0.65, 4)
        expect(rect[2]).toBeCloseTo(0.35, 4)
        expect(rect[3]).toBeCloseTo(1 / 3, 2)
      }
    } finally {
      vi.unstubAllEnvs()
    }
  }, 30000)
})
