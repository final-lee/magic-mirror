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
  // 토폴로지 그래프: 샤드·복제 노드와 클라이언트 호스트
  await page.getByRole('img', { name: '토폴로지' }).waitFor();
  await page.getByRole('group', { name: /클라이언트 기타/ }).waitFor();
  await page.getByRole('img', { name: '토폴로지' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/kv-topology.png` });
  // 클라이언트 지도: 호스트 → 연결 이름(BullMQ 연결은 큐 이름) → 노드
  await nav.getByRole('button', { name: /클라이언트/ }).click();
  await page.getByRole('table', { name: '클라이언트 목록' }).waitFor();
  await page.getByRole('button', { name: '지도', exact: true }).click();
  await page.getByRole('img', { name: '클라이언트 지도' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/kv-clients-map.png` });

  // 🐂 Bull: 큐 목록, 큐 상세(처리량·시간·실패 이유·작업 표), 실패한 작업 상세
  await nav.getByRole('button', { name: 'Bull', exact: true }).click();
  await page.getByRole('button', { name: 'webhooks 개요' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-bull.png` });
  // 큐 지도: 큐·부모→자식 연결·워커 호스트
  await page.getByRole('button', { name: '지도', exact: true }).click();
  await page.getByRole('img', { name: /큐 지도/ }).waitFor();
  await page.getByRole('group', { name: '워커 호스트 10.20.8.4' }).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/kv-bull-map.png` });
  await page.getByRole('button', { name: '카드', exact: true }).click();
  await page.getByRole('button', { name: 'webhooks 개요' }).click();
  await page.getByRole('table', { name: '작업 표' }).waitFor();
  await page.getByRole('img', { name: /최근 24시간/ }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-bull-queue.png` });
  // 상태 전이: 6시간 구간은 스트림이 잘려 있어 그 안내가 붙는다
  await page.getByRole('group', { name: '구간' }).getByRole('button', { name: '6시간' }).click();
  await page.getByRole('img', { name: '상태 전이' }).waitFor();
  await page.getByText(/스트림에 남은 최근/).waitFor();
  await page.locator('.kv-transitions').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/kv-bull-transitions.png` });
  await page.getByRole('table', { name: '작업 표' }).getByRole('button', { name: '90412' }).click();
  await page.getByRole('complementary', { name: '상세' }).getByRole('list', { name: '시간선' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/kv-bull-job.png` });

  // 작업 흐름: notifications 큐의 자식을 기다리는 작업에서 [크게 보기]
  await page.getByRole('button', { name: /큐 목록/ }).click();
  await page.getByRole('button', { name: 'notifications 개요' }).click();
  await page.getByRole('group', { name: '상태별 작업 수' }).getByRole('button', { name: /^자식 기다림/ }).click();
  await page.getByRole('table', { name: '작업 표' }).getByRole('button').first().click();
  const flowButton = page.getByRole('button', { name: '크게 보기' });
  await flowButton.scrollIntoViewIfNeeded();
  await flowButton.click();
  await page.getByRole('dialog', { name: /흐름 그래프/ }).getByRole('img', { name: '작업 흐름 그래프' }).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/kv-bull-flow.png` });

  // ⚡ rate-limit: 기억한 로그인이 없어 사용자 목록이 있는 로그인 화면이 뜬다
  await openRow(page, 'rate-limit');
  await page.getByRole('heading', { name: '로그인' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/kv-login.png` });
}
