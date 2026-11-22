import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { type ChildFlags, parseChildFlags } from "./config.ts"
import { subaDirectory } from "./paths.ts"
import { parseFrontmatter } from "@earendil-works/pi-coding-agent"
import { THINKING_LEVELS, type ThinkingLevel } from "./protocol.ts"

export type AllowedToolPolicy = "default" | "read-only"
export interface Profile {
  name: string
  description?: string
  model?: string
  thinking?: ThinkingLevel
  tools: AllowedToolPolicy
  loadContext: boolean
  loadSkills: boolean
  systemPrompt: "append" | "replace"
  autoComplete?: boolean
  flags: ChildFlags
  body: string
  source?: string
}

export const BUILTIN_DEFAULT_PROFILE: Profile = {
  name: "default",
  tools: "default",
  loadContext: true,
  loadSkills: true,
  systemPrompt: "append",
  flags: {},
  body: "",
}
export const TOOL_POLICIES: Record<AllowedToolPolicy, string[]> = {
  default: ["read", "bash", "edit", "write"],
  "read-only": ["read", "bash"],
}
const KEYS = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "tools",
  "load-context",
  "load-skills",
  "system-prompt",
  "auto-complete",
  "flags",
])

function scalarString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}
function scalarBoolean(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

/** A plain YAML mapping; sequences and tagged collections such as !!set are not. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  )
}

function profileFlags(value: unknown): ChildFlags {
  if (value === undefined) return {}
  if (!isMapping(value)) throw new Error("flags must be a mapping")
  return parseChildFlags(value, "flags")
}

export function parseProfile(markdown: string, fallbackName: string, source?: string): Profile {
  // Pi's own front-matter parser, as for skills and prompt templates.
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(markdown)
  if (!isMapping(frontmatter)) throw new Error("frontmatter must be a mapping")
  const data = frontmatter
  for (const key of Object.keys(data))
    if (!KEYS.has(key)) throw new Error(`unsupported profile key: ${key}`)
  const rawTools = scalarString(data.tools, "tools") ?? "default"
  const normalizedTools =
    rawTools === "read,bash"
      ? "read-only"
      : rawTools === "read,bash,edit,write"
        ? "default"
        : rawTools
  if (normalizedTools !== "default" && normalizedTools !== "read-only")
    throw new Error(`unsupported tools policy: ${rawTools}`)
  const thinking = scalarString(data.thinking, "thinking") as ThinkingLevel | undefined
  if (thinking && !THINKING_LEVELS.includes(thinking))
    throw new Error(`invalid thinking level: ${thinking}`)
  const systemPrompt = scalarString(data["system-prompt"], "system-prompt") ?? "append"
  if (systemPrompt !== "append" && systemPrompt !== "replace")
    throw new Error(`invalid system-prompt: ${systemPrompt}`)
  const autoCompleteValue = data["auto-complete"]
  if (autoCompleteValue !== undefined && typeof autoCompleteValue !== "boolean")
    throw new Error("auto-complete must be a boolean")
  if (systemPrompt === "replace" && !body.trim())
    throw new Error("system-prompt replace requires a profile body")
  return {
    name: scalarString(data.name, "name") ?? fallbackName,
    description: scalarString(data.description, "description"),
    model: scalarString(data.model, "model"),
    thinking,
    tools: normalizedTools,
    loadContext: scalarBoolean(data["load-context"], "load-context", true),
    loadSkills: scalarBoolean(data["load-skills"], "load-skills", true),
    systemPrompt,
    autoComplete: autoCompleteValue as boolean | undefined,
    flags: profileFlags(data.flags),
    body,
    source,
  }
}

export async function loadProfiles(
  dir = join(subaDirectory(), "profiles"),
): Promise<Map<string, Profile>> {
  const profiles = new Map<string, Profile>([["default", BUILTIN_DEFAULT_PROFILE]])
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return profiles
    throw error
  }
  for (const name of names.filter((item) => item.endsWith(".md")).sort()) {
    const path = join(dir, name)
    try {
      const profile = parseProfile(await readFile(path, "utf8"), basename(name, ".md"), path)
      if (profiles.has(profile.name) && profile.name !== "default")
        throw new Error(`duplicate profile name: ${profile.name}`)
      profiles.set(profile.name, profile)
    } catch (error) {
      throw new Error(
        `Cannot load profile ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return profiles
}
