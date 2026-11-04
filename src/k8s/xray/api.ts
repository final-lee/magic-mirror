import { invoke } from "../../api/invoke";
import type { K8sKindRef, K8sTarget } from "../types";
import type { K8sXray } from "./types";

// 읽기 명령 하나. 클러스터를 읽는 명령은 최상위 profile에 exec 플러그인의 프로필을 넣는다(SSO 만료를 그 프로필로 알린다).
export const xrayApi = {
  /** 객체 하나의 관계 트리. 읽지 못한 종류는 gaps에 담겨 오고, 객체를 읽지 못할 때만 실패한다 */
  get: (target: K8sTarget, kind: K8sKindRef, namespace: string | null, name: string, ssoProfile: string) =>
    invoke<K8sXray>("k8s_xray", { target, kind, namespace, name, profile: ssoProfile }),
};
