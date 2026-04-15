import { defineConfig } from "vitest/config";

export default defineConfig({
  css: {
    postcss: { plugins: [] },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    fileParallelism: false,
  },
});
