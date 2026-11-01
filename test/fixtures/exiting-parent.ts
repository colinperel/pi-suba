import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import parentExtension from "../../src/parent/index.ts"
import type { ChildRecord } from "../../src/parent/registry.ts"

type Handler = (event: unknown, ctx: ExtensionContext) => unknown

async function main(): Promise<void> {
  const root = process.argv[2]!
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = []
  const handlers = new Map<string, Handler>()
  const tools = new Map<string, ToolDefinition>()
  let ready!: () => void
  const waiting = new Promise<void>((resolve) => {
    ready = resolve
  })
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler)
    },
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool)
    },
    registerCommand() {},
    registerMessageRenderer() {},
    events: { on: () => () => {}, emit() {} },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data })
    },
    sendMessage: (message: { details?: { state?: string } }) => {
      if (message.details?.state === "awaiting-parent") ready()
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: root,
    hasUI: false,
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => "exiting-parent",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext
  await parentExtension(pi)
  await handlers.get("session_start")!({}, ctx)
  await tools
    .get("suba")!
    .execute(
      "launch",
      { name: "child", task: "/suba-test-wait", profile: "runtime" },
      new AbortController().signal,
      undefined,
      ctx,
    )
  const save = async () => {
    const record = entries.filter((entry) => entry.customType === "suba-child").at(-1)!
      .data as ChildRecord
    await writeFile(join(root, "exiting-parent-record.json"), JSON.stringify(record), {
      mode: 0o600,
    })
  }
  await save()
  await waiting
  await save()
  await handlers.get("session_shutdown")!({}, ctx)
  // Actually drop the stdout reader. Keeping this process alive would only test
  // reload, and would miss Pi's EPIPE/nonzero exit during parent termination.
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : "Parent fixture failed")
  process.exit(1)
})
