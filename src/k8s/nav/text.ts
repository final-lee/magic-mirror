// ── `:` 명령 줄(k9s식 이동) ──
export const GOTO_LABEL = "이동 명령";
export const GOTO_PLACEHOLDER = "pod, deploy, svc, no, ns <이름>, events, helm …";
export const GOTO_COMPLETIONS_LABEL = "이동 후보";
export const GOTO_HISTORY_LABEL = "최근 명령";
export const GOTO_CLOSE = "이동 명령 닫기";
export const GOTO_HINT = "Enter 이동 · Tab 완성 · ↑↓ 기록 · Esc 닫기";
export const GOTO_EMPTY = "맞는 종류나 메뉴가 없어요";

export const GOTO_GROUP_KIND = "종류";
export const GOTO_GROUP_VIEW = "메뉴";
export const GOTO_GROUP_NS = "네임스페이스";
export const GOTO_NS_ALL = "모든 네임스페이스";

/** 알 수 없는 별칭. 가까운 것을 같이 보인다 */
export const gotoUnknown = (input: string, closest: string[]) =>
  closest.length > 0 ? `'${input}'을(를) 찾지 못했어요. 비슷한 것: ${closest.join(", ")}` : `'${input}'을(를) 찾지 못했어요`;
/** 같은 이름이 여러 API 그룹에 있다 */
export const gotoAmbiguous = (input: string, options: string[]) => `'${input}'은(는) 여러 그룹에 있어요: ${options.join(", ")}. 복수형.그룹으로 적어요`;
export const gotoUnknownNamespace = (name: string, closest: string[]) =>
  closest.length > 0 ? `네임스페이스 '${name}'이(가) 없어요. 비슷한 것: ${closest.join(", ")}` : `네임스페이스 '${name}'이(가) 없어요`;
export const GOTO_NS_USAGE = "ns <이름>이나 ns all로 적어요";
export const GOTO_NO_KIND_DATA = "클러스터의 종류 목록을 아직 읽는 중이에요. 내장 종류 이름만 쓸 수 있어요";

// ── 한 글자 키 ──
/** 상태 줄에 잠깐 보이는 안내 */
export const KEY_NOTE_LABEL = "키 안내";
export const KEY_NOTE_DISMISS = "안내 닫기";
export const KEY_NO_SELECTION = "먼저 행을 골라 주세요(↑↓)";
export const KEY_LOADING = "상세를 읽는 중이에요. 잠시 뒤 다시 눌러 주세요";
export const KEY_NOT_AVAILABLE = "지금은 쓸 수 없어요";
export const KEY_ALREADY_ALL = "이미 모든 네임스페이스를 보고 있어요";
export const KEY_CLUSTER_SCOPED = (kind: string) => `${kind}은(는) 네임스페이스가 없는 종류예요`;
export const KEY_ALREADY_CORDONED = "이미 cordon된 노드예요. u로 풀 수 있어요";
export const KEY_NOT_CORDONED = "cordon되지 않은 노드예요. c로 cordon할 수 있어요";

/** 키마다 쓸 수 있는 종류. 맞지 않으면 이 문구를 보인다 */
export const KEY_ONLY: Record<string, string> = {
  "k8s.logs": "l은 Pod와 Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·Service에서 로그를 봐요",
  "k8s.shell": "s는 Pod의 셸, Deployment·StatefulSet의 scale에 써요",
  "k8s.attach": "a는 Pod에서만 attach해요",
  "k8s.forward": "⇧F는 Pod와 Service에서만 포트포워딩을 열어요",
  "k8s.restart": "r은 Deployment·StatefulSet·DaemonSet에서만 rollout restart해요",
  "k8s.cordon": "c는 노드에서만 cordon해요",
  "k8s.uncordon": "u는 노드에서만 cordon을 풀어요",
};
