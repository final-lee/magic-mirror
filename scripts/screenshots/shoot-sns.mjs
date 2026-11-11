import { resolve } from 'node:path';

// SNS 주제와 계정 화면을 시스템 테마 양쪽에서 찍는다.
export async function shootSns(page, out) {
  const readme = resolve(out) === resolve('docs/screenshots');
  for (const theme of readme ? ['dark'] : ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme });
    if (theme === 'light') await page.reload();
    await page.locator('.side .svc', { hasText: /SNS/ }).first().click();
    await page.locator('.side .typ', { hasText: 'Topics' }).click();
    await page.getByRole('row', { name: /^orders-events\.fifo/ }).getByRole('cell').first().dblclick();
    const nav = page.getByRole('navigation', { name: 'SNS 메뉴' });
    await nav.waitFor();
    const shot = async (name) => {
      if (readme && !['diagnosis', 'flow', 'account'].includes(name)) return;
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${out}/sns-${name}${readme ? '' : `-${theme}`}.png` });
    };
    await shot('overview');
    await nav.getByRole('button', { name: '구독', exact: true }).click();
    await shot('subscriptions');
    await nav.getByRole('button', { name: '배달 진단' }).click();
    await page.getByText('큐 정책이 없어 배달할 수 없어요').waitFor();
    await shot('diagnosis');
    await nav.getByRole('button', { name: '흐름 지도' }).click();
    await page.getByRole('img', { name: 'SNS 흐름 지도' }).waitFor();
    await shot('flow');
    await nav.getByRole('button', { name: '필터 시험' }).click();
    await page.getByLabel('속성 이름 1').fill('event_type');
    await page.getByLabel('속성 값 1').fill('order.created');
    await page.getByRole('button', { name: '시험', exact: true }).click();
    await page.getByText('order.created 일치').waitFor();
    await shot('filter');
    await nav.getByRole('button', { name: '정책·점검' }).click();
    await page.getByText('PartnerSubscribe').first().waitFor();
    await shot('policy');
    await nav.getByRole('button', { name: '큐 엿보기' }).click();
    await page.getByRole('button', { name: 'DLQ 엿보기…' }).click();
    await page.getByRole('button', { name: '엿보기 시작' }).click();
    await page.getByRole('article', { name: '메시지 sns-3' }).waitFor();
    await shot('peek');
    await nav.getByRole('button', { name: '배달 진단' }).click();
    const failure = page.locator('.sns-diagnosis-card', { hasText: '큐 정책이 없어 배달할 수 없어요' });
    await failure.locator('summary').click();
    await failure.getByRole('button', { name: /고치기/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '적용' }).waitFor();
    await shot('change');
    await page.getByRole('dialog').getByRole('button', { name: '취소' }).click();
    await page.getByRole('tab', { name: '리소스', exact: true }).click();
    await page.locator('.side .sns-open').click();
    const accountNav = page.getByRole('navigation', { name: 'SNS 계정 메뉴' });
    await accountNav.waitFor();
    await page.locator('.sns-tab:visible').getByRole('button', { name: 'orders-events.fifo', exact: true }).first().waitFor();
    await shot('account');
    await accountNav.getByRole('button', { name: /^점검/ }).click();
    await shot('account-checks');
    await page.getByRole('button', { name: '점검 항목…' }).click();
    await page.getByRole('dialog', { name: '점검 항목' }).waitFor();
    await shot('account-checks-sheet');
    await page.keyboard.press('Escape');
    await accountNav.getByRole('button', { name: /^정리할 구독/ }).click();
    await shot('account-cleanup');
    await accountNav.getByRole('button', { name: /^SMS·푸시/ }).click();
    await shot('account-messaging');
  }
}
