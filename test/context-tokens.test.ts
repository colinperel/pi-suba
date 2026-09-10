import { describe, expect, it } from "vitest"
import { latestRequestContextTokens, requestContextTokens } from "../src/shared/context-tokens.ts"

describe("last-request context", () => {
  it.each([
    [{ input: 120, cacheRead: 0, cacheWrite: 0 }, 120],
    [{ input: 20, cacheRead: 90, cacheWrite: 10, cacheWrite1h: 10, output: 99 }, 120],
    [{ input: 0, cacheRead: 120, cacheWrite: 0 }, 120],
    [undefined, undefined],
    [{ input: 120 }, undefined],
    [{ input: 0, cacheRead: 0, cacheWrite: 0 }, undefined],
    [{ input: -1, cacheRead: 120, cacheWrite: 0 }, undefined],
    [{ input: Infinity, cacheRead: 0, cacheWrite: 0 }, undefined],
  ])("normalizes %j to %s", (usage, expected) => {
    expect(requestContextTokens({ role: "assistant", usage })).toBe(expected)
  })
  it("uses the latest measured assistant, not totals or nested tool usage", () => {
    const entry = (input: number, role = "assistant") => ({
      type: "message",
      message: { role, usage: { input, cacheRead: 0, cacheWrite: 0 } },
    })
    expect(
      latestRequestContextTokens([entry(100), entry(20), entry(0), entry(999, "toolResult")]),
    ).toBe(20)
  })
})
