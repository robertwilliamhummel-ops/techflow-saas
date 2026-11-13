import puppeteer, { type Browser } from "puppeteer-core";

// Single browser instance reused across requests. Cloud Run keeps one Node
// process per container; opening a new browser per render is ~500ms wasted.
let browserPromise: Promise<Browser> | null = null;

export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser();
  }
  return browserPromise;
}

// No --single-process or --no-zygote: Chrome doesn't support single-process
// mode, and Chrome 152 crashes in it on the first render ("Target closed",
// SIGTRAP), which broke every PDF on staging. The remaining flags are the
// usual ones for a container: no setuid sandbox, /tmp instead of a small
// /dev/shm, no GPU.
export const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

async function launchBrowser(): Promise<Browser> {
  // The Dockerfile installs the Chrome for Testing build this puppeteer-core
  // release is tested against and links it here (U-02).
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/local/bin/chrome";
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: CHROME_ARGS,
  });
  // If Chrome dies (OOM, crash) drop the cached promise so the next call relaunches.
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const b = await browserPromise;
  browserPromise = null;
  await b.close().catch(() => undefined);
}
