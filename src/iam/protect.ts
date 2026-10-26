import type { PrincipalSummary } from "./types";

/**
 * 변경 버튼을 꺼야 하는 이유. 서비스 연결 역할(path /aws-service-role/)과 Identity Center 역할
 * (path /aws-reserved/sso.amazonaws.com/ 또는 이름 AWSReservedSSO_*)은 AWS가 관리하고 백엔드도 막는다.
 * 눌러 보고서야 막히지 않도록 화면에서 미리 끄고 이유를 보여준다. 바꿀 수 있으면 null.
 */
export function changeBlockReason(p: PrincipalSummary): string | null {
  if (p.badges.some((b) => b.kind === "serviceLinked") || p.path.startsWith("/aws-service-role/")) {
    return "서비스 연결 역할은 AWS가 관리해서 바꿀 수 없어요";
  }
  if (
    p.badges.some((b) => b.kind === "sso") ||
    p.path.startsWith("/aws-reserved/sso.amazonaws.com/") ||
    (p.kind === "role" && p.name.startsWith("AWSReservedSSO_"))
  ) {
    return "Identity Center가 관리하는 역할이라 바꿀 수 없어요";
  }
  return null;
}
