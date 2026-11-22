import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { type ChildFlags, parseChildFlags } from "./config.ts"
import { subaDirectory } from "./paths.ts"
import YAML from "yaml"
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

const FRONTMATTER_START = /^---\r?\n/
// The closing delimiter is a whole line, so "---flag: x" inside the YAML is content.
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/

/**
 * A YAML mapping's entries with keys resolved (aliases included) but still typed,
 * so 01 cannot pass as "1" and two keys that resolve alike are a duplicate.
 */
function resolvedEntries(
  node: unknown,
  document: YAML.Document,
  label: string,
  kind: string,
): [string, unknown][] {
  const map = YAML.isAlias(node) ? node.resolve(document) : node
  // A !!set is a map of nulls in the YAML library, not a mapping of values.
  if (!YAML.isMap(map) || map.tag === "tag:yaml.org,2002:set")
    throw new Error(`${label} must be a mapping`)
  const seen = new Set<unknown>()
  return map.items.map(({ key, value }) => {
    const name: unknown = YAML.isNode(key) ? key.toJS(document) : key
    if (typeof name !== "string")
      throw new Error(`${label} has a non-string ${kind}: ${String(name)}`)
    if (seen.has(name)) throw new Error(`${label} has a duplicate ${kind}: ${name}`)
    seen.add(name)
    return [name, value]
  })
}

function nodeValue(node: unknown, document: YAML.Document): unknown {
  return YAML.isNode(node) ? node.toJS(document) : node
}

export function parseProfile(markdown: string, fallbackName: string, source?: string): Profile {
  let data: Record<string, unknown> = {}
  let body = markdown
  let flagsNode: unknown
  let document: YAML.Document | undefined
  if (FRONTMATTER_START.test(markdown)) {
    const match = FRONTMATTER.exec(markdown)
    if (!match) throw new Error("frontmatter is missing its closing delimiter")
    document = YAML.parseDocument(match[1] ?? "")
    if (document.errors.length > 0) throw document.errors[0]
    if (document.contents !== null) {
      const parsed = document
      data = Object.fromEntries(
        resolvedEntries(parsed.contents, parsed, "frontmatter", "key").map(([key, value]) => {
          if (key === "flags") flagsNode = value
          return [key, key === "flags" ? undefined : nodeValue(value, parsed)]
        }),
      )
    }
    body = markdown.slice(match[0].length).replace(/^(?:\r?\n)+/, "")
  }
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
    flags:
      flagsNode === undefined || !document
        ? {}
        : parseChildFlags(
            Object.fromEntries(
              resolvedEntries(flagsNode, document, "flags", "name").map(([name, value]) => [
                name,
                nodeValue(value, document!),
              ]),
            ),
            "flags",
          ),
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
