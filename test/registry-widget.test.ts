import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import {
  isResumable,
  nextRevision,
  resolveStoredArtifactPaths,
  restoreRegistry,
  type ChildRecord,
} from "../src/parent/registry.ts"
import { ActivityWidget, projectWidget, projectWidgetRows } from "../src/parent/widget.ts"

const record = (revision: number): ChildRecord => ({
  id: "a1",
  revision,
  state: "running",
  sessionFile: "/s",
  artifactDir: "/a",
  placement: { type: "split" },
  name: "auth-tests",
  cwd: "/w",
  profile: "default",
  resolvedLaunch: {
    profile: "default",
    tools: "default",
    loadContext: true,
    loadSkills: true,
    systemPrompt: "append",
    autoComplete: true,
    model: "anthropic/claude-sonnet-4-6",
    thinking: "medium",
  },
  lastEventSequence: 0,
  startedAt: 0,
  resultAfterEntry: 1,
})

describe("registry and widget", () => {
  it("restores the highest revision", () => {
    const restored = restoreRegistry([
      { type: "custom", customType: "suba-child", data: record(1) },
      { type: "custom", customType: "suba-child", data: record(3) },
    ])
    expect(restored.get("a1")?.revision).toBe(3)
    expect(nextRevision(record(3), { state: "completed" }).revision).toBe(4)
  })
  it("restores worktree launch metadata", () => {
    const worktreeRecord = {
      ...record(1),
      worktree: {
        handle: "suba-auth-a1",
        branch: "suba-auth-a1",
        sourceCwd: "/repo",
        worktreePath: "/repo__worktrees/suba-auth-a1",
        workingDirectory: "/repo__worktrees/suba-auth-a1/packages/app",
      },
    }
    const restored = restoreRegistry([
      { type: "custom", customType: "suba-child", data: worktreeRecord },
    ])
    expect(restored.get("a1")?.worktree).toEqual(worktreeRecord.worktree)
    const completed: ChildRecord = { ...worktreeRecord, state: "completed" }
    expect(isResumable(worktreeRecord, () => true)).toBe(false)
    expect(isResumable(completed, () => true)).toBe(true)
    expect(isResumable(completed, () => false)).toBe(false)
    expect(isResumable(completed, (path) => path === completed.worktree?.worktreePath)).toBe(false)
    expect(isResumable({ ...record(1), state: "completed" }, () => false)).toBe(true)
  })

  it("finds stored artifacts under their resource directory", () => {
    const previous = {
      ...record(1),
      artifactDir: "/home/user/.pi/suba/session-id/child-id",
      sessionFile: "/home/user/.pi/suba/session-id/child-id/session.jsonl",
    }
    const resolved = resolveStoredArtifactPaths(
      previous,
      "/home/user/.pi/suba",
      (path) => path === "/home/user/.pi/suba/artifacts/session-id/child-id",
    )
    expect(resolved.artifactDir).toBe("/home/user/.pi/suba/artifacts/session-id/child-id")
    expect(resolved.sessionFile).toBe(
      "/home/user/.pi/suba/artifacts/session-id/child-id/session.jsonl",
    )
  })
  it("caps activity rows", () => {
    const first = record(1)
    first.activity = {
      version: 1,
      childId: "a1",
      sequence: 1,
      updatedAt: 1,
      state: "working",
      activity: "tool",
      toolName: "bash",
    }
    const second = { ...record(1), id: "b2", name: "review" }
    const rows = projectWidgetRows([first, second], 20_000, 1)
    expect(rows.join("\n")).toContain("bash")
    expect(rows.at(-1)).toBe("+1 more")
  })

  it("marks only worktree children in plain and bordered rows", () => {
    const isolated: ChildRecord = {
      ...record(1),
      worktree: {
        handle: "suba-auth-a1",
        branch: "suba-auth-a1",
        sourceCwd: "/repo",
        worktreePath: "/repo__worktrees/suba-auth-a1",
        workingDirectory: "/repo__worktrees/suba-auth-a1",
      },
    }
    const shared = { ...record(1), id: "b2", name: "review" }
    const projection = projectWidget([isolated, shared], 20_000, 3)
    expect(projection.items.map((item) => item.worktree)).toEqual([true, false])
    const rows = projectWidgetRows([isolated, shared], 20_000, 3)
    expect(rows[1]).toContain("● auth-tests [wt]")
    expect(rows[2]).not.toContain("[wt]")
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never
    const widget = new ActivityWidget(() => projection, theme)
    for (const width of [48, 80]) {
      const lines = widget.render(width)
      expect(lines[1]).toContain("● auth-tests [wt]")
      expect(lines[2]).not.toContain("[wt]")
    }
    for (let width = 1; width <= 100; width++) {
      expect(widget.render(width).every((line) => visibleWidth(line) <= width)).toBe(true)
    }
  })

  it("renders a bordered width-safe activity view", () => {
    const first = record(1)
    first.startedAt = 10_000
    first.activity = {
      version: 1,
      childId: "a1",
      sequence: 1,
      updatedAt: 20_000,
      state: "working",
      activity: "tool",
      toolName: "read",
      activityStartedAt: 24_500,
    }
    const projection = projectWidget([first], 25_000, 3)
    expect(projection.items[0]?.elapsed).toBe("15s")
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never
    const widget = new ActivityWidget(() => projection, theme)
    const lines = widget.render(48)
    expect(lines[0]).toContain("Subagents")
    expect(lines.join("\n")).toContain("auth-tests")
    for (const width of [1, 2, 3, 4, 16, 48]) {
      expect(widget.render(width).every((line) => visibleWidth(line) <= width)).toBe(true)
    }
  })
})
