import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { join, resolve } from "node:path"

export function agentDirectory(): string {
  return resolve(getAgentDir())
}

export function subaDirectory(): string {
  return join(agentDirectory(), "suba")
}

export function artifactDirectory(): string {
  return process.env.SUBA_ARTIFACT_ROOT?.trim()
    ? resolve(process.env.SUBA_ARTIFACT_ROOT)
    : join(subaDirectory(), "artifacts")
}
