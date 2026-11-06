import { describe, expect, it } from "vitest";
import {
  deviceActionTone,
  deviceChangeTone,
  heaviestTone,
  integrationTone,
  lockTone,
  macActionTone,
  revertTone,
  shareTone,
  userTone,
} from "./tone";

describe("tailscale tone", () => {
  it("없애기는 되돌려도 없애기이고 나머지는 멈춤·되돌림이다", () => {
    expect(revertTone("danger")).toBe("danger");
    expect(revertTone("create")).toBe("caution");
    expect(revertTone("primary")).toBe("caution");
  });

  it("섞인 변경은 가장 무거운 색을 따른다", () => {
    expect(heaviestTone([])).toBe("primary");
    expect(heaviestTone(["primary", "warn", "danger"])).toBe("danger");
    expect(heaviestTone(["warn", "create"])).toBe("warn");
  });

  it("기기 작업은 하는 일로 나눈다", () => {
    expect(deviceActionTone("delete")).toBe("danger");
    expect(deviceActionTone("expire")).toBe("danger");
    expect(deviceActionTone("routes")).toBe("create");
    expect(deviceActionTone("authorize")).toBe("warn");
    expect(deviceActionTone("keyExpiryOff")).toBe("warn");
    expect(deviceActionTone("keyExpiry")).toBe("warn");
    expect(deviceActionTone("tags")).toBe("primary");
    expect(deviceChangeTone(["tags", "delete"])).toBe("danger");
  });

  it("연동 요청은 만들기·없애기·교체·확인으로 나눈다", () => {
    expect(integrationTone("webhookCreate")).toBe("create");
    expect(integrationTone("externalCreate")).toBe("create");
    expect(integrationTone("appDelete")).toBe("danger");
    expect(integrationTone("streamDelete")).toBe("danger");
    expect(integrationTone("webhookRotate")).toBe("warn");
    expect(integrationTone("externalValidate")).toBe("refresh");
    expect(integrationTone("postureUpdate")).toBe("primary");
    expect(integrationTone("streamPut")).toBe("primary");
  });

  it("Tailnet Lock 명령과 그 되돌리기", () => {
    expect(lockTone("sign-node")).toBe("primary");
    expect(lockTone("trust-key")).toBe("create");
    expect(lockTone("untrust-key")).toBe("danger");
    expect(lockTone("revoke-finish")).toBe("danger");
    expect(lockTone("initialize")).toBe("warn");
    expect(lockTone("tailnet-off")).toBe("warn");
    expect(lockTone("trust-key", true)).toBe("caution");
    expect(lockTone("untrust-key", true)).toBe("danger");
  });

  it("이 Mac 명령", () => {
    expect(macActionTone("connect")).toBe("primary");
    expect(macActionTone("authenticate")).toBe("primary");
    expect(macActionTone("upgrade")).toBe("primary");
    expect(macActionTone("disconnect")).toBe("caution");
    expect(macActionTone("sign-out")).toBe("caution");
    expect(macActionTone("account-select")).toBe("warn");
    expect(macActionTone("account-remove")).toBe("danger");
  });

  it("공유 명령은 Funnel 끄기와 경로 지우기를 가른다", () => {
    expect(shareTone({ action: "mapping" })).toBe("create");
    expect(shareTone({ action: "mapping-off", service: "funnel" })).toBe("warn");
    expect(shareTone({ action: "mapping-off", service: "" })).toBe("danger");
    expect(shareTone({ action: "mapping-off", service: "svc:web" })).toBe("danger");
    expect(shareTone({ action: "serve-reset" })).toBe("danger");
    expect(shareTone({ action: "drain" })).toBe("danger");
    expect(shareTone({ action: "advertise" })).toBe("warn");
    expect(shareTone({ action: "send" })).toBe("primary");
  });

  it("사용자 변경", () => {
    expect(userTone("createInvite")).toBe("create");
    expect(userTone("resendInvite")).toBe("primary");
    expect(userTone("deleteInvite")).toBe("danger");
    expect(userTone("delete")).toBe("danger");
    expect(userTone("suspend")).toBe("caution");
    expect(userTone("restore")).toBe("warn");
    expect(userTone("role")).toBe("warn");
    expect(userTone("restore", true)).toBe("caution");
  });
});
