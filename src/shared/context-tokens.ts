/** Pi normalizes input, cacheRead and cacheWrite into disjoint token buckets. */
export function requestContextTokens(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined
  const value = message as { role?: string; usage?: Record<string, unknown> }
  if (value.role !== "assistant" || !value.usage) return undefined
  const parts = [value.usage.input, value.usage.cacheRead, value.usage.cacheWrite]
  if (!parts.every((part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0))
    return undefined
  const total = (parts as number[]).reduce((sum, part) => sum + part, 0)
  // Providers initialize usage to zero even when no usage was received.
  return Number.isSafeInteger(total) && total > 0 ? total : undefined
}

export function latestRequestContextTokens(entries: readonly unknown[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as { type?: string; message?: unknown }
    if (entry?.type !== "message") continue
    const tokens = requestContextTokens(entry.message)
    if (tokens !== undefined) return tokens
  }
  return undefined
}

export function formatRequestContext(tokens: number | undefined): string {
  return tokens === undefined
    ? "Last request context: unavailable"
    : `Last request context: ${tokens.toLocaleString("en-US")} tokens, including cached input`
}
