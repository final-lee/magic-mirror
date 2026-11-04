export async function shootPg(page, out) {
  await page.locator('.side .svc', { hasText: 'RDS' }).first().click();
  await page.locator('.side .typ', { hasText: 'DB Clusters' }).click();
  await page.getByText('orders-db', { exact: true }).dblclick();
  await page.getByRole('table', { name: '역할 목록' }).waitFor();
  await page.getByRole('row', { name: /iam_admin/ }).click();
  await page.screenshot({ path: `${out}/pg-roles.png` });
  await page.locator('.iam-nav-item', { hasText: '권한' }).first().click();
  await page.getByRole('grid', { name: '권한 표' }).waitFor();
  await page.getByRole('button', { name: /^alice · orders:/ }).click();
  await page.getByRole('complementary', { name: 'alice · orders' }).waitFor();
  await page.getByText('orders.customers').waitFor();
  await page.screenshot({ path: `${out}/pg-privileges.png` });
  await page.getByRole('button', { name: '바꾸기', exact: true }).last().click();
  await page.getByRole('button', { name: /^analytics_reader · analytics:/ }).click();
  await page.getByRole('button', { name: '미리보기', exact: true }).click();
  await page.getByRole('list', { name: '실행할 SQL' }).waitFor();
  await page.screenshot({ path: `${out}/pg-preview.png` });
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '모두 취소' }).click();
  await page.getByRole('button', { name: '바꾸기', exact: true }).last().click();
  await page.locator('.iam-nav-item', { hasText: '점검' }).click();
  await page.getByRole('table', { name: 'rds_superuser 멤버' }).waitFor();
  await page.screenshot({ path: `${out}/pg-findings.png` });
}
