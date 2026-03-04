// backend/browser.ts
// Shared Puppeteer browser instance for HTML-to-Figma rendering.
// Lazily launches Chromium on first request, reuses across subsequent calls.

import puppeteer, { Browser, Page } from "puppeteer";

let _browser: Browser | null = null;
let _browserLaunchPromise: Promise<Browser> | null = null;

/**
 * Get or lazily create a shared Chromium browser instance.
 * Uses --no-sandbox flags for container environments (Render, Docker).
 */
async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.connected) return _browser;

  // Prevent concurrent launches
  if (_browserLaunchPromise) return _browserLaunchPromise;

  _browserLaunchPromise = puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",        // Use /tmp instead of shared memory
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
      "--font-render-hinting=none",
    ],
    // Lower memory: limit number of renderer processes
    protocolTimeout: 120_000, // 2 min timeout for protocol operations
  });

  _browser = await _browserLaunchPromise;
  _browserLaunchPromise = null;

  // Handle unexpected disconnects
  _browser.on("disconnected", () => {
    console.warn("[browser] Chromium disconnected, will re-launch on next request");
    _browser = null;
  });

  console.log("[browser] Chromium launched");
  return _browser;
}

/**
 * Create a new page with the given viewport size, render HTML content,
 * and return the page for DOM extraction.
 */
export async function renderHTMLPage(
  htmlContent: string,
  viewportWidth: number = 390,
  viewportHeight: number = 844
): Promise<Page> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  await page.setViewport({
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
  });

  // Load the HTML content
  await page.setContent(htmlContent, {
    waitUntil: "networkidle0",
    timeout: 30_000,
  });

  // Wait a short moment for any CSS to finish computing
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));

  return page;
}

/**
 * Gracefully close the shared browser instance.
 * Called on SIGTERM/SIGINT for clean shutdown.
 */
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    try {
      await _browser.close();
      console.log("[browser] Chromium closed");
    } catch (e: any) {
      console.warn("[browser] Error closing Chromium:", e.message);
    }
    _browser = null;
  }
}

// Register shutdown hooks
process.on("SIGTERM", async () => {
  console.log("[browser] SIGTERM received, closing Chromium...");
  await closeBrowser();
});

process.on("SIGINT", async () => {
  console.log("[browser] SIGINT received, closing Chromium...");
  await closeBrowser();
});
