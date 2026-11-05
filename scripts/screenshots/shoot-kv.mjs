// Capture the Valkey·Redis (ElastiCache) tab from the mocked demo: key tree + value, overview, login prompt, 🐂 Bull queues.
// 첫 칸(이름)을 두 번 누른다: 행 가운데는 첫 클릭으로 열린 상세가 덮는다.
const dblclickRow = (page, name) => page.getByRole('row', { name: new RegExp(`^${name}\\b`) }).getByRole('cell').first().dblclick();
async function openRow(page, name) {
  await page.getByRole('tab', { name: '리소스', exact: true }).click();
  await dblclickRow(page, name);
}

// 값 상세가 목록의 70%를 덮으므로 폴더는 왼쪽의 이름을 눌러 연다
const toggleFolder = (page, name) => page.getByRole('treeitem', { name }).first().locator('.kv-label').click();

export async function shootKv(page, out) {
  // ⚡ sessions: 키 트리와 해시 값
  await page.locator('.side .svc', { hasText: 'ElastiCache' }).first().click();
  await page.locator('.side .typ', { hasText: 'Replication Groups' }).click();
  await dblclickRow(page, 'sessions');
  await page.getByRole('tree', { name: '키 목록' }).waitFor();
  await toggleFolder(page, /^session\b/);
  await toggleFolder(page, /^2026\b/);
  await page.getByRole('treeitem', { name: /^u-48000\b/ }).locator('.kv-label').click();
  await page.getByRole('complementary', { name: '상세' }).getByRole('table', { name: '해시 필드' }).waitFor();
  // 값이 열린 채로 다른 폴더도 펴 보인다
  await toggleFolder(page, /^2026\b/);
  for (const folder of [/^cache\b/, /^ratelimit\b/, /^lock\b/]) await toggleFolder(page, folder);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-keys.png` });

  // ⚡ cart: 샤드 3개 클러스터 개요
  await openRow(page, 'cart');
  const nav = page.getByRole('navigation', { name: 'Valkey·Redis 메뉴' });
  await nav.getByRole('button', { name: '개요', exact: true }).click();
  await page.getByRole('table', { name: '노드' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-overview.png` });

  // 🐂 Bull: 큐 목록, 큐 상세(처리량·시간·실패 이유·작업 표), 실패한 작업 상세
  await nav.getByRole('button', { name: 'Bull', exact: true }).click();
  await page.getByRole('button', { name: 'webhooks 개요' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-bull.png` });
  await page.getByRole('button', { name: 'webhooks 개요' }).click();
  await page.getByRole('table', { name: '작업 표' }).waitFor();
  await page.getByRole('img', { name: /최근 24시간/ }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-bull-queue.png` });
  await page.getByRole('table', { name: '작업 표' }).getByRole('button', { name: '90412' }).click();
  await page.getByRole('complementary', { name: '상세' }).getByRole('list', { name: '시간선' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-bull-job.png` });

  // ⚡ rate-limit: 기억한 로그인이 없어 사용자 목록이 있는 로그인 화면이 뜬다
  await openRow(page, 'rate-limit');
  await page.getByRole('heading', { name: '로그인' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/kv-login.png` });
}
