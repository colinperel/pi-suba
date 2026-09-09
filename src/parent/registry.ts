import { existsSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { subaDirectory } from "../shared/paths.ts"
import type { ChildActivity, Placement, ThinkingLevel } from "../shared/protocol.ts"
import type { AllowedToolPolicy } from "../shared/profiles.ts"
import type { WorkmuxWorktree } from "../shared/workmux.ts"

export type RegistryState =
  | "launching"
  | "running"
  | "awaiting-parent"
  | "completed"
  | "failed"
  | "interrupted"
  | "orphaned"
export interface ResolvedLaunch {
  profile: string
  tools: AllowedToolPolicy
  loadContext: boolean
  loadSkills: boolean
  systemPrompt: "append" | "replace"
  autoComplete: boolean
  model?: string
  thinking?: ThinkingLevel
}
export interface ChildRecord {
  id: string
  revision: number
  state: RegistryState
  sessionFile: string
  artifactDir: string
  paneId?: string
  windowId?: string
  placement: Placement
  name: string
  cwd: string
  worktree?: WorkmuxWorktree
  profile: string
  resolvedLaunch: ResolvedLaunch
  lastEventSequence: number
  startedAt: number
  resultAfterEntry: number
  result?: string
  error?: string
  activity?: ChildActivity
  activityError?: string
}

export function resolveStoredArtifactPaths(
  record: ChildRecord,
  root = subaDirectory(),
  exists: (path: string) => boolean = existsSync,
): ChildRecord {
  if (exists(record.artifactDir)) return record
  const stored = relative(root, record.artifactDir)
  if (
    !stored ||
    stored === ".." ||
    stored.startsWith(`..${sep}`) ||
    isAbsolute(stored) ||
    stored.split(sep).length !== 2
  )
    return record
  const artifactDir = join(root, "artifacts", stored)
  if (!exists(artifactDir)) return record
  const sessionRelative = relative(record.artifactDir, record.sessionFile)
  const sessionFile =
    sessionRelative === ".." ||
    sessionRelative.startsWith(`..${sep}`) ||
    isAbsolute(sessionRelative)
      ? record.sessionFile
      : join(artifactDir, sessionRelative)
  return { ...record, artifactDir, sessionFile }
}

export function restoreRegistry(entries: readonly unknown[]): Map<string, ChildRecord> {
  const records = new Map<string, ChildRecord>()
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: unknown }
    if (
      entry.type !== "custom" ||
      entry.customType !== "suba-child" ||
      !entry.data ||
      typeof entry.data !== "object"
    )
      continue
    const record = entry.data as ChildRecord
    if (!record.id || !Number.isInteger(record.revision)) continue
    const previous = records.get(record.id)
    if (!previous || record.revision > previous.revision)
      records.set(record.id, resolveStoredArtifactPaths(structuredClone(record)))
  }
  return records
}

export function nextRevision(record: ChildRecord, patch: Partial<ChildRecord>): ChildRecord {
  return { ...record, ...patch, revision: record.revision + 1 }
}

export function isResumable(
  record: ChildRecord,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return (
    !isLive(record) &&
    (!record.worktree ||
      (exists(record.worktree.worktreePath) && exists(record.worktree.workingDirectory)))
  )
}

export function isLive(record: ChildRecord): boolean {
  return (
    record.state === "launching" || record.state === "running" || record.state === "awaiting-parent"
  )
}
