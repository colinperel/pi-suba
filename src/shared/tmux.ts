import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)

export interface TmuxTarget {
  paneId: string
}
export type TmuxExec = (args: string[]) => Promise<string>

export const tmuxExec: TmuxExec = async (args) => (await execFileAsync("tmux", args)).stdout.trim()

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

async function equalizeSplitHeights(
  windowId: string,
  parentPane: string,
  run: TmuxExec,
): Promise<void> {
  const panes = await run([
    "list-panes",
    "-t",
    windowId,
    "-F",
    "#{pane_id}\t#{pane_top}\t#{pane_height}\t#{@suba-parent-pane}",
  ])
  const children = panes
    .split("\n")
    .flatMap((line) => {
      const [paneId, top, height, owner] = line.split("\t")
      return paneId && owner === parentPane
        ? [{ paneId, top: Number(top), height: Number(height) }]
        : []
    })
    .sort((left, right) => left.top - right.top)
  if (children.length < 2) return
  const height = Math.floor(
    children.reduce((total, child) => total + child.height, 0) / children.length,
  )
  for (const child of children.slice(0, -1))
    await run(["resize-pane", "-t", child.paneId, "-y", String(height)])
}

export class PartialTmuxTargetError extends AggregateError {
  readonly paneId: string

  constructor(paneId: string, targetError: Error, cleanupError: unknown) {
    super(
      [targetError, cleanupError],
      `Could not configure or remove partial tmux target ${paneId}`,
    )
    this.name = "PartialTmuxTargetError"
    this.paneId = paneId
  }
}

async function rollbackTargetPane(
  paneId: string,
  targetError: unknown,
  run: TmuxExec,
): Promise<never> {
  const original = targetError instanceof Error ? targetError : new Error(String(targetError))
  try {
    await run(["kill-pane", "-t", paneId])
  } catch (cleanupError) {
    throw new PartialTmuxTargetError(paneId, original, cleanupError)
  }
  throw original
}

export async function createTarget(
  parentPane: string,
  command: string,
  run = tmuxExec,
): Promise<TmuxTarget> {
  return withQueue(async () => {
    const windowId = await run(["display-message", "-p", "-t", parentPane, "#{window_id}"])
    const panes = await run([
      "list-panes",
      "-t",
      windowId,
      "-F",
      "#{pane_id}\t#{pane_top}\t#{@suba-parent-pane}",
    ])
    const children = panes.split("\n").flatMap((line) => {
      const [paneId, top, owner] = line.split("\t")
      return paneId && owner === parentPane ? [{ paneId, top: Number(top) }] : []
    })
    const bottom = children.reduce<{ paneId: string; top: number } | undefined>(
      (candidate, pane) => (!candidate || pane.top > candidate.top ? pane : candidate),
      undefined,
    )
    const paneId = await run([
      "split-window",
      bottom ? "-v" : "-h",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      bottom?.paneId ?? parentPane,
      command,
    ])
    try {
      await run(["set-option", "-p", "-t", paneId, "@suba-parent-pane", parentPane])
      await equalizeSplitHeights(windowId, parentPane, run)
      return { paneId }
    } catch (error) {
      return rollbackTargetPane(paneId, error, run)
    }
  })
}

export async function paneExists(paneId: string, run = tmuxExec): Promise<boolean> {
  try {
    return (await run(["display-message", "-p", "-t", paneId, "#{pane_id}"])) === paneId
  } catch {
    return false
  }
}
