import { errorMessage, isAppError } from "./errors";

test("isAppError detects tagged errors", () => {
  expect(isAppError({ kind: "throttled" })).toBe(true);
  expect(isAppError("boom")).toBe(false);
  expect(isAppError(null)).toBe(false);
});

test("errorMessage", () => {
  expect(errorMessage({ kind: "ssoExpired" })).toBe("SSO 세션이 만료됐어요");
  expect(errorMessage({ kind: "accessDenied", action: "ec2:DescribeInstances" })).toBe("권한 없음 (ec2:DescribeInstances)");
  expect(errorMessage({ kind: "throttled" })).toBe("요청이 너무 많아요. 잠시 후 다시 시도하세요");
  expect(errorMessage({ kind: "network", message: "timeout" })).toBe("네트워크 오류: timeout");
  expect(errorMessage({ kind: "other", message: "bad" })).toBe("bad");
  expect(errorMessage(new Error("plain"))).toBe("plain");
  expect(errorMessage("text")).toBe("text");
});
