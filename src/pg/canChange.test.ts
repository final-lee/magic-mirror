import { changeBlockReason, READ_REPLICA_TEXT } from "./canChange";
import { sampleOverview, sampleTargetInfo } from "./fixtures";

const MANAGE_REASON = "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요";
const cannotManage = () => sampleOverview({ canManage: false, manageReason: MANAGE_REASON });

test("a login that can manage a primary has no reason to be blocked", () => {
  expect(changeBlockReason(sampleTargetInfo(), sampleOverview())).toBeNull();
});

test("a read replica cannot be changed", () => {
  expect(READ_REPLICA_TEXT).toBe("읽기 전용 복제본이라 바꿀 수 없어요");
  expect(changeBlockReason(sampleTargetInfo({ readReplica: true }), sampleOverview())).toBe("읽기 전용 복제본이라 바꿀 수 없어요");
});

test("a login that cannot manage roles gives the reason the overview carries", () => {
  expect(changeBlockReason(sampleTargetInfo(), cannotManage())).toBe(MANAGE_REASON);
});

test("the read replica text comes first when both apply", () => {
  expect(changeBlockReason(sampleTargetInfo({ readReplica: true }), cannotManage())).toBe(READ_REPLICA_TEXT);
});

test("the reason is the overview's own text, whatever it says", () => {
  expect(changeBlockReason(sampleTargetInfo(), sampleOverview({ canManage: false, manageReason: "이 사용자는 SET ROLE로만 rds_superuser 권한을 쓸 수 있어서 바꿀 수 없어요" }))).toBe(
    "이 사용자는 SET ROLE로만 rds_superuser 권한을 쓸 수 있어서 바꿀 수 없어요",
  );
});
