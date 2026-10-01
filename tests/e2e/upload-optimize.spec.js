const { test, expect } = require("@playwright/test");
const { optimizeFile, sniff } = require("../../upload-optimize");
const fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
let sharp; try { sharp = require("sharp"); } catch {}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "opt-"));
const mk = (p, mimetype) => ({ path: p, mimetype, size: fs.statSync(p).size, originalname: path.basename(p), filename: path.basename(p) });

test("large image is resized to a much smaller WebP", async () => {
  test.skip(!sharp, "sharp not installed");
  const d = tmp(), p = path.join(d, "a.png");
  await sharp({ create: { width: 3200, height: 2400, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png().toFile(p);
  const f = mk(p, "image/png"), before = f.size;
  await optimizeFile(f);
  expect(f.mimetype).toBe("image/webp"); expect(f.size).toBeLessThan(before / 3); expect(sniff(f.path)).toBe("webp");
  expect(fs.existsSync(p)).toBe(false);
});
test("file whose content does not match its declared type is rejected", async () => {
  const d = tmp(), p = path.join(d, "x.pdf"); fs.writeFileSync(p, "hello not a pdf");
  await expect(optimizeFile(mk(p, "application/pdf"))).rejects.toThrow(/allowed/);
});
test("declared image type must match real content", async () => {
  test.skip(!sharp, "sharp not installed");
  const d = tmp(), p = path.join(d, "a.jpg"); await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).png().toFile(p);
  await expect(optimizeFile(mk(p, "image/jpeg"))).rejects.toThrow(/does not match/);
});
test("never grows a file and keeps tiny originals valid", async () => {
  test.skip(!sharp, "sharp not installed");
  const d = tmp(), p = path.join(d, "t.png"); await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toFile(p);
  const f = mk(p, "image/png"), before = f.size; await optimizeFile(f); expect(f.size).toBeLessThanOrEqual(before);
});
