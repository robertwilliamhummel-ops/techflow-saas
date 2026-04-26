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

async function launchBrowser(): Promise<Browser> {
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/google-chrome-stable";
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ],
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
