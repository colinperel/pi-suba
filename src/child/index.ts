import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { latestRequestContextTokens, requestContextTokens } from "../shared/context-tokens.ts"
import {
  validateCompletionReport,
  type CompletionReport,
  type ThinkingLevel,
} from "../shared/protocol.ts"
import { ActivityRecorder } from "./activity.ts"
import { EventWriter } from "./events.ts"

type Lifecycle = "running" | "awaiting-parent" | "completing" | "terminated"
type AssistantState = { stopReason?: string; errorMessage?: string }

export default function (pi: ExtensionAPI) {
  const childId = process.env.SUBA_CHILD_ID
  const artifactDir = process.env.SUBA_ARTIFACT_DIR
  if (!childId || !artifactDir)
    throw new Error("pi-suba child extension requires SUBA_CHILD_ID and SUBA_ARTIFACT_DIR")
  const automatic = process.env.SUBA_AUTO_COMPLETE !== "0"
  const activity = new ActivityRecorder(childId, artifactDir)
  const events = new EventWriter(childId, artifactDir)
  let lifecycle: Lifecycle = "running"

  const latestAssistant = (ctx: ExtensionContext): AssistantState | undefined => {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type?: string
      message?: AssistantState & { role?: string }
    }>
    for (let index = branch.length - 1; index >= 0; index--) {
      const message = branch[index]?.message
      if (branch[index]?.type === "message" && message?.role === "assistant") return message
    }
    return undefined
  }
  const latestAssistantError = (ctx: ExtensionContext): string | undefined => {
    const message = latestAssistant(ctx)
    return message?.stopReason === "error"
      ? message.errorMessage || "provider request failed"
      : undefined
  }
  const latestAssistantWasAborted = (ctx: ExtensionContext): boolean => {
    const message = latestAssistant(ctx)
    return (
      message?.stopReason === "aborted" ||
      (message?.stopReason === "error" &&
        /\boperation was aborted\b/i.test(message.errorMessage ?? ""))
    )
  }
  const finish = async (ctx: ExtensionContext, report?: CompletionReport): Promise<boolean> => {
    if (lifecycle !== "running") return false
    lifecycle = "completing"
    try {
      const error = report ? undefined : latestAssistantError(ctx)
      if (error) await events.failed(error)
      else await events.completed(report)
    } catch (error) {
      lifecycle = "running"
      throw error
    }
    await activity.done().catch(() => undefined)
    lifecycle = "terminated"
    ctx.shutdown()
    return true
  }

  pi.registerTool({
    name: "suba_done",
    label: "Suba Done",
    description:
      "Finish immediately with the supplied nonempty summary and optional artifact path references. No preceding assistant prose is needed. Artifacts are not read or executed; completion does not mean parent acceptance.",
    parameters: Type.Object({
      summary: Type.String({
        minLength: 1,
        pattern: "\\S",
        description: "Final report delivered verbatim to the parent",
      }),
      artifacts: Type.Optional(
        Type.Array(Type.String({ minLength: 1, pattern: "\\S" }), {
          description:
            "Artifact path references, relative to the child working directory or absolute. Contents are not ingested.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      validateCompletionReport(params)
      if (!(await finish(ctx, params)))
        throw new Error(`suba_done is unavailable while lifecycle is ${lifecycle}`)
      return {
        content: [{ type: "text", text: "Subagent completion recorded. Shutting down." }],
        details: params,
        terminate: true,
      }
    },
  })
  pi.registerTool({
    name: "suba_notify",
    label: "Suba Notify",
    description:
      "Send the parent a progress update or finding and continue working. No response is required. Use suba_ask instead only when blocked on parent guidance.",
    parameters: Type.Object({
      message: Type.String({ description: "Progress update or finding" }),
    }),
    async execute(_id, params) {
      if (lifecycle !== "running")
        throw new Error(`suba_notify is unavailable while lifecycle is ${lifecycle}`)
      await events.notify(params.message)
      return {
        content: [
          {
            type: "text",
            text: "Parent notified. Continue your assigned work; no acknowledgement is required.",
          },
        ],
        details: {},
      }
    },
  })
  pi.registerTool({
    name: "suba_ask",
    label: "Suba Ask",
    description:
      "Ask the parent for a decision or missing information only when blocked. The current run stops until guidance arrives. For progress updates, use suba_notify instead.",
    parameters: Type.Object({
      message: Type.String({ description: "Question or requested parent action" }),
    }),
    async execute(_id, params) {
      if (lifecycle !== "running")
        throw new Error(`suba_ask is unavailable while lifecycle is ${lifecycle}`)
      lifecycle = "awaiting-parent"
      await events.ask(params.message)
      await activity.waiting()
      return {
        content: [{ type: "text", text: "Parent guidance requested. Waiting for input." }],
        details: {},
        terminate: true,
      }
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    await events.initialize()
    await activity.update({
      lastRequestContextTokens: latestRequestContextTokens(ctx.sessionManager.getBranch()),
    })
    await activity.starting()
    if (ctx.model) await activity.selected(ctx.model.provider, ctx.model.id)
    await activity.thinking(ctx.thinkingLevel as ThinkingLevel)
  })
  pi.on("input", async () => {
    if (lifecycle === "awaiting-parent") {
      lifecycle = "running"
      await activity.model()
    }
  })
  const working = (update: () => Promise<void>) => {
    if (lifecycle === "running") return update()
  }
  pi.on("agent_start", () => working(() => activity.model()))
  pi.on("turn_start", () => working(() => activity.model()))
  pi.on("before_provider_request", () => working(() => activity.model()))
  pi.on("message_end", async (event) => {
    const tokens = requestContextTokens(event.message)
    if (tokens !== undefined) await activity.update({ lastRequestContextTokens: tokens })
  })
  pi.on("message_update", () => working(() => activity.streaming()))
  pi.on("tool_execution_start", (event) => working(() => activity.tool(event.toolName)))
  pi.on("tool_execution_update", (event) => working(() => activity.tool(event.toolName)))
  pi.on("tool_execution_end", () => working(() => activity.model()))
  pi.on("model_select", (event) => activity.selected(event.model.provider, event.model.id))
  pi.on("thinking_level_select", (event) => activity.thinking(event.level as ThinkingLevel))
  pi.on("agent_settled", async (_event, ctx) => {
    if (lifecycle !== "running") return
    if (automatic && !latestAssistantWasAborted(ctx)) await finish(ctx)
    else await activity.waiting()
  })
  pi.on("session_shutdown", async () => {
    if (lifecycle !== "terminated" && lifecycle !== "awaiting-parent") await activity.done()
  })
}
