// Capture the DynamoDB tab from the mocked demo: overview with findings, a Query on the items tab, the single-table design analysis, and the stream connections.
const detailTab = (page, name) => page.getByRole('tablist', { name: '테이블 상세' }).getByRole('tab', { name, exact: true });

export async function shootDynamo(page, out) {
  // 리소스 목록: 테이블 행을 두 번 눌러 DynamoDB 탭을 연다(첫 칸을 누른다: 행 가운데는 첫 클릭으로 열린 상세가 덮는다)
  await page.locator('.side .svc', { hasText: 'DynamoDB' }).first().click();
  await page.locator('.side .typ', { hasText: 'Tables' }).click();
  await page.getByRole('row', { name: /^shop-main\b/ }).getByRole('cell').first().dblclick();
  await page.getByRole('region', { name: '테이블 목록' }).waitFor();

  // 개요: 키 · 인덱스 · 설정 · 건강 진단, 아래로 지표와 상위 키
  const findings = page.getByRole('region', { name: '건강 진단' });
  await findings.getByText(/GSI1`이 쓰기를 따라가지 못해요/).waitFor();
  await findings.getByText(/실패 대상이 없고/).waitFor();
  await page.getByRole('region', { name: 'CloudWatch 지표' }).getByRole('heading', { name: /ConsumedReadCapacityUnits/ }).waitFor();
  await page.getByRole('region', { name: '상위 키(최근 1시간)' }).getByText('PRODUCT#TS-0042').first().waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/dynamo-overview.png` });
  // 건강 진단 · 지표 · 상위 키: 진단 카드를 맨 위로 끌어올려 찍는다
  await findings.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/dynamo-health.png` });

  // 아이템: Query로 한 사용자의 주문만 읽는다(PK = USER#u-1001, SK begins_with ORDER#)
  await detailTab(page, '아이템').click();
  await page.getByLabel('읽기 방식').selectOption('query');
  await page.getByLabel(/^PK \(S\)/).fill('USER#u-1001');
  await page.getByLabel(/^SK 조건/).selectOption('begins_with');
  await page.getByLabel('정렬 키 값').fill('ORDER#');
  await page.getByRole('button', { name: '읽기', exact: true }).click();
  await page.getByText(/^Count 7/).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/dynamo-items.png` });

  // 설계: Scan 첫 페이지와 다음 페이지로 표본을 모으면 엔티티, 인덱스별 접근 패턴, 진단이 나온다
  await page.getByLabel('읽기 방식').selectOption('scan');
  await page.getByRole('button', { name: /^(Scan 첫 페이지|읽기)$/ }).click();
  await page.getByText(/^Count 24/).waitFor();
  const next = page.getByRole('button', { name: '다음 페이지' });
  await next.click();
  await page.getByText(/^Count 11/).waitFor();
  await detailTab(page, '설계').click();
  await page.getByRole('heading', { name: '엔티티' }).waitFor();
  await page.getByText(/^35개 아이템/).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/dynamo-design.png` });
  // 인덱스별 접근 패턴(희소 · 겹친 인덱스)과 진단(TTL, 타입 섞임, 버전 속성)
  await page.getByRole('heading', { name: '인덱스와 접근 패턴' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/dynamo-design-patterns.png` });

  // 스트림: 연결 그림(Lambda 매핑 둘, Pipe, Kinesis, 글로벌 테이블 복제본)과 연결 진단
  await detailTab(page, '스트림').click();
  await page.getByText('Lambda shop-order-projector').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/dynamo-stream.png` });
  // 실시간 레코드: 읽기를 시작하고 변경 레코드 하나를 펼쳐 이전·새 이미지를 맞대 본다
  await page.getByRole('button', { name: '읽기 시작' }).click();
  await page.locator('.ddb-stream-record').first().waitFor();
  await page.locator('.ddb-stream-record summary').nth(1).click();
  await page.getByRole('heading', { name: '실시간 레코드' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/dynamo-stream-live.png` });
}
