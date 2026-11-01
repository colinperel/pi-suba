import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { atomicWriteJson, readActivity } from "../../src/shared/protocol.ts"
import { EventWriter } from "../../src/child/events.ts"

// Exercise real Pi command expansion and child control without a model request.
export default function (pi: ExtensionAPI) {
  const artifactDir = process.env.SUBA_ARTIFACT_DIR!
  const childId = process.env.SUBA_CHILD_ID!
  // A local in-process model plus a slow pre-run hook widens Pi's prompt
  // preflight window without network access or credentials.
  const faux =
    process.env.SUBA_TEST_FAKE_MODEL === "1"
      ? fauxProvider({ provider: "suba-fake", models: [{ id: "echo" }] })
      : undefined
  if (faux) {
    const respond: FauxResponseFactory = async (context) => {
      for (const message of context.messages)
        if (message.role === "user")
          await appendFile(
            join(artifactDir, "model-inputs.jsonl"),
            `${JSON.stringify(message.content)}\n`,
          )
      return fauxAssistantMessage("acknowledged")
    }
    faux.setResponses(Array.from({ length: 20 }, () => respond))
    pi.registerProvider(faux.provider)
    pi.on("before_agent_start", () => delay(500))
  }
  pi.on("session_start", async () => {
    if (process.env.SUBA_TEST_HOOK_ERROR === "1")
      throw new Error("Synthetic recoverable hook failure")
    if (faux) await pi.setModel(faux.getModel())
  })
  pi.registerCommand("suba-test-noop", {
    description: "Complete an extension command without an agent turn or activity mutation",
    handler: async () => {
      await writeFile(join(artifactDir, "noop.txt"), "handled")
    },
  })
  const waiting = async () => {
    const activity = await readActivity(join(artifactDir, "activity.json"), childId)
    await atomicWriteJson(join(artifactDir, "activity.json"), {
      ...activity,
      sequence: activity.sequence + 1,
      updatedAt: Date.now(),
      state: "waiting",
      activity: undefined,
    })
  }
  pi.registerCommand("suba-test-wait", {
    description: "Wait without contacting a model",
    handler: async () => {
      await waiting()
      const events = new EventWriter(childId, artifactDir)
      await events.initialize()
      await events.ask("ready for test guidance")
    },
  })
  pi.registerCommand("suba-test-complete", {
    description: "Complete without contacting a model",
    handler: async (_args, ctx) => {
      const events = new EventWriter(childId, artifactDir)
      await events.initialize()
      await events.completed({ summary: "completed without a model" })
      ctx.shutdown()
    },
  })
  pi.registerCommand("suba-test-dialog", {
    description: "Exercise a headless extension dialog without a model",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "Test dialog \u2028\u2029",
        "No interactive user is attached",
      )
      await writeFile(join(artifactDir, "dialog.json"), JSON.stringify(confirmed))
      await waiting()
      const events = new EventWriter(childId, artifactDir)
      await events.initialize()
      await events.ask("dialog handled")
    },
  })
  pi.registerCommand("suba-test-error", {
    description: "Exercise a command error without a model",
    handler: async () => {
      throw new Error("Synthetic command failure")
    },
  })
  pi.registerCommand("suba-test-guidance", {
    description: "Record command arguments without contacting a model",
    handler: async (args) => {
      await writeFile(join(artifactDir, "guidance.txt"), args, { mode: 0o600 })
      await waiting()
    },
  })
}
