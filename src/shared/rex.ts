import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const REX_FIRST_WORKER_RATIO = 35
const REX_STACK_RATIO = 50
const RATIO_EPSILON = 1e-6

export interface RexHost {
  parentId: string
  sessionId?: string
}

export interface RexTarget {
  id: string
  sessionId?: string
}

export class UncertainRexLaunchError extends Error {}
class MissingRexAnchorError extends Error {}

export type RexExec = (args: string[]) => Promise<string>

export const rexExec: RexExec = async (args) => (await execFileAsync("rex", args)).stdout

export interface RexLayoutSplit {
  split_id?: string | null
  direction: "horizontal" | "vertical"
  ratio: number
  before: RexLayoutNode
  after: RexLayoutNode
}

export interface RexLayoutNode {
  rect: [number, number, number, number]
  block_id?: string | null
  split?: RexLayoutSplit | null
}

export interface RexSessionView {
  session_id?: string | null
  windows?: Array<{
    window_id?: string | null
    focused_block_id?: string | null
    layers?: Array<{
      layer_id?: string | null
      layout?: RexLayoutNode | null
    }> | null
  }> | null
}

export interface RexResizeStep {
  beforeBlockId: string
  afterBlockId: string
  ratio: number
}

export interface CreateRexTargetOptions {
  knownChildren?: Iterable<string>
  ownedBlocks?: Set<string>
  run?: RexExec
}

const ownedByParent = new Map<string, Set<string>>()
let splitQueue = Promise.resolve()

async function withQueue<T>(action: () => Promise<T>): Promise<T> {
  const previous = splitQueue
  let release = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  splitQueue = next
  await previous
  try {
    return await action()
  } finally {
    release()
  }
}

function parentKey(host: RexHost): string {
  return `${host.sessionId ?? ""}\0${host.parentId}`
}

function rexScope(sessionId?: string): string[] {
  return sessionId ? ["-s", sessionId] : []
}

function ownedSetFor(host: RexHost, override?: Set<string>): Set<string> {
  if (override) return override
  const key = parentKey(host)
  let set = ownedByParent.get(key)
  if (!set) {
    set = new Set<string>()
    ownedByParent.set(key, set)
  }
  return set
}

function collectBlockIds(node: RexLayoutNode, into: Set<string>): void {
  if (node.block_id) {
    into.add(node.block_id)
    return
  }
  if (!node.split) return
  collectBlockIds(node.split.before, into)
  collectBlockIds(node.split.after, into)
}

function collectSessionBlockIds(view: RexSessionView): Set<string> {
  const ids = new Set<string>()
  for (const window of view.windows ?? []) {
    for (const layer of window.layers ?? []) {
      if (layer.layout) collectBlockIds(layer.layout, ids)
    }
  }
  return ids
}

function findPathToBlock(
  node: RexLayoutNode,
  blockId: string,
): Array<{ split: RexLayoutSplit; side: "before" | "after" }> | undefined {
  if (node.block_id === blockId) return []
  if (!node.split) return undefined
  const beforePath = findPathToBlock(node.split.before, blockId)
  if (beforePath) return [{ split: node.split, side: "before" }, ...beforePath]
  const afterPath = findPathToBlock(node.split.after, blockId)
  if (afterPath) return [{ split: node.split, side: "after" }, ...afterPath]
  return undefined
}

function findParentLayout(view: RexSessionView, parentId: string): RexLayoutNode | undefined {
  for (const window of view.windows ?? []) {
    for (const layer of window.layers ?? []) {
      if (layer.layout && findPathToBlock(layer.layout, parentId)) return layer.layout
    }
  }
  return undefined
}

interface PositionedWorker {
  blockId: string
  rect: [number, number, number, number]
}

interface VerticalGroup {
  height: number
  workers: PositionedWorker[]
  bottomWorker: PositionedWorker
}

function compareWorkerPosition(left: PositionedWorker, right: PositionedWorker): number {
  return left.rect[1] - right.rect[1] || left.rect[0] - right.rect[0]
}

function analyzeColumnGroups(
  node: RexLayoutNode,
  ownedIds: ReadonlySet<string>,
): { allOwned: boolean; workers: PositionedWorker[]; groups: VerticalGroup[] } {
  if (node.block_id) {
    if (!ownedIds.has(node.block_id)) return { allOwned: false, workers: [], groups: [] }
    const worker: PositionedWorker = { blockId: node.block_id, rect: node.rect }
    return {
      allOwned: true,
      workers: [worker],
      groups: [{ height: node.rect[3], workers: [worker], bottomWorker: worker }],
    }
  }
  if (!node.split) return { allOwned: false, workers: [], groups: [] }
  const before = analyzeColumnGroups(node.split.before, ownedIds)
  const after = analyzeColumnGroups(node.split.after, ownedIds)
  const workers = [...before.workers, ...after.workers]
  if (
    node.split.direction === "vertical" &&
    before.allOwned &&
    after.allOwned &&
    before.workers.length > 0 &&
    after.workers.length > 0
  ) {
    const sorted = [...workers].sort(compareWorkerPosition)
    return {
      allOwned: true,
      workers: sorted,
      groups: [{ height: node.rect[3], workers: sorted, bottomWorker: sorted.at(-1)! }],
    }
  }
  return {
    allOwned: false,
    workers,
    groups: [...before.groups, ...after.groups],
  }
}

function selectColumnAnchor(groups: readonly VerticalGroup[]): PositionedWorker | undefined {
  let best: VerticalGroup | undefined
  let bestProjectedHeight = -1
  for (const group of groups) {
    const projectedHeight = group.height / (group.workers.length + 1)
    if (
      !best ||
      projectedHeight > bestProjectedHeight + RATIO_EPSILON ||
      (Math.abs(projectedHeight - bestProjectedHeight) <= RATIO_EPSILON &&
        compareWorkerPosition(group.bottomWorker, best.bottomWorker) > 0)
    ) {
      best = group
      bestProjectedHeight = projectedHeight
    }
  }
  return best?.bottomWorker
}

export function findRightColumn(
  layout: RexLayoutNode,
  parentId: string,
  ownedIds: ReadonlySet<string>,
):
  | { columnRoot: RexLayoutNode; workers: PositionedWorker[]; anchor: PositionedWorker }
  | undefined {
  const path = findPathToBlock(layout, parentId)
  if (!path) return undefined
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const step = path[i]!
    if (step.split.direction !== "horizontal" || step.side !== "before") continue
    const analysis = analyzeColumnGroups(step.split.after, ownedIds)
    const anchor = selectColumnAnchor(analysis.groups)
    if (analysis.workers.length > 0 && anchor) {
      const workers = [...analysis.workers].sort(compareWorkerPosition)
      return { columnRoot: step.split.after, workers, anchor }
    }
  }
  return undefined
}

interface EqualizeInfo {
  allOwned: boolean
  leafCount: number
  firstBlockId?: string
  lastBlockId?: string
  steps: RexResizeStep[]
}

export function planVerticalEqualization(
  columnRoot: RexLayoutNode,
  ownedIds: ReadonlySet<string>,
): RexResizeStep[] {
  const visit = (node: RexLayoutNode): EqualizeInfo => {
    if (node.block_id) {
      return {
        allOwned: ownedIds.has(node.block_id),
        leafCount: 1,
        firstBlockId: node.block_id,
        lastBlockId: node.block_id,
        steps: [],
      }
    }
    if (!node.split) return { allOwned: false, leafCount: 0, steps: [] }
    const before = visit(node.split.before)
    const after = visit(node.split.after)
    const steps: RexResizeStep[] = []
    if (
      node.split.direction === "vertical" &&
      before.allOwned &&
      after.allOwned &&
      before.leafCount > 0 &&
      after.leafCount > 0 &&
      before.lastBlockId &&
      after.firstBlockId
    ) {
      const total = before.leafCount + after.leafCount
      const desiredRatio = before.leafCount / total
      if (Math.abs(node.split.ratio - desiredRatio) > RATIO_EPSILON) {
        steps.push({
          beforeBlockId: before.lastBlockId,
          afterBlockId: after.firstBlockId,
          ratio: desiredRatio,
        })
      }
      steps.push(...before.steps, ...after.steps)
      return {
        allOwned: true,
        leafCount: total,
        firstBlockId: before.firstBlockId,
        lastBlockId: after.lastBlockId,
        steps,
      }
    }
    steps.push(...before.steps, ...after.steps)
    return {
      allOwned: false,
      leafCount: before.leafCount + after.leafCount,
      firstBlockId: before.firstBlockId ?? after.firstBlockId,
      lastBlockId: after.lastBlockId ?? before.lastBlockId,
      steps,
    }
  }

  return visit(columnRoot).steps
}

async function resolveSessionId(host: RexHost, run: RexExec): Promise<string | undefined> {
  if (host.sessionId) return host.sessionId
  const stdout = await run(["block", "inspect", host.parentId, "--json"])
  const parsed = JSON.parse(stdout) as { session_id?: unknown }
  return typeof parsed.session_id === "string" && parsed.session_id ? parsed.session_id : undefined
}

async function inspectSession(sessionId: string, run: RexExec): Promise<RexSessionView> {
  const stdout = await run(["session", "inspect", sessionId, "--json"])
  return JSON.parse(stdout) as RexSessionView
}

function diagnosticLines(error: unknown): string[] {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const text =
      typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : ""
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }
  return error instanceof Error
    ? error.message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : []
}

function isExplicitMissingAnchorError(error: unknown, anchorId: string): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "killed" in error &&
    Boolean((error as { killed?: unknown }).killed)
  ) {
    return false
  }
  const lines = diagnosticLines(error)
  if (lines.length === 0) return false
  const exactRexNotFound = `error: block target "${anchorId.toLowerCase()}" not found`
  const exactLegacyNotFound = `no such block: ${anchorId.toLowerCase()}`
  return lines.some((line) => {
    const normalized = line.toLowerCase()
    return normalized === exactRexNotFound || normalized === exactLegacyNotFound
  })
}

async function splitBlock(
  sessionId: string | undefined,
  anchorId: string,
  direction: "right" | "below",
  ratio: number,
  scriptPath: string,
  run: RexExec,
  allowMissingAnchor = false,
): Promise<string> {
  let stdout: string
  try {
    stdout = await run([
      "split",
      ...rexScope(sessionId),
      "-b",
      anchorId,
      `--split=${direction}`,
      `--ratio=${ratio}`,
      "--focus=false",
      "--json",
      "--",
      scriptPath,
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (allowMissingAnchor && isExplicitMissingAnchorError(error, anchorId)) {
      throw new MissingRexAnchorError(message, { cause: error })
    }
    throw new UncertainRexLaunchError(message, { cause: error })
  }
  try {
    const result = JSON.parse(stdout) as { block_ids?: unknown[] }
    const id = result.block_ids?.[0]
    if (typeof id !== "string" || !id) throw new Error("Rex split returned no block ID")
    return id
  } catch (error) {
    throw new UncertainRexLaunchError(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
}

async function equalizeRightColumn(
  sessionId: string,
  parentId: string,
  ownedIds: ReadonlySet<string>,
  run: RexExec,
): Promise<void> {
  const maxSteps = Math.max(1, ownedIds.size)
  let retriesLeft = 1
  let lastStepKey: string | undefined
  for (let iteration = 0; iteration < maxSteps; iteration += 1) {
    try {
      const view = await inspectSession(sessionId, run)
      const layout = findParentLayout(view, parentId)
      if (!layout) return
      const column = findRightColumn(layout, parentId, ownedIds)
      if (!column || column.workers.length < 2) return
      const steps = planVerticalEqualization(column.columnRoot, ownedIds)
      const step = steps[0]
      if (!step) return
      const stepKey = `${step.beforeBlockId}\0${step.afterBlockId}\0${step.ratio}`
      if (stepKey === lastStepKey) return
      lastStepKey = stepKey
      await run([
        "api",
        "call",
        ...rexScope(sessionId),
        "session.resize_pane",
        JSON.stringify({
          direction: "vertical",
          before_block_id: step.beforeBlockId,
          after_block_id: step.afterBlockId,
          ratio: step.ratio,
        }),
      ])
      if (steps.length === 1) return
    } catch {
      // Best-effort layout equalization: the worker split is already live.
      // Retry once in case a sibling exited mid-equalization, then keep going.
      if (retriesLeft === 0) return
      retriesLeft -= 1
      lastStepKey = undefined
    }
  }
}

export async function createRexTarget(
  host: RexHost,
  scriptPath: string,
  options: CreateRexTargetOptions = {},
): Promise<RexTarget> {
  const run = options.run ?? rexExec
  return withQueue(async () => {
    const owned = ownedSetFor(host, options.ownedBlocks)
    const candidates = new Set(owned)
    if (options.knownChildren) {
      for (const childId of options.knownChildren) {
        if (childId && childId !== host.parentId) candidates.add(childId)
      }
    }

    if (candidates.size === 0) {
      const id = await splitBlock(
        host.sessionId,
        host.parentId,
        "right",
        REX_FIRST_WORKER_RATIO,
        scriptPath,
        run,
      )
      owned.add(id)
      return { id, sessionId: host.sessionId }
    }

    const sessionId = await resolveSessionId(host, run)
    if (!sessionId) {
      const id = await splitBlock(
        host.sessionId,
        host.parentId,
        "right",
        REX_FIRST_WORKER_RATIO,
        scriptPath,
        run,
      )
      owned.add(id)
      return { id, sessionId: host.sessionId }
    }

    let view = await inspectSession(sessionId, run)
    const maxAttempts = candidates.size + 1
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const liveIds = collectSessionBlockIds(view)
      for (const id of owned) {
        if (!liveIds.has(id)) owned.delete(id)
      }
      for (const id of candidates) {
        if (!liveIds.has(id)) candidates.delete(id)
      }

      const layout = findParentLayout(view, host.parentId)
      const column = layout ? findRightColumn(layout, host.parentId, candidates) : undefined
      if (column) {
        for (const worker of column.workers) owned.add(worker.blockId)
      }
      const anchor = column?.anchor

      if (!anchor) {
        const id = await splitBlock(
          sessionId,
          host.parentId,
          "right",
          REX_FIRST_WORKER_RATIO,
          scriptPath,
          run,
        )
        owned.add(id)
        return { id, sessionId }
      }

      try {
        const id = await splitBlock(
          sessionId,
          anchor.blockId,
          "below",
          REX_STACK_RATIO,
          scriptPath,
          run,
          true,
        )
        owned.add(id)
        candidates.add(id)
        if (column!.workers.length >= 2) {
          await equalizeRightColumn(sessionId, host.parentId, candidates, run)
        }
        return { id, sessionId }
      } catch (error) {
        if (!(error instanceof MissingRexAnchorError)) throw error
        let freshView: RexSessionView
        try {
          freshView = await inspectSession(sessionId, run)
        } catch {
          throw new UncertainRexLaunchError(error.message, { cause: error })
        }
        const freshIds = collectSessionBlockIds(freshView)
        if (freshIds.has(anchor.blockId)) {
          throw new UncertainRexLaunchError(error.message, { cause: error })
        }
        owned.delete(anchor.blockId)
        candidates.delete(anchor.blockId)
        view = freshView
      }
    }

    throw new Error("Could not find a live Rex anchor block for subagent split")
  })
}
