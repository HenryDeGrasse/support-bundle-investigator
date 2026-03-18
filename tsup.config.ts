import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/run": "src/cli/run.ts",
    "tui/index": "src/tui/index.tsx",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
