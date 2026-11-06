// Capture the SQS tab (📬) from the mocked demo: DLQ 백로그가 있는 큐의 개요, 큐 흐름, 리전 지도, 메시지 받아 보기, 전체 재처리 미리 보기와 진행 중인 이동 작업.
// 큐 행은 이름 칸을 두 번 눌러 연다(행 가운데는 첫 클릭으로 열린 상세가 덮는다).
const pickQueue = (page, name) => page.getByRole('listbox', { name: '큐 목록' }).getByRole('option').filter({ hasText: name }).first().click();
const snap = async (page, path) => {
  await page.mouse.move(1270, 5);
  await page.screenshot({ path });
};
const detailTab = (page, name) => page.getByRole('tablist', { name: '큐 상세' }).getByRole('tab', { name }).click();

export async function shootSqs(page, out) {
  // 리소스 목록에서 큐를 열면 그 리전의 SQS 탭이 뜨고 그 큐가 골라진다
  await page.locator('.side .svc', { hasText: 'SQS' }).first().click();
  await page.locator('.side .typ', { hasText: 'Queues' }).first().click();
  await page.getByRole('row', { name: /^orders-queue\b/ }).getByRole('cell').first().dblclick();
  const detail = page.getByRole('region', { name: 'orders-queue' });
  await detail.getByRole('heading', { name: 'orders-queue' }).waitFor();
  await page.getByRole('region', { name: '진단' }).getByText(/DLQ `orders-dlq`에 12개/).waitFor();
  await page.locator('.metric-chart').first().waitFor();
  await page.waitForTimeout(600);
  await snap(page, `${out}/sqs-overview.png`);

  // 흐름: 생산자(SNS·다른 계정 SNS·EventBridge·정책이 막는 SNS) → 큐 → 소비자(Lambda), DLQ, 정책 문장
  await detailTab(page, '흐름');
  await page.getByRole('region', { name: '생산자' }).getByText('legacy-order-sync').waitFor();
  await page.getByRole('region', { name: '흐름 진단' }).getByText(/전송을 허용하지 않아요/).waitFor();
  await page.waitForTimeout(400);
  await snap(page, `${out}/sqs-flow.png`);

  // 리전 지도: SNS → 큐 → Lambda·Pipe, 큐 → DLQ(점선)
  await page.getByRole('group', { name: '보기' }).getByRole('button', { name: '지도', exact: true }).click();
  await page.getByRole('img', { name: '리전 흐름 지도' }).waitFor();
  await page.getByRole('button', { name: 'payments.fifo 열기' }).waitFor();
  await page.waitForTimeout(600);
  await snap(page, `${out}/sqs-map.png`);
  await page.getByRole('group', { name: '보기' }).getByRole('button', { name: '목록', exact: true }).click();

  // 메시지: orders-dlq에서 12개를 받아 SNS 봉투를 푼다
  await pickQueue(page, 'orders-dlq');
  await detailTab(page, '메시지');
  await page.getByRole('button', { name: '메시지 받아 보기…' }).click();
  await page.getByLabel('개수').fill('12');
  await page.getByLabel('보류 시간(초)').fill('300');
  await page.getByRole('button', { name: '미리 보기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'SQS 변경 미리보기' });
  await dialog.getByText('sqs:ReceiveMessage').waitFor();
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await page.getByRole('table').filter({ hasText: '본문 첫 줄' }).waitFor();
  await page.getByRole('table').filter({ hasText: '본문 첫 줄' }).getByRole('row').nth(1).click();
  await page.getByRole('button', { name: '풀어 보기' }).click();
  await page.getByText('SNS').first().waitFor();
  await page.locator('.sqs-msg-table').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(500);
  await snap(page, `${out}/sqs-messages.png`);

  // 전체 재처리 미리 보기: DLQ의 메시지를 원래 원본 큐로 되돌린다(이전 이동 작업은 아래 목록에 남아 있다)
  await detailTab(page, '개요');
  await page.getByRole('button', { name: '전체 재처리…' }).click();
  await page.getByRole('button', { name: '미리 보기', exact: true }).click();
  await page.getByRole('dialog', { name: 'SQS 변경 미리보기' }).getByText('sqs:StartMessageMoveTask').waitFor();
  await page.waitForTimeout(400);
  await snap(page, `${out}/sqs-redrive.png`);
  await page.getByRole('dialog', { name: 'SQS 변경 미리보기' }).getByRole('button', { name: '취소', exact: true }).click();

  // 진행 중인 이동 작업: emails-dlq가 원본 큐로 돌아가는 중
  await pickQueue(page, 'emails-dlq');
  await page.getByRole('region', { name: 'emails-dlq' }).getByText(/214개 이동/).waitFor();
  await page.waitForTimeout(400);
  await snap(page, `${out}/sqs-move.png`);
}
