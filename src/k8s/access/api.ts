import { invoke } from "../../api/invoke";
import type { K8sTarget } from "../types";
import type { AccessQuery, AccessView, Cell, CellDetail, MatrixPage, MatrixQuery, ReviewResult, Subject, WhoCanView, WorkloadView } from "./types";

// 명령 이름과 인자는 src-tauri/src/k8s_access_commands.rs와 같다. EKS API·IAM을 읽는 명령(access, workloadIdentity)은 앱 프로필로,
// 클러스터만 부르는 명령은 exec 플러그인의 프로필로 SSO 만료를 알린다(k8s/api.ts와 같은 규칙).
export const accessApi = {
  /** 신원 연결과 권한 계산 요약. force면 캐시를 버리고 다시 읽는다 */
  access: (target: K8sTarget, force: boolean) => invoke<AccessView>("k8s_access", { target, force, profile: target.profile }),
  matrix: (target: K8sTarget, query: MatrixQuery, ssoProfile: string) => invoke<MatrixPage>("k8s_access_matrix", { target, query, profile: ssoProfile }),
  cell: (target: K8sTarget, subject: Subject, cell: Cell, namespace: string | null, ssoProfile: string) =>
    invoke<CellDetail>("k8s_access_cell", { target, subject, cell, namespace, profile: ssoProfile }),
  whoCan: (target: K8sTarget, query: AccessQuery, ssoProfile: string) => invoke<WhoCanView>("k8s_who_can", { target, query, profile: ssoProfile }),
  /** SubjectAccessReview로 이 주체가 이 요청을 할 수 있는지 클러스터에 묻는다 */
  review: (target: K8sTarget, query: AccessQuery, subject: Subject, ssoProfile: string) =>
    invoke<ReviewResult>("k8s_review", { target, query, subject, profile: ssoProfile }),
  workloadIdentity: (target: K8sTarget) => invoke<WorkloadView>("k8s_workload_identity", { target, profile: target.profile }),
};
