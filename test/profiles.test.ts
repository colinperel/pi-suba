import { describe, expect, it } from "vitest"
import { parseProfile, TOOL_POLICIES } from "../src/shared/profiles.ts"

describe("profiles", () => {
  it("parses frontmatter and body", () => {
    const profile = parseProfile(
      `---\nname: explore\ntools: read,bash\nload-context: false\nload-skills: false\nsystem-prompt: replace\nauto-complete: false\nthinking: low\n---\n\nExplore.\n`,
      "file",
    )
    expect(profile).toMatchObject({
      name: "explore",
      tools: "read-only",
      loadContext: false,
      loadSkills: false,
      systemPrompt: "replace",
      autoComplete: false,
      thinking: "low",
      body: "Explore.",
    })
    expect(TOOL_POLICIES[profile.tools]).toEqual(["read", "bash"])
  })
  it("parses child flags", () =>
    expect(
      parseProfile('---\nflags:\n  service-tier: "off"\n  plan: false\n---\n', "x").flags,
    ).toEqual({ "service-tier": "off", plan: false }))
  it("reads frontmatter with Pi's parser, including CRLF", () =>
    expect(parseProfile("---\r\nflags: {service-tier: off}\r\n---\r\nbody", "x")).toMatchObject({
      flags: { "service-tier": "off" },
      body: "body",
    }))
  it("rejects non-mapping flags", () => {
    for (const flags of ["!!set {a}", "[a]", "x"])
      expect(() => parseProfile(`---\nflags: ${flags}\n---\n`, "x")).toThrow(
        "flags must be a mapping",
      )
  })
  it("uses filename fallback", () => expect(parseProfile("Prompt", "review").name).toBe("review"))
  it("rejects arbitrary tools and keys", () => {
    expect(() => parseProfile("---\ntools: read,write\n---\n", "x")).toThrow(
      "unsupported tools policy",
    )
    expect(() => parseProfile("---\nunknown: yes\n---\n", "x")).toThrow("unsupported profile key")
  })
})
