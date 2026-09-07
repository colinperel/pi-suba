import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { launchScript } from "../src/parent/tools.ts"
import { loadConfig, resolveChildExtensionSource } from "../src/shared/config.ts"
import { loadInstructions } from "../src/shared/instructions.ts"
import { agentDirectory, artifactDirectory, subaDirectory } from "../src/shared/paths.ts"
import { loadProfiles } from "../src/shared/profiles.ts"

const exec = promisify(execFile)
const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-suba-paths-"))
  directories.push(dir)
  return dir
}

describe("agent-scoped paths", () => {
  it("uses Pi's default and expands tilde and relative overrides", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined)
    expect(subaDirectory()).toBe(join(homedir(), ".pi", "agent", "suba"))
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/.pi-work/agent")
    expect(agentDirectory()).toBe(join(homedir(), ".pi-work", "agent"))
    vi.stubEnv("PI_CODING_AGENT_DIR", "./custom-agent")
    expect(agentDirectory()).toBe(resolve("custom-agent"))
  })

  it("isolates resources even when agent directories share a parent", async () => {
    const root = await temporaryDirectory()
    vi.stubEnv("SUBA_ARTIFACT_ROOT", undefined)
    for (const name of ["personal", "work"]) {
      const agent = join(root, name)
      const suba = join(agent, "suba")
      await mkdir(join(suba, "profiles"), { recursive: true })
      await writeFile(join(suba, "config.json"), JSON.stringify({ sharedWindowName: name }))
      await writeFile(join(suba, "instructions.md"), name)
      await writeFile(join(suba, "profiles", `${name}.md`), `Profile for ${name}`)
      vi.stubEnv("PI_CODING_AGENT_DIR", agent)
      expect((await loadConfig()).sharedWindowName).toBe(name)
      expect(await loadInstructions()).toBe(name)
      expect([...(await loadProfiles()).keys()]).toEqual(["default", name])
      expect(resolveChildExtensionSource("./extensions/helper.ts")).toBe(
        join(agent, "extensions", "helper.ts"),
      )
      expect(artifactDirectory()).toBe(join(suba, "artifacts"))
    }
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "empty"))
    expect(await loadInstructions()).toBe("")
    expect((await loadConfig()).sharedWindowName).toBe("suba")
    expect([...(await loadProfiles()).keys()]).toEqual(["default"])
  })

  it("honors an explicit artifact root", () => {
    vi.stubEnv("SUBA_ARTIFACT_ROOT", "./artifacts-test")
    expect(artifactDirectory()).toBe(resolve("artifacts-test"))
  })

  it("pins the parent's agent directory despite a different child environment", async () => {
    const root = await temporaryDirectory()
    const executable = join(root, "fake-pi")
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$PI_CODING_AGENT_DIR" > agent-dir.txt\n', {
      mode: 0o700,
    })
    vi.stubEnv("SUBA_PI_EXECUTABLE", executable)
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "parent agent"))
    const script = join(root, "launch.sh")
    await writeFile(script, launchScript([], {}, root, root))
    await exec("sh", [script], {
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "other-agent") },
    })
    expect(await readFile(join(root, "agent-dir.txt"), "utf8")).toBe(join(root, "parent agent"))
  })
})
