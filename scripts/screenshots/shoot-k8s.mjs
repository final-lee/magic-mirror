// k8s 구역 스크린샷. page는 데모 페이지를 막 연 상태로 온다.
export async function shootK8s(page, out) {
  // 사이드바 EKS → Clusters에서 prod-apne2를 더블클릭해 EKS 탭을 연다
  await page.locator(".side .svc", { hasText: "EKS" }).first().click();
  await page.locator(".side .typ", { hasText: "Clusters" }).first().click();
  await page.getByText("prod-apne2", { exact: true }).first().dblclick();
  // 사용량 그래프(미리 채운 1시간치)와 최근 경고가 채워질 때까지
  await page.locator(".k8s-usage-chart svg polyline").first().waitFor({ state: "attached" });
  await page.locator(".k8s-overview table[aria-label] tbody tr").first().waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/eks-overview.png` });

  // 개요 아래쪽: 노드그룹·애드온(최신 버전)·업그레이드 점검. 세로로 길어 이 컷만 창을 키운다
  await page.setViewportSize({ width: 1280, height: 1060 });
  await page.locator(".k8s-body").evaluate((el) => {
    const sect = [...el.querySelectorAll(".k8s-sect")].find((s) => s.getAttribute("aria-label") === "노드그룹");
    el.scrollTop = sect.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/eks-upgrade.png` });

  // Pod 목록(commerce-prod) + 사용량 열의 작은 그래프, 메모리가 차오르는 Pod의 상세
  // 이름 열까지 보이게 이 컷만 창을 넓힌다
  await page.setViewportSize({ width: 1720, height: 940 });
  await page.locator(".k8s-bms .iam-nav-item", { hasText: /^\S*\s*Pod$/ }).click();
  const pod = page.getByText("orders-api-6d8f7b9c54-m2x7q", { exact: true });
  await pod.waitFor();
  await page.locator(".k8s-trend-line").first().waitFor();
  await page.waitForTimeout(400);
  // 문제가 있는 Pod가 위에 오게 상태로 정렬
  await page.getByRole("columnheader", { name: /^상태/ }).click();
  await pod.click();
  await page.locator(".k8s-detail .k8s-usage-chart svg polyline").first().waitFor({ state: "attached" });
  // 상세는 사용량 절까지 스크롤(목록은 왼쪽 그대로: 이름부터 %MEM/R 칸까지 보인다)
  await page.locator(".k8s-detail-body").evaluate((el) => {
    el.scrollTop += el.querySelector(".k8s-usage").getBoundingClientRect().top - el.getBoundingClientRect().top - 6;
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/eks-pods.png` });

  await page.setViewportSize({ width: 1280, height: 780 });
  // 로그는 넓게 봐야 하니 상세를 끌어서 넓힌다
  const grip = await page.locator(".k8s-detail-resizer").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 300);
  await page.mouse.down();
  await page.mouse.move(430, grip.y + 300, { steps: 8 });
  await page.mouse.up();

  // Deployment 상세의 로그 탭: 모든 Pod의 JSON 로그를 합쳐 본다
  await page.locator(".k8s-bms .iam-nav-item", { hasText: /^\S*\s*Deployment$/ }).click();
  await page.getByText("orders-api", { exact: true }).first().click();
  await page.getByRole("tab", { name: "로그" }).click();
  await page.locator(".lj-row").first().waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/eks-logs.png` });

  // 롤아웃 재시작 미리보기(적용 전 호출·필드 차이·영향·경고)
  await page.getByRole("tab", { name: "요약" }).click();
  await page.getByRole("button", { name: "롤아웃 재시작" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByText("PATCH").waitFor();
  await page.getByRole("dialog").getByRole("textbox").fill("orders-api");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/eks-change.png` });

  // ── 새 화면들: 접근 · 보안 점검 · Helm · 네트워크 ──
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();
  const nav = (label) => page.locator(".iam-nav-item", { hasText: label }).click();
  const detailAt = async (x) => {
    const grip = await page.locator(".k8s-detail-resizer").boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 300);
    await page.mouse.down();
    await page.mouse.move(x, grip.y + 300, { steps: 8 });
    await page.mouse.up();
  };

  // 접근: 권한 표(주체 × 네임스페이스, 일곱 칸)와 칸 하나의 바인딩 경로. 상세가 70%를 덮으니 창을 넓힌다
  await page.setViewportSize({ width: 1720, height: 940 });
  await nav("접근");
  await page.getByRole("tab", { name: "권한 표" }).click();
  await page.locator(".acc-grid tbody tr").first().waitFor();
  await page.locator('.acc-grid button[aria-label*="AWSReservedSSO_Developer"][aria-label*="commerce-prod"][aria-label*=" · 읽기:"]').click();
  await page.locator(".k8s-detail .acc-paths li").first().waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/eks-access.png` });
  await page.setViewportSize({ width: 1280, height: 780 });

  // 이후 화면은 모든 네임스페이스를 본다
  await page.locator(".k8s-top-wrap select").selectOption({ label: "모든 네임스페이스" });

  // 아래 세 화면은 목록 열과 상세가 함께 보이게 창을 넓힌다
  await page.setViewportSize({ width: 1680, height: 940 });

  // 보안 점검: 심각도·분류 카드, 문제 목록, 문제 하나의 증거·이유·고치기
  await nav("보안 점검");
  await page.locator(".sec-card").first().waitFor();
  await page.locator("tr", { hasText: "privileged 컨테이너가 있어요" }).filter({ hasText: "blackbox-exporter" }).click();
  await page.locator(".k8s-detail .sec-evidence").waitFor();
  await detailAt(1000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/eks-security.png` });

  // Helm: 릴리스 목록(deployed·failed·pending)과 릴리스의 리비전 이력
  await nav("Helm");
  const row = (text) => page.locator(".k8s-pane:not([hidden]) tbody tr", { hasText: text }).first();
  await row("orders-api").waitFor();
  // 문제가 있는 릴리스(failed·pending)가 위로 오게 상태로 정렬
  await page.getByRole("columnheader", { name: /^상태/ }).click();
  await row("orders-api").click();
  await page.getByRole("tab", { name: "이력" }).click();
  await page.locator(".helm-history tbody tr").first().waitFor();
  await detailAt(1000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/eks-helm.png` });

  // 네트워크: 로드 밸런서(ALB·NLB)와 리스너·대상 상태(비정상 대상 하나)
  await nav("네트워크");
  await row("commerce-prod/api-gateway").waitFor();
  await row("commerce-prod/api-gateway").click();
  await page.locator(".net-tg").first().waitFor();
  await detailAt(980);
  await page.locator(".k8s-detail-body").evaluate((el) => {
    const h = [...el.querySelectorAll("h4, h5")].find((x) => x.textContent.trim() === "리스너");
    el.scrollTop += h.getBoundingClientRect().top - el.getBoundingClientRect().top - 10;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/eks-network.png` });
  await page.setViewportSize({ width: 1280, height: 780 });
}
