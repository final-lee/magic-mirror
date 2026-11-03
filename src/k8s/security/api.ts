import { invoke } from "../../api/invoke";
import type { K8sTarget } from "../types";
import type { SecurityReport } from "./types";

export const securityApi = {
  /**
   * 보안 점검 결과 한 장. 읽지 못한 부분은 응답의 gaps·skipped에 담겨 오고, 연결이 없을 때만 오류가 된다.
   * 최상위 profile은 앱의 프로필이다(AWS 프로필 설정을 읽지 못할 때의 SSO 만료를 그 프로필로 알린다).
   */
  findings: (target: K8sTarget) => invoke<SecurityReport>("k8s_findings", { target, profile: target.profile }),
};
