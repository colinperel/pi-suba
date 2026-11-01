import { execFile, spawn, type ChildProcess } from "node:child_process"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { rpcFailurePath, shellQuote } from "./control.ts"
import { atomicWriteJson } from "./protocol.ts"
import { createTarget, PartialTmuxTargetError, tmuxExec } from "./tmux.ts"
export { paneExists as legacyPaneExists } from "./tmux.ts"

const exec = promisify(execFile)
const backgroundProcesses = new Map<string, ChildProcess>()

export type TerminalHost =
  | { kind: "tmux"; parentId: string }
  | { kind: "rex"; parentId: string; sessionId?: string }
  | { kind: "background" }

export type TerminalTarget =
  | { kind: "tmux"; id: string }
  | { kind: "rex"; id: string; sessionId?: string }
  | { kind: "background"; id: string }

export function selectTerminal(env: NodeJS.ProcessEnv = process.env): TerminalHost {
  if (env.TMUX_PANE) return { kind: "tmux", parentId: env.TMUX_PANE }
  if (env.REX_BLOCK) return { kind: "rex", parentId: env.REX_BLOCK, sessionId: env.REX_SESSION }
  return { kind: "background" }
}

export async function checkTerminal(host: TerminalHost): Promise<void> {
  try {
    switch (host.kind) {
      case "tmux":
        await tmuxExec(["-V"])
        break
      case "rex":
        await exec("rex", ["version"])
        break
      case "background":
        break
    }
  } catch (error) {
    throw new Error(
      `Selected ${host.kind} backend is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export class UncertainTerminalLaunchError extends Error {}

const rexScope = (target: { sessionId?: string }): string[] =>
  target.sessionId ? ["-s", target.sessionId] : []

export async function openTerminal(
  host: TerminalHost,
  scriptPath: string,
  artifactDir: string,
  task: string,
  runId: string,
): Promise<TerminalTarget> {
  switch (host.kind) {
    case "tmux": {
      try {
        const target = await createTarget(host.parentId, shellQuote(scriptPath))
        return { kind: "tmux", id: target.paneId }
      } catch (error) {
        if (error instanceof PartialTmuxTargetError)
          throw new UncertainTerminalLaunchError(error.message, { cause: error })
        throw error
      }
    }
    case "rex": {
      try {
        const { stdout } = await exec("rex", [
          "split",
          ...rexScope(host),
          "-b",
          host.parentId,
          "--split=right",
          "--focus=false",
          "--json",
          "--",
          scriptPath,
        ])
        const result = JSON.parse(stdout) as { block_ids?: unknown[] }
        const id = result.block_ids?.[0]
        if (typeof id !== "string" || !id) throw new Error("Rex split returned no block ID")
        return { kind: "rex", id, sessionId: host.sessionId }
      } catch (error) {
        throw new UncertainTerminalLaunchError(
          `Rex launch could not be confirmed: ${error instanceof Error ? error.message : String(error)}. Artifacts and any worktree were preserved; inspect the session before retrying.`,
          { cause: error },
        )
      }
    }
    case "background": {
      const log = await open(join(artifactDir, "process.log"), "a", 0o600)
      try {
        const child = spawn(scriptPath, [], { stdio: ["pipe", "pipe", log.fd] })
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject)
          child.once("spawn", resolve)
        })
        // RPC needs an open stdin for the child's lifetime. Subsequent guidance
        // uses the same inbox as visible children, not terminal input or RPC.
        const id = String(child.pid)
        backgroundProcesses.set(id, child)
        child.once("exit", () => {
          backgroundProcesses.delete(id)
          child.stdin?.end()
        })
        child.stdin!.on("error", () => undefined)
        let failed = false
        const fail = (error: string): void => {
          if (failed) return
          failed = true
          // Keep raw RPC errors in the private log, not parent notifications:
          // provider and extension diagnostics can contain credentials.
          void atomicWriteJson(rpcFailurePath(artifactDir, runId), { error })
            .catch(() => undefined)
            .finally(() => {
              child.stdin?.end()
            })
        }
        const output = log.createWriteStream()
        output.on("error", () => fail("Could not record background Pi output"))
        child.stdout!.setEncoding("utf8")
        let buffer = ""
        child.stdout!.on("data", (chunk: string) => {
          buffer += chunk
          // Pi RPC is LF-only JSONL. Unicode separators remain JSON content.
          let newline: number
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            let message: Record<string, unknown>
            try {
              message = JSON.parse(line) as Record<string, unknown>
            } catch {
              continue
            }
            if (!message || typeof message !== "object") continue
            if (
              message.type === "response" &&
              message.command === "prompt" &&
              message.success === false
            )
              fail("Background Pi rejected its prompt; inspect process.log for diagnostics")
            else if (
              message.type === "extension_error" &&
              (message.event === "command" || message.event === "send_user_message")
            )
              fail("Background Pi extension failed; inspect process.log for diagnostics")
            else if (
              message.type === "extension_ui_request" &&
              typeof message.id === "string" &&
              typeof message.method === "string" &&
              ["select", "confirm", "input", "editor"].includes(message.method)
            )
              child.stdin!.write(
                `${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`,
              )
          }
        })
        child.stdout!.pipe(output)
        child.stdin!.write(`${JSON.stringify({ type: "prompt", message: task })}\n`)
        return { kind: "background", id }
      } catch (error) {
        await log.close()
        throw error
      }
    }
  }
}

// Current visible children exit themselves through the inbox. Only legacy tmux
// panes need a forced close; background RPC needs its owned stdin closed.
export async function closeTerminal(
  target: Extract<TerminalTarget, { kind: "tmux" | "background" }>,
): Promise<void> {
  switch (target.kind) {
    case "tmux":
      await tmuxExec(["kill-pane", "-t", target.id])
      break
    case "background":
      backgroundProcesses.get(target.id)?.stdin?.end()
      break
  }
}
