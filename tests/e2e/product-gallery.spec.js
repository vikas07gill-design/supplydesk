import { test, expect } from "@playwright/test";
import fs from "fs";
// Product photo carousel: one photo at a time, arrows / dots / keyboard, no horizontal page scroll.
const SCRATCH = process.env.GALLERY_SHOT_DIR || "";
const img = (c) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'><rect width='600' height='400' fill='${c}'/></svg>`)}`;
const product = (n) => ({ id: "11111111-1111-4111-8111-111111111111", name: "Gallery Crate", capabilityCode: "SD-TST-0001", category: "Plastics & Polymers", subcategory: "Containers", market_scope: "Both", country: "India", region: "Gujarat", description: "Test", images: ["#d33", "#3a5", "#35d"].slice(0, n).map((c, i) => ({ id: "i" + i, url: img(c) })) });

async function open(page, n) {
  await page.route("**/api/products/11111111-1111-4111-8111-111111111111", (r) => r.fulfill({ json: { product: product(n) } }));
  await page.goto("/product.html?id=11111111-1111-4111-8111-111111111111");
  await expect(page.locator("#gallery .slide")).toHaveCount(n);
}

test("carousel shows one photo at a time and moves with arrows, dots and keys", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await open(page, 3);
  await expect(page.locator(".gcount")).toHaveText("1 / 3");
  await expect(page.locator(".gnav.prev")).toBeDisabled();
  const g = await page.locator("#gallery").boundingBox();
  const s0 = await page.locator("#gallery .slide").first().boundingBox();
  expect(Math.abs(s0.width - g.width)).toBeLessThan(2); // exactly one slide fills the frame
  await page.click(".gnav.next");
  await expect(page.locator(".gcount")).toHaveText("2 / 3");
  await page.click(".gdots button >> nth=2");
  await expect(page.locator(".gcount")).toHaveText("3 / 3");
  await expect(page.locator(".gnav.next")).toBeDisabled();
  await page.locator("#gallery").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".gcount")).toHaveText("2 / 3");
  // native scrollbar is hidden and the page itself does not scroll sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (SCRATCH) { fs.mkdirSync(SCRATCH, { recursive: true }); await page.screenshot({ path: SCRATCH + "/gallery-desktop.png" }); }
});

test("single photo has no arrows; phone width works", async ({ page }) => {
  await open(page, 1);
  await expect(page.locator(".gnav")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(page.locator("#gallery .slide")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("phone: swipe-style scroll lands on a whole photo", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page, 3);
  await page.click(".gnav.next");
  await expect(page.locator(".gcount")).toHaveText("2 / 3");
  const g = await page.locator("#gallery").boundingBox();
  const s1 = await page.locator("#gallery .slide >> nth=1").boundingBox();
  await expect.poll(async () => Math.abs((await page.locator("#gallery .slide >> nth=1").boundingBox()).x - g.x)).toBeLessThan(3);
  if (SCRATCH) await page.screenshot({ path: SCRATCH + "/gallery-phone.png" });
});
