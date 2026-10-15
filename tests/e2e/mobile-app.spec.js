const { test, expect } = require("@playwright/test");
const fs = require("fs"), path = require("path");

test("source, tests, uploads and the app project are not downloadable from the website", async ({ request }) => {
  for (const p of ["/server.js", "/rfq.js", "/upload-optimize.js", "/taxonomy.js", "/tests/e2e/pay.js", "/mobile/package.json", "/mobile/android/app/build.gradle", "/pw.local.config.mjs", "/playwright.config.js", "/DATABASE_ARCHITECTURE.md", "/private-uploads/anything", "/package.json", "/database/schema.sql"]) {
    expect((await request.get(p)).status(), p).toBe(404);
  }
  expect((await request.get("/index.html")).status()).toBe(200);
  expect((await request.get("/assets/native-app.js")).status()).toBe(200);
});

test("the app helper does nothing in a normal browser; adds safe-area styles inside the app", async ({ page }) => {
  await page.goto("/explore.html");
  expect(await page.evaluate(() => document.documentElement.classList.contains("native-app"))).toBe(false);
  await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: {} }; });
  await page.goto("/explore.html");
  await expect(page.locator("html.native-app.native-ios")).toHaveCount(1);
  expect(await page.evaluate(() => [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.cssText.includes("safe-area-inset-top")); } catch { return false; } }))).toBe(true);
});

test("every page loads the app helper and allows the notch (viewport-fit=cover)", async () => {
  const root = path.join(__dirname, "..", "..");
  for (const f of fs.readdirSync(root).filter(x => x.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(root, f), "utf8");
    expect(html, f).toContain("assets/native-app.js");
    expect(html, f).toContain("viewport-fit=cover");
  }
});

test("app config points at supplydesk.in, has offline fallback and store-ready ids", async () => {
  const dir = path.join(__dirname, "..", "..", "mobile");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "capacitor.config.json"), "utf8"));
  expect(cfg.appId).toBe("in.supplydesk.app");
  expect(cfg.server.url).toBe("https://supplydesk.in");
  expect(cfg.server.cleartext).toBe(false);
  expect(cfg.server.allowNavigation).toContain("supplydesk.in");
  for (const f of ["www/index.html", "www/offline.html", "www/logo.svg", "resources/icon.png", "resources/splash.png"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
  const manifest = fs.readFileSync(path.join(dir, "android/app/src/main/AndroidManifest.xml"), "utf8");
  expect(manifest).toContain("android.permission.INTERNET");
  const ios = fs.readFileSync(path.join(dir, "ios/App/App/Info.plist"), "utf8");
  expect(ios).toContain("SupplyDesk");
});
