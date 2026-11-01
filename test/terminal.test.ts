import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  checkTerminal,
  openTerminal,
  selectTerminal,
  UncertainTerminalLaunchError,
} from "../src/shared/terminal.ts"

it("keeps the selected Rex backend's actionable failure without retrying the launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "suba-rex-error-"))
  try {
    await writeFile(
      join(root, "rex"),
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SUBA_TEST_CALLS"\nprintf "%s\\n" "No such block: stale-parent" >&2\nexit 1\n',
      { mode: 0o700 },
    )
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`)
    vi.stubEnv("SUBA_TEST_CALLS", join(root, "calls"))
    const error = await openTerminal(
      { kind: "rex", parentId: "stale-parent" },
      "/unused-script",
      root,
      "unused task",
      "0123456789abcdef",
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UncertainTerminalLaunchError)
    expect((error as Error).message).toContain("No such block: stale-parent")
    expect(await readFile(join(root, "calls"), "utf8")).toBe("split\n")
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(["tmux", "rex"] as const)("identifies an unavailable selected %s backend", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "suba-missing-terminal-"))
  try {
    vi.stubEnv("PATH", root)
    const error = await checkTerminal({ kind, parentId: "parent" }).catch(
      (caught: unknown) => caught,
    )
    expect((error as Error).message).toContain(`Selected ${kind} backend is unavailable`)
    expect((error as Error).message).toContain("ENOENT")
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

describe("terminal selection", () => {
  it("keeps tmux features when tmux is nested inside Rex", () => {
    expect(
      selectTerminal({ TMUX_PANE: "%7", REX_BLOCK: "block:parent", REX_SESSION: "session:one" }),
    ).toEqual({ kind: "tmux", parentId: "%7" })
  })

  it("selects the current Rex block and session", () => {
    expect(selectTerminal({ REX_BLOCK: "block:parent", REX_SESSION: "session:one" })).toEqual({
      kind: "rex",
      parentId: "block:parent",
      sessionId: "session:one",
    })
  })

  it.each([{}, { WEZTERM_PANE: "3" }, { ZELLIJ: "0" }, { TERM: "dumb" }])(
    "allows delegation without a supported visible terminal: %j",
    (env) => {
      expect(selectTerminal(env)).toEqual({ kind: "background" })
    },
  )
})
