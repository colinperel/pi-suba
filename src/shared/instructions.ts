import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { subaDirectory } from "./paths.ts"

export async function loadInstructions(
  path = join(subaDirectory(), "instructions.md"),
): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw new Error(
      `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
