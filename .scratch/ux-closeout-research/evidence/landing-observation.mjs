import { chromium } from "/home/developer/Documents/dev/hepi-harness/.dev/worktrees/client-app-integration/apps/web/node_modules/playwright/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
const out = new URL("./", import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const observations = [];
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    const failures = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    const response = await page.goto("http://192.0.2.10:30141/", { waitUntil: "networkidle", timeout: 20000 });
    await page.screenshot({ path: new URL(name + ".png", out).pathname, fullPage: true });
    observations.push({ name, viewport, status: response?.status(), title: await page.title(), bodyText: (await page.locator("body").innerText()).slice(0, 5000), errors, failures, horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile(new URL("landing-observation.json", out), JSON.stringify({ observedAt: new Date().toISOString(), release: "release-1873d24", authenticated: false, observations }, null, 2));
console.log(JSON.stringify(observations, null, 2));
