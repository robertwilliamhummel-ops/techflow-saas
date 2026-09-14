// U-02 — puppeteer-core 25 ships ESM only. The service compiles to CommonJS,
// so it loads puppeteer-core through Node's require(esm). This runs Node the way
// the compiled service does (tsc's default-import interop) and checks the
// pinned Chrome build the Dockerfile installs is readable the same way.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

function runCjs(script: string): string {
  return execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

describe("puppeteer-core under CommonJS (U-02)", () => {
  it("exposes launch through tsc's default-import interop", () => {
    const out = runCjs(
      [
        "const mod = require('puppeteer-core');",
        "const interop = mod && mod.__esModule ? mod : { default: mod };",
        "process.stdout.write(typeof interop.default.launch);",
      ].join(" "),
    );
    expect(out).toBe("function");
  });

  it("reports the Chrome for Testing build the Dockerfile installs", () => {
    const build = runCjs(
      "process.stdout.write(require('puppeteer-core/internal/revisions.js').PUPPETEER_REVISIONS.chrome)",
    );
    expect(build).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("Dockerfile browser install (U-02)", () => {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  // Instructions only — comments may explain what was replaced.
  const instructions = dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const browserTs = readFileSync(path.join(ROOT, "src", "browser.ts"), "utf8");

  it("installs Chrome for Testing pinned to puppeteer-core's revision", () => {
    expect(instructions).toContain("PUPPETEER_REVISIONS.chrome");
    expect(instructions).toMatch(/@puppeteer\/browsers[^\n]*install[^\n]*chrome@/);
    expect(instructions).not.toContain("google-chrome-stable");
  });

  it("points Puppeteer at the same executable browser.ts falls back to", () => {
    expect(dockerfile).toContain("ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome");
    expect(browserTs).toContain('"/usr/local/bin/chrome"');
  });
});
