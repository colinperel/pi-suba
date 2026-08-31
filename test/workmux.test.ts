import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  parseHeadlessReceipt,
  provisionWorktree,
  rollbackWorktree,
  worktreeHandle,
} from "../src/shared/workmux.ts"

const originalPath = process.env.PATH

beforeEach(() => {
  process.env.PATH = originalPath
})

afterEach(() => {
  process.env.PATH = originalPath
})

describe("workmux worktrees", () => {
  it("derives a stable source-prefixed handle", () => {
    expect(worktreeHandle("Review parser!", "a1b2c3d4")).toBe("suba-review-parser-a1b2c3d4")
    expect(worktreeHandle("---", "deadbeef")).toBe("suba-agent-deadbeef")
  })

  it("validates the versioned receipt and path boundary", () => {
    const parsed = parseHeadlessReceipt(
      JSON.stringify({
        schema_version: 1,
        handle: "suba-parser-a1b2c3d4",
        branch: "suba-parser-a1b2c3d4",
        worktree_path: "/repo__worktrees/suba-parser-a1b2c3d4",
        working_directory: "/repo__worktrees/suba-parser-a1b2c3d4/packages/app",
      }),
      "",
      "/repo",
      "suba-parser-a1b2c3d4",
    )
    expect(parsed.workingDirectory).toContain("packages/app")

    expect(() =>
      parseHeadlessReceipt(
        JSON.stringify({
          schema_version: 1,
          handle: "suba-parser-a1b2c3d4",
          branch: "suba-parser-a1b2c3d4",
          worktree_path: "/repo__worktrees/suba-parser-a1b2c3d4",
          working_directory: "/tmp/outside",
        }),
        "",
        "/repo",
        "suba-parser-a1b2c3d4",
      ),
    ).toThrow("outside the provisioned worktree")
  })

  it("invokes the required CLI contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-suba-workmux-"))
    const bin = join(root, "bin")
    const source = join(root, "repo")
    const worktree = join(root, "trees", "suba-parser-a1b2c3d4")
    const workingDirectory = join(worktree, "packages", "app")
    const argumentsFile = join(root, "arguments.json")
    await mkdir(bin)
    await mkdir(source)
    await mkdir(workingDirectory, { recursive: true })
    const executable = join(bin, "workmux")
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({schema_version:1,handle:"suba-parser-a1b2c3d4",branch:"suba-parser-a1b2c3d4",worktree_path:${JSON.stringify(worktree)},working_directory:${JSON.stringify(workingDirectory)}}));\n`,
    )
    await chmod(executable, 0o700)
    process.env.PATH = bin

    const receipt = await provisionWorktree("parser", "a1b2c3d4", source)

    expect(receipt.handle).toBe("suba-parser-a1b2c3d4")
    expect(JSON.parse(await readFile(argumentsFile, "utf8"))).toEqual([
      "add",
      "suba-parser-a1b2c3d4",
      "--name",
      "suba-parser-a1b2c3d4",
      "--headless",
      "--json",
    ])
  })

  it("reports a missing workmux executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-suba-workmux-missing-"))
    process.env.PATH = root
    await expect(provisionWorktree("parser", "a1b2c3d4", root)).rejects.toThrow(
      "requires workmux on PATH",
    )
  })

  it("preserves launch and rollback failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-suba-workmux-rollback-"))
    const bin = join(root, "bin")
    await mkdir(bin)
    const executable = join(bin, "workmux")
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stderr.write("remove failed");process.exit(7);\n`,
    )
    await chmod(executable, 0o700)
    process.env.PATH = bin

    const error = await rollbackWorktree(
      {
        handle: "suba-parser-a1b2c3d4",
        branch: "suba-parser-a1b2c3d4",
        sourceCwd: root,
        worktreePath: join(root, "tree"),
        workingDirectory: join(root, "tree"),
      },
      new Error("target failed"),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as Error).message).toContain("workmux remove --force")
  })
})
