import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { atomicWriteJson, readActivity, readEvents, writeEvent } from "../src/shared/protocol.ts"

describe("artifact protocol", () => {
  it.each([
    { summary: "" },
    { summary: " \n" },
    { artifacts: ["a"] },
    { summary: "ok", artifacts: [42] },
  ])("rejects malformed stored reports without legacy fallback: %j", async (report) => {
    const dir = await mkdtemp(join(tmpdir(), "suba-invalid-report-"))
    await atomicWriteJson(join(dir, "events", "000001-completed.json"), {
      version: 1,
      childId: "abc",
      sequence: 1,
      timestamp: 1,
      type: "completed",
      report,
    })
    await expect(readEvents(dir, 0)).rejects.toThrow(/suba_done/)
  })

  it("atomically replaces activity and validates identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-protocol-"))
    const path = join(dir, "activity.json")
    await atomicWriteJson(path, {
      version: 1,
      childId: "abc",
      sequence: 2,
      updatedAt: 1,
      state: "working",
    })
    expect((await readActivity(path, "abc")).sequence).toBe(2)
    await expect(readActivity(path, "other")).rejects.toThrow("identity")
    expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false)
  })
  it("replays ordered events after a sequence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suba-events-"))
    await writeEvent(dir, {
      version: 1,
      childId: "abc",
      sequence: 1,
      timestamp: 1,
      type: "ping",
      message: "help",
    })
    await writeEvent(dir, {
      version: 1,
      childId: "abc",
      sequence: 2,
      timestamp: 2,
      type: "completed",
    })
    expect((await readEvents(dir, 1)).map((event) => event.type)).toEqual(["completed"])
  })
})
