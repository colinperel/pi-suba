import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 10 * 1024 * 1024

export interface WorkmuxWorktree {
  handle: string
  branch: string
  sourceCwd: string
  worktreePath: string
  workingDirectory: string
}

interface HeadlessReceipt {
  schema_version: number
  handle: string
  branch: string
  worktree_path: string
  working_directory: string
}

function errorText(error: unknown, key: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(key in error)) return ""
  const value = (error as Record<string, unknown>)[key]
  return typeof value === "string" ? value.trim() : Buffer.isBuffer(value) ? value.toString() : ""
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined
}

function tail(value: string, limit = 2000): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
}

function receiptError(message: string, stdout: string, stderr: string): Error {
  const context = [
    stdout ? `stdout: ${tail(stdout, 300)}` : undefined,
    stderr ? `stderr: ${tail(stderr)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
  return new Error(`${message}${context ? `\n${context}` : ""}`)
}

export function worktreeHandle(name: string, childId: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
  return `suba-${slug || "agent"}-${childId}`
}

export function parseHeadlessReceipt(
  stdout: string,
  stderr: string,
  sourceCwd: string,
  expectedHandle: string,
): WorkmuxWorktree {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw receiptError("workmux returned invalid JSON for headless provisioning", stdout, stderr)
  }
  if (!raw || typeof raw !== "object")
    throw receiptError("workmux returned an invalid headless provisioning receipt", stdout, stderr)
  const receipt = raw as Partial<HeadlessReceipt>
  if (receipt.schema_version !== 1)
    throw receiptError(
      `Unsupported workmux headless receipt schema: ${String(receipt.schema_version)}`,
      stdout,
      stderr,
    )
  const {
    handle,
    branch,
    worktree_path: worktreePath,
    working_directory: workingDirectory,
  } = receipt
  if (!handle || !branch || !worktreePath || !workingDirectory)
    throw receiptError("workmux receipt is missing required fields", stdout, stderr)
  if (handle !== expectedHandle || branch !== expectedHandle)
    throw receiptError(
      `workmux provisioned '${handle}' on branch '${branch}', expected '${expectedHandle}'`,
      stdout,
      stderr,
    )
  if (!isAbsolute(worktreePath) || !isAbsolute(workingDirectory))
    throw receiptError("workmux receipt paths must be absolute", stdout, stderr)
  if (!isWithin(worktreePath, workingDirectory))
    throw receiptError(
      "workmux working directory is outside the provisioned worktree",
      stdout,
      stderr,
    )
  return { handle, branch, sourceCwd, worktreePath, workingDirectory }
}

export async function provisionWorktree(
  name: string,
  childId: string,
  sourceCwd: string,
  signal?: AbortSignal,
): Promise<WorkmuxWorktree> {
  const handle = worktreeHandle(name, childId)
  try {
    const { stdout, stderr } = await execFileAsync(
      "workmux",
      ["add", handle, "--name", handle, "--headless", "--json"],
      { cwd: sourceCwd, maxBuffer: MAX_OUTPUT, signal },
    )
    const receipt = parseHeadlessReceipt(stdout, stderr, sourceCwd, handle)
    await validateStoredWorktree(receipt)
    return receipt
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      throw new Error("pi-suba requires workmux on PATH when worktree: true")
    const stderr = errorText(error, "stderr")
    if (
      /(?:unexpected|unrecognized|unknown).*(?:--headless|--json)|(?:--headless|--json).*(?:unexpected|unrecognized|unknown)/is.test(
        stderr,
      )
    ) {
      throw new Error(
        `The workmux on PATH does not support 'workmux add --headless --json'. Upgrade workmux.\n${tail(stderr)}`,
      )
    }
    if (error instanceof Error && !stderr) throw error
    throw new Error(`workmux could not provision ${handle}${stderr ? `:\n${tail(stderr)}` : ""}`)
  }
}

export async function validateStoredWorktree(worktree: WorkmuxWorktree): Promise<void> {
  if (!isAbsolute(worktree.worktreePath) || !isAbsolute(worktree.workingDirectory))
    throw new Error(`Subagent worktree paths must be absolute: ${worktree.handle}`)
  if (!isWithin(worktree.worktreePath, worktree.workingDirectory))
    throw new Error(`Subagent working directory is outside its worktree: ${worktree.handle}`)
  for (const path of [worktree.worktreePath, worktree.workingDirectory]) {
    try {
      const metadata = await stat(path)
      if (!metadata.isDirectory()) throw new Error("path is not a directory")
    } catch (error) {
      throw new Error(
        `Subagent worktree is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export async function removeWorktree(worktree: WorkmuxWorktree): Promise<void> {
  try {
    await execFileAsync("workmux", ["remove", "--force", worktree.handle], {
      cwd: worktree.sourceCwd,
      maxBuffer: MAX_OUTPUT,
    })
  } catch (error) {
    const stderr = errorText(error, "stderr")
    throw new Error(
      `workmux remove --force ${worktree.handle} failed${stderr ? `:\n${tail(stderr)}` : ""}`,
    )
  }
}

export async function rollbackWorktree(
  worktree: WorkmuxWorktree,
  launchError: unknown,
): Promise<never> {
  const original = launchError instanceof Error ? launchError : new Error(String(launchError))
  try {
    await removeWorktree(worktree)
  } catch (rollbackError) {
    throw new AggregateError(
      [original, rollbackError],
      `Subagent launch failed and worktree rollback failed for ${worktree.handle}. Run 'workmux remove --force ${worktree.handle}' from ${worktree.sourceCwd}.`,
    )
  }
  throw original
}
