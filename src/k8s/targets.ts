import type { K8sContextCandidate, K8sKindRef, K8sSession, K8sTarget } from "./types";

/** 쿼리 키와 연결 관리의 단위. 같은 클러스터 이름이라도 프로필·리전이 다르면 다른 대상이다. */
export const targetKey = (t: K8sTarget) => `${t.profile}|${t.region}|${t.cluster}`;

/** 탭 id. 프로필을 바꾸면 모든 대상 탭을 닫으므로 프로필은 넣지 않는다. */
export const k8sTabId = (t: K8sTarget) => `k8s:${t.region}:${t.cluster}`;

/** 네임스페이스 목록을 읽는 종류 */
export const NAMESPACES: K8sKindRef = { group: "", version: "v1", kind: "Namespace", plural: "namespaces", namespaced: false };

/** exec 플러그인이 쓰는 프로필: 연결된 세션 → 고른 context 후보 → 앱에서 고른 프로필 순서 */
export function ssoProfileOf(target: K8sTarget, candidate: K8sContextCandidate | null | undefined, session: K8sSession | null | undefined): string {
  return session?.execProfile ?? candidate?.execProfile ?? target.profile;
}

/**
 * 접속할 context 고르기(백엔드 choose와 같은 규칙).
 * 저장해 둔 것이 아직 후보면 (저장, null), 아니면 후보가 하나일 때 (그것, 저장 또는 null), 아니면 (null, 저장 또는 null).
 * 돌려주는 둘째 값은 "저장해 둔 context가 없어졌다"는 안내에 쓰는 이름이다.
 */
export function chooseContext(candidates: string[], saved: string | null): [string | null, string | null] {
  if (saved !== null && candidates.includes(saved)) return [saved, null];
  if (candidates.length === 1) return [candidates[0], saved];
  return [null, saved];
}

/** 종류를 가리키는 키(감시 키, 쿼리 키에 쓴다) */
export const kindKey = (k: K8sKindRef) => `${k.group}/${k.version}/${k.plural}`;
