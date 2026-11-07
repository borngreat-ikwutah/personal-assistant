import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { testGenerateTask } from "../../trigger/test-generate";

// Type-only import (erased) — the runtime SDK value imports are lazy, inside the
// handler, so loading this module (e.g. `hono routes`) never pulls the trigger
// SDK bundle into the worker. Keep it this way.
const querySchema = z.object({
  prompt: z.string().min(1).max(2000),
});

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Temporary public test endpoint (to be removed): triggers the AI generation task
 * and waits for the result via run polling.
 */
export const testGenerateRoutes = new Hono<{ Bindings: Env }>()
  .get('/ai/test', zValidator('query', querySchema), async (c) => {
    const { prompt } = c.req.valid('query');

    const { tasks, runs } = await import("@trigger.dev/sdk");

    // `#test-generate` maps to src/trigger/test-generate.ts (trailing-slash-free id).
    const handle = await tasks.trigger<typeof testGenerateTask>("test-generate", {
      prompt,
    });

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const run = await runs.retrieve(handle);
      if (run.status === "COMPLETED" && run.output) {
        return c.json({
          ok: true as const,
          runId: handle.id,
          generated: run.output.generated,
          model: run.output.model,
        });
      }
      if (run.status === "CRASHED" || run.status === "SYSTEM_FAILURE" || run.status === "EXPIRED") {
        return c.json(
          { ok: false as const, runId: handle.id, status: run.status, error: "generation failed" },
          502,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return c.json(
      { ok: false as const, runId: handle.id, status: "PENDING-POLL-TIMEOUT", error: "run did not finish within 60s" },
      504,
    );
  });
