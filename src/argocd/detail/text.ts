// ArgoCD 상세(리소스 패널·Diff·작업·이력·sync window·링크)의 문구

export const ARGO_NODE_OPEN = "리소스 상세 열기";
export const TAB_ARGO_DIFF = "Diff";
export const TAB_ARGO_OPERATION = "작업";

// 리소스 패널
export const RES_PANEL_LABEL = "리소스 상세";
export const RES_BACK = "← 리소스 목록";
export const RES_TAB_SUMMARY = "요약";
export const RES_TAB_LIVE = "Live";
export const RES_TAB_DESIRED = "Desired";
export const RES_TAB_DIFF = "Diff";
export const RES_TAB_EVENTS = "Events";
export const RES_TAB_LOGS = "로그";
export const RES_TAB_LINKS = "링크";
export const RES_NO_LIVE = "클러스터에 없는 리소스예요";
export const RES_NO_DESIRED = "Git에 정의된 목표 상태가 없어요. 이 앱이 직접 만든 리소스가 아니에요";
export const RES_NO_DIFF = "비교할 목표 상태가 없어요";
export const RES_DIFF_SAME = "목표 상태와 같아요";
export const RES_NO_EVENTS = "이벤트가 없어요";
export const RES_NO_LINKS = "설정된 링크가 없어요";
export const L_RES_KIND = "종류";
export const L_RES_API = "그룹/버전";
export const L_RES_NAMESPACE = "네임스페이스";
export const L_RES_SYNC = "Sync";
export const L_RES_HEALTH = "Health";
export const L_RES_MESSAGE = "상태 메시지";
export const L_RES_CREATED = "생성";
export const L_RES_IMAGES = "이미지";
export const L_RES_INFO = "정보";
export const L_RES_FLAGS = "표시";
export const RES_CLUSTER_SCOPE = "클러스터 범위";
export const H_EVENT_TYPE = "종류";
export const H_EVENT_REASON = "이유";
export const H_EVENT_MESSAGE = "메시지";
export const H_EVENT_COUNT = "횟수";
export const H_EVENT_SEEN = "시각";
export const EVENTS_LABEL = "리소스 이벤트";

/** diff 요약: 줄 단위로 더해지고(+) 빠지고(−) 바뀐(~) 줄 수 */
export const diffStats = (s: { added: number; removed: number; changed: number }) => `+${s.added} −${s.removed} ~${s.changed}`;

// 앱 Diff 탭
export const DIFF_CHANGED_ONLY = "바뀐 것만";
export const DIFF_OUT_OF_SYNC_ONLY = "OutOfSync만";
export const DIFF_NONE = "관리하는 리소스가 없어요";
export const DIFF_NO_CHANGES = "바뀐 리소스가 없어요. 목표 상태와 모두 같아요";
export const DIFF_NO_MATCH = "조건에 맞는 리소스가 없어요";
export const DIFF_UNCHANGED = "바뀐 내용이 없어요";
export const DIFF_ROW_OPEN = "리소스 상세 열기";
export const DIFF_LIST_LABEL = "리소스별 diff";
export const diffSummary = (changed: number, total: number) => `${total}개 중 ${changed}개가 바뀌어요`;
export const diffToggle = (name: string) => `${name} diff 펼치기·접기`;

// 작업 탭
export const OP_ELAPSED = "경과";
export const OP_RETRY = "재시도";
export const OP_SYNC_OPTIONS = "동기화 옵션";
export const OP_RESULTS = "리소스별 결과";
export const OP_NO_RESULTS = "아직 리소스별 결과가 없어요";
export const OP_DRY_RUN = "Dry run";
export const OP_PRUNE = "Prune";
export const OP_RUNNING_NOTE = "작업이 끝날 때까지 자동으로 갱신돼요";
export const H_OP_WAVE = "Wave";
export const H_OP_PHASE = "단계";
export const H_OP_KIND = "종류";
export const H_OP_NAME = "이름";
export const H_OP_STATUS = "결과";
export const H_OP_HOOK = "hook";
export const opRetry = (count: number, limit: number | null) => (limit === null ? `${count}회` : `${count} / ${limit}회`);

/** 경과 시간 글: `1시간 2분`, `3분 4초`, `5초` */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

// 이력 탭
export const HIST_SERVER = "배포 이력";
export const HIST_LOCAL = "작업 기록";
export const HIST_LOCAL_NOTE = "이 앱에서 끝난 동기화 작업이에요. 서버는 성공한 배포만 이력으로 남겨요";
export const HIST_NO_LOCAL = "기록된 작업이 아직 없어요";
export const HIST_COMPARE = "비교";
export const HIST_COMPARE_HINT = "두 건을 골라 렌더 결과(매니페스트)를 비교해요";
export const HIST_CLEAR = "선택 풀기";
export const HIST_NO_MANIFEST_DIFF = "두 리비전의 매니페스트가 같아요";
export const HIST_COMMIT = "커밋";
export const HIST_CHART = "차트";
export const H_HIST_PICK = "선택";
export const H_HIST_WHEN = "시각";
export const H_HIST_RESULT = "결과";
export const H_HIST_ELAPSED = "소요";
export const histSelect = (id: number) => `${id}번 배포 선택`;
export const histCompareTitle = (from: number, to: number) => `#${from} → #${to} 매니페스트 차이`;
export const histMoreRevisions = (n: number) => `외 ${n}개 소스`;

// sync window·링크·웹 UI
export const SW_BLOCKED = "Sync 막힘";
export const SW_ALLOWED = "Sync window";
export const SW_BLOCKED_TITLE = "sync window 때문에 지금은 동기화할 수 없어요";
export const SW_ALLOWED_TITLE = "sync window가 걸려 있지만 지금은 동기화할 수 있어요";
export const SW_PANEL_LABEL = "Sync window 설명";
export const SW_ACTIVE = "지금 켜져 있어요";
export const SW_MANUAL_OK = "수동 동기화는 허용돼요";
export const swKind = (kind: string) => (kind === "deny" ? "막는 시간(deny)" : kind === "allow" ? "허용하는 시간(allow)" : kind);
export const swSchedule = (schedule: string, duration: string) => `${schedule} 부터 ${duration}`;
export const ARGO_OPEN_UI = "ArgoCD에서 열기";
export const ARGO_OPEN_UI_TITLE = "브라우저에서 ArgoCD 웹 UI로 이 앱을 열어요";
export const APP_LINKS_LABEL = "앱 링크";
