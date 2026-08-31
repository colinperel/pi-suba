import { spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"

const MAX_STDOUT = 1024 * 1024
const STDERR_TAIL = 64 * 1024

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

interface ProcessOutput {
  stdout: string
  stderr: string
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString()
  return next.length <= STDERR_TAIL ? next : next.slice(-STDERR_TAIL)
}

function runWorkmux(
  args: string[],
  cwd: string,
  options: { signal?: AbortSignal; streamStderr?: boolean } = {},
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("workmux", args, {
      cwd,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let outputError: Error | undefined
    let settled = false
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputError) return
      stdout += chunk.toString()
      if (Buffer.byteLength(stdout) > MAX_STDOUT) {
        outputError = Object.assign(
          new Error("workmux stdout exceeded the headless receipt limit"),
          { code: "SUBA_OUTPUT_LIMIT" },
        )
        child.kill()
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk)
      if (options.streamStderr) process.stderr.write(chunk)
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      Object.assign(error, { stdout, stderr })
      reject(error)
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      if (outputError) {
        Object.assign(outputError, { stdout, stderr })
        reject(outputError)
      } else if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const error = new Error(
          `workmux exited ${code ?? `after signal ${signal ?? "unknown"}`}`,
        ) as Error & { code?: number; stdout?: string; stderr?: string }
        error.code = code ?? undefined
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      }
    })
  })
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

function unsupportedContract(stderr: string): boolean {
  return stderr
    .split("\n")
    .some((line) =>
      /(?:unexpected|unrecognized|unknown).*(?:--headless|--json)|(?:--headless|--json).*(?:unexpected|unrecognized|unknown)/i.test(
        line,
      ),
    )
}

function isAbort(error: unknown): boolean {
  return (error instanceof Error && error.name === "AbortError") || errorCode(error) === "ABORT_ERR"
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

async function removeWorktreeHandle(handle: string, sourceCwd: string): Promise<void> {
  try {
    await runWorkmux(["remove", "--force", handle], sourceCwd)
  } catch (error) {
    const stderr = errorText(error, "stderr")
    throw new Error(`workmux remove --force ${handle} failed${stderr ? `:\n${tail(stderr)}` : ""}`)
  }
}

async function rollbackHandle(handle: string, sourceCwd: string, error: unknown): Promise<never> {
  const original = error instanceof Error ? error : new Error(String(error))
  try {
    await removeWorktreeHandle(handle, sourceCwd)
  } catch (rollbackError) {
    throw new AggregateError(
      [original, rollbackError],
      `Worktree provisioning failed after workmux created ${handle}. Run 'workmux remove --force ${handle}' from ${sourceCwd}.`,
    )
  }
  throw original
}

export async function provisionWorktree(
  name: string,
  childId: string,
  sourceCwd: string,
  signal?: AbortSignal,
): Promise<WorkmuxWorktree> {
  const handle = worktreeHandle(name, childId)
  let output: ProcessOutput
  try {
    output = await runWorkmux(
      ["add", handle, "--name", handle, "--headless", "--json"],
      sourceCwd,
      { signal, streamStderr: true },
    )
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      throw new Error("pi-suba requires workmux on PATH when worktree: true")
    const stderr = errorText(error, "stderr")
    if (errorCode(error) === "SUBA_OUTPUT_LIMIT") return rollbackHandle(handle, sourceCwd, error)
    if (unsupportedContract(stderr))
      throw new Error(
        `The workmux on PATH does not support 'workmux add --headless --json'. Upgrade workmux.\n${tail(stderr)}`,
      )
    if (isAbort(error)) {
      try {
        await removeWorktreeHandle(handle, sourceCwd)
      } catch (rollbackError) {
        const missing =
          rollbackError instanceof Error && /worktree .* not found/i.test(rollbackError.message)
        if (!missing)
          throw new AggregateError(
            [error, rollbackError],
            `Worktree provisioning was canceled and rollback failed for ${handle}`,
          )
      }
      throw error
    }
    throw new Error(`workmux could not provision ${handle}${stderr ? `:\n${tail(stderr)}` : ""}`)
  }

  let receipt: WorkmuxWorktree
  try {
    receipt = parseHeadlessReceipt(output.stdout, output.stderr, sourceCwd, handle)
    await validateStoredWorktree(receipt)
  } catch (error) {
    return rollbackHandle(handle, sourceCwd, error)
  }
  return receipt
}

export async function validateStoredWorktree(worktree: WorkmuxWorktree): Promise<void> {
  if (!isAbsolute(worktree.worktreePath) || !isAbsolute(worktree.workingDirectory))
    throw new Error(`Subagent worktree paths must be absolute: ${worktree.handle}`)
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
  const [canonicalRoot, canonicalWorkingDirectory] = await Promise.all([
    realpath(worktree.worktreePath),
    realpath(worktree.workingDirectory),
  ])
  if (!isWithin(canonicalRoot, canonicalWorkingDirectory))
    throw new Error(`Subagent working directory is outside its worktree: ${worktree.handle}`)
}

export async function removeWorktree(worktree: WorkmuxWorktree): Promise<void> {
  await removeWorktreeHandle(worktree.handle, worktree.sourceCwd)
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
