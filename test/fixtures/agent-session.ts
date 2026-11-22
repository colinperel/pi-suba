import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type InlineExtension,
  type SessionManager,
} from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"

export const testModel: Model<"openai-completions"> = {
  id: "test",
  name: "test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 512,
}

export async function createTestAgentSession(
  sessionManager: SessionManager,
  settingsManager = SettingsManager.inMemory(),
  extensionFactories: InlineExtension[] = [],
) {
  const cwd = sessionManager.getCwd()
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories,
  })
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
  vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true)
  vi.spyOn(modelRuntime, "getAuth").mockResolvedValue(undefined)
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    agentDir: cwd,
    model: testModel,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager,
    noTools: "all",
  })
  return session
}
