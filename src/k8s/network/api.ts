import { invoke } from "../../api/invoke";
import type { K8sTarget } from "../types";
import type { Network } from "./types";

export const networkApi = {
  /**
   * 네트워크 화면 한 장. 부분마다 실패는 응답의 gaps에 담겨 오고, 연결이 없을 때만 오류가 된다.
   * 최상위 profile은 앱의 프로필이다(AWS 프로필 설정을 읽지 못할 때의 SSO 만료를 그 프로필로 알린다).
   */
  network: (target: K8sTarget) => invoke<Network>("k8s_network", { target, profile: target.profile }),
};
