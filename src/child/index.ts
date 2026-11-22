import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { latestRequestContextTokens, requestContextTokens } from "../shared/context-tokens.ts"
import { CommandInbox, DeferredCommand } from "../shared/control.ts"
import {
  validateCompletionReport,
  type CompletionReport,
  type ThinkingLevel,
} from "../shared/protocol.ts"
import { ActivityRecorder } from "./activity.ts"
import { EventWriter } from "./events.ts"

type Lifecycle = "running" | "awaiting-parent" | "completing" | "terminated"
const TRUNCATION_ERROR = "response truncated at output token limit"

function latestVisibleAssistant(ctx: ExtensionContext): {
  message?: AssistantMessage
  hiddenAttempt?: AssistantMessage
} {
  const branch = ctx.sessionManager.getBranch()
  const seenEdits = new Set<string>()
  const hidden = new Set<string>()
  let hiddenAttempt: AssistantMessage | undefined
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (entry.type === "context_edit" && !seenEdits.has(entry.targetId)) {
      seenEdits.add(entry.targetId)
      if (entry.replacement === null) hidden.add(entry.targetId)
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") continue
    if (!hidden.has(entry.id)) return { message: entry.message, hiddenAttempt }
    const { stopReason } = entry.message
    if (
      !hiddenAttempt &&
      (stopReason === "error" || stopReason === "length" || stopReason === "aborted")
    )
      hiddenAttempt = entry.message
  }
  return { hiddenAttempt }
}

function latestAssistantWasAborted(message: AssistantMessage | undefined): boolean {
  return (
    message?.stopReason === "aborted" ||
    (message?.stopReason === "error" &&
      /\boperation was aborted\b/i.test(message.errorMessage ?? ""))
  )
}

// Pi's sendUserMessage is fire-and-forget. Prompts dispatched while Pi is idle
// collide if both pass preflight before either starts its run, and a prompt
// that fails before its run emits nothing an extension can observe. Track the
// one run-starting prompt in preflight (Pi queues prompts sent while
// streaming, and can withdraw them silently; pending messages cover those),
// and treat one that shows no Pi progress for this long as lost so the child
// cannot stay unfinishable. The proper fix is a Pi API that reports delivery.
const LOST_DELIVERY_MS = 30000

export default function (pi: ExtensionAPI) {
  const childId = process.env.SUBA_CHILD_ID
  const artifactDir = process.env.SUBA_ARTIFACT_DIR
  if (!childId || !artifactDir)
    throw new Error("pi-suba child extension requires SUBA_CHILD_ID and SUBA_ARTIFACT_DIR")
  const automatic = process.env.SUBA_AUTO_COMPLETE !== "0"
  const activity = new ActivityRecorder(childId, artifactDir)
  const events = new EventWriter(childId, artifactDir)
  let lifecycle: Lifecycle = "running"
  let pendingReport: CompletionReport | undefined
  let preflight = false
  let deliveryProgress = 0
  let compacting = false
  let overflowRecovery: { error: string } | "aborted" | undefined
  let latestContext: ExtensionContext | undefined
  const progress = () => {
    deliveryProgress = Date.now()
  }
  const awaitingDelivery = async (ctx: ExtensionContext): Promise<boolean> => {
    if (!preflight) return false
    if (
      compacting ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      Date.now() - deliveryProgress < LOST_DELIVERY_MS
    )
      return true
    preflight = false
    if (lifecycle === "running") await activity.waiting()
    return false
  }
  const runId = process.env.SUBA_RUN_ID
  const inbox = runId
    ? new CommandInbox(artifactDir, runId, childId, async (command) => {
        const ctx = latestContext
        if (!ctx || lifecycle === "terminated" || lifecycle === "completing")
          throw new Error("Child is no longer accepting commands; use suba_resume")
        if (command.type === "shutdown") {
          if (
            (await awaitingDelivery(ctx)) ||
            ctx.hasPendingMessages() ||
            (lifecycle !== "awaiting-parent" && !ctx.isIdle())
          )
            throw new Error("Child must be idle or awaiting parent guidance before finishing")
          await activity.done()
          return () => {
            lifecycle = "terminated"
            inbox?.stop()
            ctx.shutdown()
          }
        }
        // Pi runs registered extension commands before input/agent hooks. They
        // are not model-visible guidance and must not invalidate a final report
        // or leave an idle child marked working.
        const commandName = command.message.slice(1).split(" ", 1)[0]
        const extensionCommand =
          command.message.startsWith("/") &&
          pi
            .getCommands()
            .some((entry) => entry.source === "extension" && entry.name === commandName)
        if (!extensionCommand) {
          // While streaming, Pi queues the steer; while idle, a second prompt
          // would race the first one's preflight.
          if (ctx.isIdle() && (compacting || (await awaitingDelivery(ctx))))
            throw new DeferredCommand()
          // Counted until the input hook shows whether Pi will queue it.
          preflight = true
          progress()
          pendingReport = undefined
          lifecycle = "running"
          await activity.model()
        }
        pi.sendUserMessage(command.message, { deliverAs: "steer", expandPromptTemplates: true })
      })
    : undefined

  const finish = async (
    ctx: ExtensionContext,
    result?: { report: CompletionReport } | { error: string },
  ) => {
    if (lifecycle !== "running") return
    lifecycle = "completing"
    try {
      if (result && "error" in result) await events.failed(result.error)
      else await events.completed(result?.report)
    } catch (error) {
      lifecycle = "running"
      throw error
    }
    await activity.done().catch(() => undefined)
    lifecycle = "terminated"
    inbox?.stop()
    ctx.shutdown()
  }

  pi.registerTool({
    name: "suba_done",
    label: "Suba Done",
    description:
      "Submit a final nonempty summary and optional artifact references without preceding prose. Completion waits for queued guidance; if guidance arrives, address it and submit an updated report. Artifacts are not read or executed; completion does not mean parent acceptance.",
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
    async execute(_id, params) {
      validateCompletionReport(params)
      if (lifecycle !== "running")
        throw new Error(`suba_done is unavailable while lifecycle is ${lifecycle}`)
      pendingReport = params
      return {
        content: [
          {
            type: "text",
            text: "Final report recorded for delivery once queued guidance has been processed.",
          },
        ],
        details: params,
        terminate: true,
      }
    },
  })
  pi.registerTool({
    name: "suba_notify",
    label: "Suba Notify",
    description:
      "Record a nonurgent update and continue working. This does not wake the parent. Use suba_ask when the parent needs to act now.",
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
            text: "Update recorded without waking the parent. Continue working.",
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
      "Get parent attention for a blocker, decision, or urgent issue. Pauses the current run until guidance arrives.",
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
    latestContext = ctx
    await events.initialize()
    await activity.update({
      lastRequestContextTokens: latestRequestContextTokens(ctx.sessionManager.getBranch()),
    })
    await activity.starting()
    if (ctx.model) await activity.selected(ctx.model.provider, ctx.model.id)
    await activity.thinking(ctx.thinkingLevel as ThinkingLevel)
    inbox?.start()
    lostDeliveryTimer ??= setInterval(() => {
      if (latestContext) void awaitingDelivery(latestContext).catch(() => undefined)
    }, 1000)
    lostDeliveryTimer.unref()
  })
  let lostDeliveryTimer: NodeJS.Timeout | undefined
  pi.on("before_agent_start", progress)
  pi.on("session_before_compact", () => {
    compacting = true
  })
  const compacted = () => {
    compacting = false
    progress()
  }
  pi.on("session_compact", compacted)
  pi.on("session_compact_failed", (event) => {
    compacted()
    if (event.reason === "overflow") {
      overflowRecovery = event.aborted
        ? "aborted"
        : { error: event.errorMessage || "context overflow recovery failed" }
    }
  })
  const resumeInput = async () => {
    progress()
    if (lifecycle === "awaiting-parent") {
      lifecycle = "running"
      await activity.model()
    }
  }
  pi.on("input", async (event) => {
    // Launch, resume, and pane-typed prompts share Pi's preflight with inbox
    // guidance. A prompt sent while streaming is queued, not run.
    preflight = !event.streamingBehavior
    await resumeInput()
  })
  const working = (update: () => Promise<void>) => {
    if (lifecycle === "running") return update()
  }
  pi.on("agent_start", (_event, ctx) => {
    overflowRecovery = undefined
    if (lifecycle === "terminated" || lifecycle === "completing") {
      ctx.abort()
      return
    }
    preflight = false
    return working(() => activity.model())
  })
  pi.on("message_start", async (event) => {
    // Receipt confirms dispatch, not model-visible delivery. A queued steer can
    // also arrive after suba_ask without starting another agent run.
    if (event.message.role === "user") {
      preflight = false
      pendingReport = undefined
      await resumeInput()
    }
  })
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
  pi.on("agent_settled", async (event, ctx) => {
    await inbox?.poll()
    if (preflight || lifecycle !== "running" || ctx.hasPendingMessages()) return
    const recovery = overflowRecovery
    overflowRecovery = undefined
    if (pendingReport) {
      await finish(ctx, { report: pendingReport })
      pendingReport = undefined
      return
    }
    if (event.aborted) return activity.waiting()

    const { message, hiddenAttempt } = latestVisibleAssistant(ctx)
    // Pi can also compact for overflow after a successful turn, with no retry.
    const turnFailed = hiddenAttempt !== undefined || message?.stopReason !== "stop"
    if (turnFailed && recovery) {
      if (recovery === "aborted") return activity.waiting()
      return finish(ctx, recovery)
    }
    if (hiddenAttempt) {
      // Pi hides the attempt before checking if there is anything to compact.
      // Unlike a cancelled provider retry, an overflow or truncation is terminal here.
      if (latestAssistantWasAborted(hiddenAttempt)) return activity.waiting()
      const truncated = hiddenAttempt.stopReason === "length"
      if (truncated || isContextOverflow(hiddenAttempt, ctx.model?.contextWindow)) {
        const fallback = truncated ? TRUNCATION_ERROR : "context overflow recovery failed"
        return finish(ctx, { error: hiddenAttempt.errorMessage || fallback })
      }
      return activity.waiting()
    }
    if (latestAssistantWasAborted(message)) return activity.waiting()
    if (message?.stopReason === "error")
      return finish(ctx, { error: message.errorMessage || "provider request failed" })
    if (message?.stopReason === "length")
      return finish(ctx, { error: message.errorMessage || TRUNCATION_ERROR })
    if (automatic) await finish(ctx)
    else await activity.waiting()
  })
  pi.on("session_shutdown", async () => {
    inbox?.stop()
    clearInterval(lostDeliveryTimer)
    lostDeliveryTimer = undefined
    latestContext = undefined
    if (lifecycle !== "terminated" && lifecycle !== "awaiting-parent") await activity.done()
  })
}
