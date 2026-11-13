import { defineConfig } from "@trigger.dev/sdk";
import { playwright } from "@trigger.dev/build/extensions/playwright";

export default defineConfig({
  project: "proj_gpedixcvmqwidtgjqlxr",
  dirs: ["./src/trigger"],
  maxDuration: 60,
  build: {
    external: ["freehire-mcp"],
    extensions: [
      playwright({
        browsers: ["chromium"],
        headless: true,
      }),
    ],
  },
});
