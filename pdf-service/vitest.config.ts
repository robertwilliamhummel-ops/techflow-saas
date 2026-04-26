import { defineConfig } from "vitest/config";

export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
