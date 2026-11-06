import type { XrayEdge } from "./types";

// 관계 탭에 보이는 문구

export const TAB_RELATIONS = "관계";
export const XRAY_LABEL = "관계 트리";
export const XRAY_LOADING = "관계를 읽는 중…";
export const XRAY_REFRESH = "다시 읽기";
export const XRAY_EMPTY = "이 객체와 이어진 객체가 없어요";
export const XRAY_CURRENT = "지금 보는 객체";
export const XRAY_MISSING = "없음";
export const XRAY_MISSING_TITLE = "가리키는데 클러스터에는 없어요";
export const XRAY_TRUNCATED = "이어진 객체가 많아 일부만 보여요(전체 300개, 한 갈래 50개까지)";
export const xrayPartial = (kinds: string[]) => `${kinds.join(", ")} 목록이 길어 앞부분만 읽었어요. 이어진 객체가 빠졌을 수 있어요`;
export const XRAY_VIEW = "보기 방식";
export const XRAY_VIEW_MAP = "지도";
export const XRAY_VIEW_LIST = "목록";
export const MAP_LABEL = "관계 지도";
export const MAP_INWARD = "← 이 객체를 가리키는 것";
export const MAP_OUTWARD = "이 객체가 가리키는 것 →";
export const xrayGap = (kind: string, reason: string) => `${kind}을(를) 읽지 못했어요: ${reason}. 이 종류와의 관계는 보이지 않아요`;
export const xrayOpen = (kind: string, name: string) => `${kind} ${name} 열기`;

export const EDGE_LABELS: Record<XrayEdge, string> = {
  owner: "소유",
  reference: "참조",
  selector: "선택",
  target: "대상",
};

/** 묶음 제목 아래의 한 줄 설명 */
export const EDGE_HINTS: Record<XrayEdge, string> = {
  owner: "소유자 사슬과 자식(ownerReferences)",
  reference: "이름으로 가리키는 것, 그리고 이 객체를 쓰는 것",
  selector: "레이블 선택자로 이어진 것",
  target: "다른 객체를 대상으로 삼는 것(Ingress, HPA, EndpointSlice)",
};

/** 관계의 구체적인 모습. 모르는 값은 그대로 보인다 */
export const ROLE_LABELS: Record<string, string> = {
  usedBy: "사용 중",
  serviceAccount: "서비스 계정",
  volume: "볼륨",
  env: "환경 변수",
  imagePull: "이미지 풀 시크릿",
  priority: "우선순위",
  node: "실행 노드",
  tls: "TLS",
  storageClass: "스토리지 클래스",
};
