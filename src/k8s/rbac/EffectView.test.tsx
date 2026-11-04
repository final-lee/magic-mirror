import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EffectView } from "./EffectView";
import type { RbacEffect } from "./types";

const base: RbacEffect = { subjects: [], total: 0, escalated: [], losesOwnAccess: false, own: null, unavailable: null };

describe("EffectView", () => {
  it("얻는 것과 잃는 것을 나누고 권한 상승과 내 신원 경고를 보인다", () => {
    const effect: RbacEffect = {
      ...base,
      total: 2,
      escalated: [{ kind: "user", name: "bob", namespace: null }],
      losesOwnAccess: true,
      own: { kind: "group", name: "devs", namespace: null },
      subjects: [
        { subject: { kind: "user", name: "bob", namespace: null }, gained: [{ namespace: null, group: "*", resource: "*", verbs: ["*"] }], lost: [], gainedUrls: [], lostUrls: [] },
        { subject: { kind: "group", name: "devs", namespace: null }, gained: [], lost: [{ namespace: "dev", group: "", resource: "pods", verbs: ["get", "list"] }], gainedUrls: [], lostUrls: [] },
      ],
    };
    render(<EffectView effect={effect} />);
    expect(screen.getByText(/클러스터 관리자 권한이나 권한 상승 경로를/)).toBeTruthy();
    expect(screen.getByText(/이 앱이 쓰는 신원이 권한을 잃어요/)).toBeTruthy();
    expect(screen.getByText("get, list pods · dev")).toBeTruthy();
    expect(screen.getByText("권한 상승")).toBeTruthy();
    expect(screen.getByText("내 신원")).toBeTruthy();
  });

  it("달라지는 주체가 없으면 그렇게 말하고 계산하지 못한 이유를 보인다", () => {
    render(<EffectView effect={{ ...base, unavailable: "RBAC를 읽지 못했어요" }} />);
    expect(screen.getByText("실효 권한이 달라지는 주체가 없어요")).toBeTruthy();
    expect(screen.getByText(/RBAC를 읽지 못했어요/)).toBeTruthy();
  });
});
