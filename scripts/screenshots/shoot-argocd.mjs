// Capture the ArgoCD views from the mocked demo.
export async function shootArgocd(page, out) {
  await page.locator('.side .svc', { hasText: 'EKS' }).first().click();
  await page.locator('.side .typ', { hasText: 'ArgoCD' }).click();
  await page.getByRole('row', { name: /checkout-prd/ }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/argocd.png` });
  await page.getByRole('row', { name: /checkout-prd/ }).click();
  await page.getByRole('complementary', { name: 'Application 상세' }).waitFor();
  await page.getByRole('tab', { name: '리소스', exact: true }).last().click();
  await page.getByRole('tree').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/argocd-detail.png` });
  await page.getByRole('button', { name: /Deployment checkout checkout/ }).click();
  await page.getByRole('region', { name: '리소스 상세' }).getByRole('tab', { name: 'Diff' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/argocd-resource.png` });
  await page.getByRole('complementary', { name: 'Application 상세' }).getByRole('tab', { name: 'Diff', exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/argocd-diff.png` });
  await page.getByRole('tab', { name: '지도', exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/argocd-maps.png` });
}

export async function shootArgowf(page, out) {
  await page.locator('.side .svc', { hasText: 'EKS' }).first().click();
  await page.locator('.side .typ', { hasText: 'Argo Workflows' }).click();
  await page.getByText('etl-orders-q9m3c', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/argowf.png` });
  await page.getByText('etl-orders-q9m3c', { exact: true }).click();
  await page.getByRole('tab', { name: '그래프', exact: true }).click();
  await page.getByRole('button', { name: '세로', exact: true }).click();
  await page.getByRole('button', { name: '축소' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/argowf-graph.png` });
}
