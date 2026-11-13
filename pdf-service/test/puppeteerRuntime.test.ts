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

describe("Chrome launch flags", () => {
  // Chrome 152 crashes in single-process mode on the first render ("Target
  // closed"), which broke every PDF on staging.
  it("doesn't run Chrome in single-process or no-zygote mode", async () => {
    const { CHROME_ARGS } = await import("../src/browser");
    expect(CHROME_ARGS).not.toContain("--single-process");
    expect(CHROME_ARGS).not.toContain("--no-zygote");
    expect(CHROME_ARGS).toContain("--no-sandbox");
  });

  // Set PDF_TEST_CHROME to a Chrome for Testing executable to render a real
  // PDF with the service's flags (e.g. one installed with
  // `npx @puppeteer/browsers install chrome@<build>`). Skipped otherwise.
  it.skipIf(!process.env.PDF_TEST_CHROME)(
    "renders a PDF in a real Chrome with those flags",
    async () => {
      const { default: puppeteer } = await import("puppeteer-core");
      const { CHROME_ARGS } = await import("../src/browser");
      const browser = await puppeteer.launch({
        executablePath: process.env.PDF_TEST_CHROME,
        headless: true,
        args: CHROME_ARGS,
      });
      try {
        const page = await browser.newPage();
        await page.setContent("<h1>Invoice</h1>");
        const pdf = await page.pdf({ format: "Letter" });
        expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe("%PDF");
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
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
