import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { atomicWriteJson } from "./protocol.ts"

const exec = promisify(execFile)
const queues = new Map<string, Promise<unknown>>()

type CommandBody = { type: "guidance"; message: string } | { type: "shutdown" }
export type ChildCommand = CommandBody & { version: 1; childId: string; sequence: number }
type Receipt = { sequence: number; error?: string }

function directory(artifactDir: string, runId: string): string {
  if (!/^[a-f0-9]{16}$/.test(runId)) throw new Error("Invalid subagent run identity")
  return join(artifactDir, "control", runId)
}

async function sequences(path: string, suffix: string): Promise<number[]> {
  try {
    return (await readdir(path))
      .filter(
        (name) =>
          name.length === 6 + suffix.length &&
          /^\d{6}$/.test(name.slice(0, 6)) &&
          name.endsWith(suffix),
      )
      .map((name) => Number(name.slice(0, 6)))
      .sort((a, b) => a - b)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export async function writeCommand(
  artifactDir: string,
  runId: string,
  childId: string,
  body: CommandBody,
): Promise<number> {
  const dir = directory(artifactDir, runId)
  const previous = queues.get(dir) ?? Promise.resolve()
  const writing = previous
    .catch(() => undefined)
    .then(async () => {
      const existing = await sequences(dir, ".command.json")
      const sequence = (existing.at(-1) ?? 0) + 1
      if (sequence > 999999) throw new Error("Subagent command sequence exhausted")
      await atomicWriteJson(join(dir, `${String(sequence).padStart(6, "0")}.command.json`), {
        ...body,
        version: 1,
        childId,
        sequence,
      })
      return sequence
    })
  queues.set(dir, writing)
  try {
    return await writing
  } finally {
    if (queues.get(dir) === writing) queues.delete(dir)
  }
}

export async function waitForReceipt(
  artifactDir: string,
  runId: string,
  sequence: number,
  timeoutMs = 10000,
): Promise<void> {
  const path = join(
    directory(artifactDir, runId),
    `${String(sequence).padStart(6, "0")}.receipt.json`,
  )
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const receipt = JSON.parse(await readFile(path, "utf8")) as Receipt
      if (receipt.sequence !== sequence) throw new Error("Invalid subagent command receipt")
      if (receipt.error) throw new Error(receipt.error)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (Date.now() >= deadline)
      throw new Error(
        "Child has not acknowledged the command; processing is not confirmed. Inspect its state before retrying.",
      )
    await delay(25)
  }
}

/** Thrown by a receiver to leave a command, and every later one, for a later poll. */
export class DeferredCommand extends Error {}

export class CommandInbox {
  private pending: Promise<number> = Promise.resolve(0)
  private timer?: NodeJS.Timeout
  private stopped = false
  constructor(
    private readonly artifactDir: string,
    private readonly runId: string,
    private readonly childId: string,
    private readonly receive: (command: ChildCommand) => Promise<void | (() => void)>,
  ) {}

  start(): void {
    this.stopped = false
    this.timer ??= setInterval(
      () =>
        void this.poll().catch((error: unknown) => {
          process.stderr.write(
            `pi-suba inbox: ${error instanceof Error ? error.message : String(error)}\n`,
          )
        }),
      100,
    )
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  poll(): Promise<number> {
    this.pending = this.pending
      .catch(() => 0)
      .then(async () => {
        if (this.stopped) return 0
        const dir = directory(this.artifactDir, this.runId)
        const acknowledged = new Set(await sequences(dir, ".receipt.json"))
        let count = 0
        for (const sequence of await sequences(dir, ".command.json")) {
          if (this.stopped) break
          if (acknowledged.has(sequence)) continue
          const name = String(sequence).padStart(6, "0")
          let receipt: Receipt = { sequence }
          let afterReceipt: void | (() => void) = undefined
          try {
            const command = JSON.parse(
              await readFile(join(dir, `${name}.command.json`), "utf8"),
            ) as ChildCommand
            if (
              command.version !== 1 ||
              command.childId !== this.childId ||
              command.sequence !== sequence ||
              (command.type !== "guidance" && command.type !== "shutdown") ||
              (command.type === "guidance" && typeof command.message !== "string")
            )
              throw new Error("Invalid subagent command")
            afterReceipt = await this.receive(command)
          } catch (error) {
            if (error instanceof DeferredCommand) break
            receipt = { sequence, error: error instanceof Error ? error.message : String(error) }
          }
          await atomicWriteJson(join(dir, `${name}.receipt.json`), receipt)
          count += 1
          afterReceipt?.()
        }
        return count
      })
    return this.pending
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function launchScriptPath(artifactDir: string, runId: string): string {
  directory(artifactDir, runId)
  return join(artifactDir, `launch-${runId}.sh`)
}

export function rpcFailurePath(artifactDir: string, runId: string): string {
  directory(artifactDir, runId)
  return join(artifactDir, `rpc-error-${runId}.json`)
}

export function parentTeardownPath(artifactDir: string, runId: string): string {
  directory(artifactDir, runId)
  return join(artifactDir, `parent-teardown-${runId}.json`)
}

export async function processExists(
  artifactDir: string,
  runId: string,
): Promise<boolean | undefined> {
  let pid: number
  try {
    pid = Number((await readFile(join(artifactDir, "process-pid"), "utf8")).trim())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid subagent process PID")
  try {
    const { stdout } = await exec("ps", ["-ww", "-p", String(pid), "-o", "args="])
    // The ASCII run basename survives ps locale escaping of non-ASCII paths
    // while still distinguishing reused PIDs after a parent restart.
    return stdout.includes(basename(launchScriptPath(artifactDir, runId)))
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false
    throw error
  }
}
