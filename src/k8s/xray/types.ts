import type { AppError } from "../../api/types";
import type { K8sProblem } from "../types";

// 백엔드 `k8s/xray/model.rs`와 같은 모양(camelCase)

/** 관계의 종류: 소유, 참조, 선택, 대상 */
export type XrayEdge = "owner" | "reference" | "selector" | "target";

/** 가리킨 객체를 읽은 결과. missing은 그 종류를 끝까지 읽었는데 없다는 뜻이고, unknown은 알 수 없다는 뜻이다 */
export type XrayPresence = "found" | "missing" | "unknown";

export interface XrayNode {
  group: string;
  version: string;
  kind: string;
  namespace: string | null;
  name: string;
  /** 부모와 이은 관계 */
  edge: XrayEdge;
  /** 관계의 구체적인 모습(volume, env, usedBy 등) */
  roles: string[];
  /** 지금 보고 있는 객체 */
  current: boolean;
  presence: XrayPresence;
  status: string | null;
  problems: K8sProblem[];
  children: XrayNode[];
}

export interface XraySection {
  edge: XrayEdge;
  nodes: XrayNode[];
}

/** 읽지 못한 종류(권한 없음 등). 실패가 아니라 빈 칸이다 */
export interface XrayGap {
  kind: string;
  error: AppError;
}

export interface K8sXray {
  sections: XraySection[];
  gaps: XrayGap[];
  /** 노드 수 한도나 가지 수 한도로 일부를 줄였다 */
  truncated: boolean;
  /** 쪽 수 한도에서 읽기를 멈춘 종류 */
  partial: string[];
  nodes: number;
}
