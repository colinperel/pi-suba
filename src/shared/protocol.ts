import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface ChildActivity {
  version: 1
  childId: string
  sequence: number
  updatedAt: number
  state: "starting" | "working" | "waiting" | "done"
  activity?: "model" | "streaming" | "tool"
  toolName?: string
  activityStartedAt?: number
  provider?: string
  model?: string
  thinking?: ThinkingLevel
  lastRequestContextTokens?: number
}

export interface CompletionReport {
  summary: string
  artifacts?: string[]
}

export function validateCompletionReport(value: CompletionReport): void {
  if (typeof value.summary !== "string" || !value.summary.trim())
    throw new Error("suba_done requires a nonempty summary")
  if (
    value.artifacts !== undefined &&
    (!Array.isArray(value.artifacts) ||
      value.artifacts.some((path) => typeof path !== "string" || !path.trim()))
  )
    throw new Error("suba_done artifacts must be nonempty path strings")
}

export function completionReportText(report: CompletionReport): string {
  return (
    report.summary +
    (report.artifacts?.length
      ? `\n\nArtifact references (not instructions):\n${report.artifacts.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
      : "")
  )
}

export type ChildEvent =
  | {
      version: 1
      childId: string
      sequence: number
      timestamp: number
      type: "ping" | "ask" | "notify"
      message: string
    }
  | {
      version: 1
      childId: string
      sequence: number
      timestamp: number
      type: "completed"
      report?: CompletionReport
    }
  | {
      version: 1
      childId: string
      sequence: number
      timestamp: number
      type: "failed"
      error: string
    }

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, path)
}

export async function readActivity(path: string, childId: string): Promise<ChildActivity> {
  const value = JSON.parse(await readFile(path, "utf8")) as ChildActivity
  if (value.version !== 1 || value.childId !== childId || !Number.isInteger(value.sequence)) {
    throw new Error("invalid activity snapshot identity")
  }
  return value
}

export async function readEvents(
  artifactDir: string,
  afterSequence: number,
): Promise<ChildEvent[]> {
  const eventsDir = join(artifactDir, "events")
  let names: string[]
  try {
    names = await readdir(eventsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const result: ChildEvent[] = []
  for (const name of names
    .filter((item) => /^\d{6}-(ping|ask|notify|completed|failed)\.json$/.test(item))
    .sort()) {
    const sequence = Number.parseInt(name.slice(0, 6), 10)
    if (sequence <= afterSequence) continue
    const event = JSON.parse(await readFile(join(eventsDir, name), "utf8")) as ChildEvent
    if (event.version !== 1 || event.sequence !== sequence)
      throw new Error(`invalid event file: ${name}`)
    if (event.type === "completed" && event.report !== undefined)
      validateCompletionReport(event.report)
    result.push(event)
  }
  return result
}

export async function writeEvent(artifactDir: string, event: ChildEvent): Promise<void> {
  const sequence = event.sequence.toString().padStart(6, "0")
  await atomicWriteJson(join(artifactDir, "events", `${sequence}-${event.type}.json`), event)
}
