import { chromium } from "playwright-core";
import { shootK8s } from "./shoot-k8s.mjs";
import { shootArgocd, shootArgowf } from "./shoot-argocd.mjs";
import { shootPg } from "./shoot-pg.mjs";
import { shootKv } from "./shoot-kv.mjs";
// 사용: npm run dev 를 띄우고 `npm i --no-save playwright-core && node scripts/screenshots/shoot.mjs [폴더] [구역…]` (Google Chrome 필요)
// 구역을 주면 그 구역만 찍는다(예: `node scripts/screenshots/shoot.mjs /tmp/shots k8s`). 구역마다 데모 페이지를 새로 연다.
const OUT = process.argv[2] ?? "docs/screenshots";
const only = new Set(process.argv.slice(3));
const DEMO = "http://localhost:1420/scripts/screenshots/demo.html";

async function shootCore(page, out) {
  await page.locator(".side .typ", { hasText: "Instances" }).first().click();
  await page.getByText("web-1", { exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/resources.png` });

  await page.locator(".side .typ", { hasText: "Buckets" }).first().click();
  await page.getByText("prod-assets", { exact: true }).dblclick();
  const s3 = page.locator("[data-pane=s3]");
  await s3.getByText(/web$/).dblclick();
  await s3.getByText(/index\.html/).waitFor();
  const local = page.locator("[data-pane=local]");
  await local.getByText(/sitemap\.xml/).click();
  await page.getByRole("button", { name: "복사 →" }).click();
  await page.waitForTimeout(600);
  await local.getByText(/index\.html/).click();
  await s3.getByText(/index\.html/).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/explorer.png` });
  await page.getByRole("button", { name: /비교/ }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/diff.png` });
  await page.getByRole("tab", { name: "리소스" }).click();
  await page.locator(".side .svc", { hasText: "VPC" }).first().click();
  await page.locator(".side .typ", { hasText: "VPCs" }).first().click();
  await page.getByText("prod", { exact: true }).last().dblclick();
  await page.waitForTimeout(1200);
  await page.locator("svg text", { hasText: "prod-app-a" }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/vpc-map.png` });
  await page.getByRole("tab", { name: "리소스" }).click();
  await page.locator(".side .svc", { hasText: /IAM$/ }).first().click();
  await page.locator(".side .iam-open").click();
  await page.locator(".iam-nav-item", { hasText: "사용자" }).click();
  await page.getByRole("row", { name: /alice/ }).dblclick();
  await page.getByRole("button", { name: /^S3 쓰기/ }).click();
  await page.locator(".iam-drill .dr-item").first().waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/iam.png` });
  await page.locator(".iam-nav-item", { hasText: "할당" }).click();
  const cell = (row, column) => page.getByRole("button", { name: new RegExp(`^${row} · ${column}:`) });
  await cell("dana", "ReadOnlyAccess").click();
  await cell("data-eng", "app-deploy").click();
  await cell("svc-reporting", "ReadOnlyAccess").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/iam-assignments.png` });
  await page.locator(".iam-nav-item", { hasText: "누가 할 수 있나" }).click();
  await page.getByPlaceholder("s3:GetObject").fill("s3:DeleteObject");
  await page.getByRole("button", { name: "찾기", exact: true }).click();
  await page.getByText("허용", { exact: true }).first().waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/iam-whocan.png` });
  await page.getByRole("tab", { name: "리소스" }).click();
  await page.locator(".side .cost-open").click();
  await page.getByRole("table", { name: "비용 분해" }).waitFor();
  await page.getByLabel(/^10월 20일 /).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/cost.png` });

  // ⌘K: 지금까지 읽은 목록(이 리전)과 미리 넣어 둔 us-west-2의 오래된 목록에서 찾는다
  await page.getByRole("tab", { name: "리소스" }).click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("web");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/palette.png` });
  await page.keyboard.press("Escape");
}

const SECTIONS = { core: shootCore, k8s: shootK8s, argocd: shootArgocd, argowf: shootArgowf, pg: shootPg, kv: shootKv };

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [name, shoot] of Object.entries(SECTIONS)) {
    if (only.size > 0 && !only.has(name)) continue;
    const page = await browser.newPage({ viewport: { width: 1280, height: 780 }, deviceScaleFactor: 2, colorScheme: "dark" });
    page.on("console", (m) => m.type() === "error" && console.log(`${name} console:`, m.text()));
    page.on("pageerror", (e) => console.log(`${name} pageerror:`, e.message));
    await page.goto(DEMO);
    await shoot(page, OUT);
    await page.close();
    console.log(`${name}: done`);
  }
} finally {
  await browser.close();
}
