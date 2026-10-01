import { test, expect } from "@playwright/test";


test.describe("smart search ranks plain-language needs", () => {
  test("engine understands descriptions, typos and ignores noise", async ({ page }) => {
    await page.goto("/search.html");
    const out = await page.evaluate((src) => {
      const mk = new Function("return " + src)();
      const list = [
        mk(1, "Fiber Laser Cutting Machine", "Machinery & Industrial Equipment", "Cutting Machines", "CNC fiber laser for steel sheet"),
        mk(2, "Ladies Innerwear Set", "Textile & Apparel", "Garments", "cotton bras panties women"),
        mk(3, "Submersible Water Pump", "Pumps, Hydraulics & Pneumatics", "Pumps", "pump for borewell water"),
        mk(4, "HDPE Water Pipe", "Pipes, Tubes & Valves", "HDPE Pipes", "water supply pipe"),
      ];
      const top = (q) => SmartSearch.rank(list, q).results.map((r) => r.item.id);
      return { cut: top("machine to cut metal sheets"), intimates: top("women intimates"), pump: top("something to lift water from borewell"), typo: top("submersable pump"), none: top("zzzz qqqq") };
    }, "(id,name,category,sub,desc)=>({id,name,type:'product',category,subcategories:[sub],desc,tags:[category,sub],country:'India',city:'Delhi',supplierName:'Acme'})");
    expect(out.cut[0]).toBe(1);
    expect(out.intimates[0]).toBe(2);
    expect(out.pump[0]).toBe(3);
    expect(out.typo[0]).toBe(3);
    expect(out.none).toEqual([]);
  });

  test("search page shows best matches and a post-requirement link when nothing matches", async ({ page }) => {
    await page.goto("/search.html?q=" + encodeURIComponent("zzzz qqqq"));
    await expect(page.locator("a", { hasText: "Post your requirement" }).first()).toBeVisible();
    await page.locator("a", { hasText: "Post your requirement" }).first().click();
    await expect(page).toHaveURL(/requirement\.html\?title=zzzz/);
    await expect(page.locator("#reqTitle")).toHaveValue("zzzz qqqq");
  });
});
