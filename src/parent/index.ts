import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { formatRequestContext } from "../shared/context-tokens.ts"
import { loadConfig, type SubaConfig } from "../shared/config.ts"
import { loadInstructions } from "../shared/instructions.ts"
import { loadProfiles, type Profile } from "../shared/profiles.ts"
import { registerCommands } from "./commands.ts"
import { registerTools, type ManagerHost } from "./tools.ts"
import { isLive, restoreRegistry, type ChildRecord } from "./registry.ts"
import { renderSubagentMessage, type SubagentMessageDetails } from "./result.ts"
import { ChildWatcher } from "./watcher.ts"
import { ActivityWidget, projectWidget } from "./widget.ts"

export default async function (pi: ExtensionAPI) {
  let config: SubaConfig = await loadConfig()
  let instructions = await loadInstructions()
  let profiles: Map<string, Profile> = await loadProfiles()
  const records = new Map<string, ChildRecord>()
  let latestCtx: ExtensionContext | undefined
  let renderTimer: NodeJS.Timeout | undefined
  let ready = false
  let sessionGeneration = 0
  let publishedCount: number | undefined
  const publishActivity = (force = false) => {
    if (!ready) return
    const activeCount = [...records.values()].filter(
      (record) =>
        isLive(record) &&
        record.state !== "awaiting-parent" &&
        (!record.activity ||
          record.activity.state === "starting" ||
          record.activity.state === "working"),
    ).length
    if (force || activeCount !== publishedCount) {
      publishedCount = activeCount
      pi.events.emit("suba:activity", { activeCount })
    }
  }
  let unsubscribeActivity: (() => void) | undefined
  const subscribeActivity = () => {
    unsubscribeActivity ??= pi.events.on("suba:activity:request", () => publishActivity(true))
  }
  subscribeActivity()
  const refreshWidget = () => {
    if (!latestCtx?.hasUI) return
    const projection = projectWidget([...records.values()], Date.now(), config.activity.maxRows)
    if (!projection.activeCount) {
      latestCtx.ui.setWidget("suba-activity", undefined)
      if (renderTimer) clearInterval(renderTimer)
      renderTimer = undefined
      return
    }
    latestCtx.ui.setWidget(
      "suba-activity",
      (_tui, theme) =>
        new ActivityWidget(
          () => projectWidget([...records.values()], Date.now(), config.activity.maxRows),
          theme,
        ),
      { placement: "aboveEditor" },
    )
    if (!renderTimer) renderTimer = setInterval(() => refreshWidget(), 1000)
  }
  const host = {
    config,
    profiles,
    records,
    persist: (record: ChildRecord) => {
      pi.appendEntry("suba-child", record)
      publishActivity()
    },
    refreshWidget,
    watch: (id: string) => void watcher.check(id),
  } satisfies ManagerHost
  const callbacks = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    update: (
      record: ChildRecord,
      notify?: { type: "result" | "ask" | "notify"; content: string },
    ) => {
      if (!isLive(records.get(record.id) ?? record)) return
      records.set(record.id, record)
      host.persist(record)
      refreshWidget()
      if (notify)
        pi.sendMessage(
          {
            customType: "suba-result",
            content:
              notify.type === "result"
                ? notify.content.replace(
                    /^[^\n]*/,
                    (header) =>
                      `${header}\n${formatRequestContext(record.lastRequestContextTokens)}`,
                  )
                : notify.content,
            display: true,
            details: {
              id: record.id,
              type: notify.type,
              name: record.name,
              state: record.state,
              sessionFile: record.sessionFile,
              paneId: record.paneId,
              profile: record.profile,
              model: record.activity?.model ?? record.resolvedLaunch.model,
              thinking: record.activity?.thinking ?? record.resolvedLaunch.thinking,
              lastRequestContextTokens: record.lastRequestContextTokens,
              elapsed: Date.now() - record.startedAt,
              error: record.error,
              report: record.report,
            } satisfies SubagentMessageDetails,
          },
          { deliverAs: "steer", triggerTurn: true },
        )
    },
    activity: (record: ChildRecord) => {
      if (!isLive(records.get(record.id) ?? record)) return
      records.set(record.id, record)
      publishActivity()
      refreshWidget()
    },
  }
  const watcher = new ChildWatcher(config.activity.pollMs, callbacks)
  registerTools(pi, host)
  registerCommands(pi, () => host.profiles.values())
  pi.registerMessageRenderer("suba-result", (message, options, theme) => {
    const details = (message.details ?? {}) as SubagentMessageDetails
    const content =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    return renderSubagentMessage(
      content,
      details,
      options.expanded,
      keyHint("app.tools.expand", "to expand"),
      theme,
    )
  })
  pi.on("before_agent_start", (event) => {
    if (!instructions) return
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` }
  })
  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration
    ready = false
    watcher.stop()
    subscribeActivity()
    const [nextConfig, nextInstructions, nextProfiles] = await Promise.all([
      loadConfig(),
      loadInstructions(),
      loadProfiles(),
    ])
    if (generation !== sessionGeneration) return
    config = nextConfig
    instructions = nextInstructions
    profiles = nextProfiles
    latestCtx = ctx
    host.config = config
    host.profiles = profiles
    records.clear()
    for (const [id, record] of restoreRegistry(ctx.sessionManager.getEntries()))
      records.set(id, record)
    // Persisted activity can lag behind children that kept running while the parent was away.
    await watcher.tick()
    if (generation !== sessionGeneration) return
    ready = true
    publishActivity(true)
    watcher.start()
    refreshWidget()
  })
  pi.on("session_shutdown", () => {
    sessionGeneration += 1
    ready = false
    watcher.stop()
    unsubscribeActivity?.()
    unsubscribeActivity = undefined
    records.clear()
    publishedCount = 0
    pi.events.emit("suba:activity", { activeCount: 0 })
    if (renderTimer) clearInterval(renderTimer)
    renderTimer = undefined
    if (latestCtx?.hasUI) latestCtx.ui.setWidget("suba-activity", undefined)
    latestCtx = undefined
  })
}
