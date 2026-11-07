import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { task } from "@trigger.dev/sdk";

// Minimal ambient shape for Node's `process` — the task executes on trigger.dev's
// Node machine, but this codebase type-checks against the Cloudflare Workers
// contract (`types: []`), so `process` is not globally declared. Do not widen
// this to @types/node; it would shadow the generated Workers types.
interface TriggerNodeEnv {
  process?: { env?: Record<string, string | undefined> };
}

const GROQ_API_KEY = (globalThis as TriggerNodeEnv).process?.env?.GROQ_API_KEY;

const groq = createOpenAICompatible({
  name: "groq",
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: GROQ_API_KEY ?? "",
});

const MODEL = "llama-3.3-70b-versatile";

export type TestGeneratePayload = { prompt: string };

export const testGenerateTask = task({
  id: "test-generate",
  maxDuration: 60,
  run: async (payload: TestGeneratePayload) => {
    // Uses the AI SDK (built-in fetch) against Groq's OpenAI-compatible API.
    // GROQ_API_KEY comes from the trigger.dev environment (.env for `trigger.dev dev`,
    // dashboard env vars for deployed environments).
    const { text } = await generateText({
      model: groq(MODEL),
      prompt: payload.prompt,
    });

    return { generated: text, model: MODEL };
  },
});
