import { task } from "@trigger.dev/sdk";

export const echoTask = task({
  id: "echo-task",
  maxDuration: 60,
  run: async (payload: { message: string }) => {
    return {
      ok: true,
      echoed: payload.message,
      receivedAt: new Date().toISOString(),
    };
  },
});
