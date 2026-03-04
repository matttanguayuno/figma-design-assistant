// backend/browser.ts
// Shared Puppeteer browser instance for HTML-to-Figma rendering.
// Lazily launches Chromium on first request, reuses across subsequent calls.
// In production (Render), uses @sparticuz/chromium which bundles a headless
// Chromium binary inside node_modules — no system Chrome needed.

import puppeteer, { Browser, Page } from "puppeteer-core";

let _browser: Browser | null = null;
let _browserLaunchPromise: Promise<Browser> | null = null;

/**
 * Resolve Chrome executable path.
 * 1. @sparticuz/chromium (self-contained, works on Render/Lambda/serverless)
 * 2. PUPPETEER_EXECUTABLE_PATH env var
 * 3. Common system Chrome locations (local dev)
 */
async function resolveChrome(): Promise<{ executablePath: string; args: string[] }> {
  // ---- Try @sparticuz/chromium first (production / cloud) ----
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    const executablePath = await chromium.executablePath();
    console.log("[browser] Using @sparticuz/chromium bundled browser");
    return {
      executablePath,
      args: chromium.args,           // optimised flags for headless environments
    };
  } catch (e: any) {
    console.log("[browser] @sparticuz/chromium not available, falling back to system Chrome");
  }

  // ---- Env-var override ----
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: defaultArgs(),
    };
  }

  // ---- Common local-dev paths ----
  const fs = require("fs");
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return { executablePath: c, args: defaultArgs() };
    } catch {}
  }

  throw new Error(
    "Chrome/Chromium not found. Install @sparticuz/chromium, set PUPPETEER_EXECUTABLE_PATH, or install Google Chrome."
  );
}

function defaultArgs(): string[] {
  return [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
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
  ];
}

/**
 * Get or lazily create a shared Chromium browser instance.
 * Uses --no-sandbox flags for container environments (Render, Docker).
 */
async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.connected) return _browser;

  // Prevent concurrent launches
  if (_browserLaunchPromise) return _browserLaunchPromise;

  const { executablePath, args } = await resolveChrome();
  console.log(`[browser] Using Chrome at: ${executablePath}`);

  _browserLaunchPromise = puppeteer.launch({
    headless: true,
    executablePath,
    args,
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
