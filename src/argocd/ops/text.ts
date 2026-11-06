// ArgoCD 운영 쓰기(액션·패치·삭제·롤백·터미널 넘기기)의 문구. 동기화·중단은 change/text.ts

// 리소스 패널의 탭
export const RES_TAB_ACTIONS = "액션";

// 리소스 액션
export const ACT_TITLE = "리소스 액션";
export const ACT_NONE = "실행할 수 있는 액션이 없어요";
export const ACT_RUN = "실행";
export const ACT_DISABLED = "지금은 실행할 수 없는 액션이에요";
export const ACT_CHECKING = "권한을 확인하는 중이에요";
export const ACT_PREVIEW = "미리 보기";
export const ACT_PARAMS_HINT = "비워 둔 칸은 보내지 않아요";
export const actRunLabel = (name: string) => `${name} 실행`;
export const actParamsTitle = (name: string) => `${name} 인자`;

// 패치·삭제
export const EDIT_TITLE = "수정·삭제";
export const PATCH_OPEN = "패치 편집…";
export const PATCH_PREVIEW = "미리 보기";
export const PATCH_HINT = "클러스터의 리소스를 바로 고쳐요. Git에는 반영되지 않고, 다음 동기화나 자동 복구가 되돌릴 수 있어요";
export const PATCH_TYPE = "패치 종류";
export const PATCH_MERGE = "JSON merge patch";
export const PATCH_STRATEGIC = "Strategic merge patch";
export const PATCH_STRATEGIC_ONLY = "Strategic merge patch는 Kubernetes 기본 종류에만 쓸 수 있어요. 이 리소스는 JSON merge patch를 써요";
export const PATCH_EDITOR = "패치 내용";
export const PATCH_INVALID = "패치는 비어 있지 않은 JSON 객체여야 해요";
export const patchTitle = (kind: string, name: string) => `${kind} ${name} 수정`;
export const DEL_OPEN = "리소스 삭제…";
export const DEL_PREVIEW = "미리 보기";
export const DEL_NOTE = "클러스터에서 이 리소스를 지워요. 앱이 관리하는 리소스면 다음 동기화나 자동 복구가 다시 만들 수 있어요";
export const DEL_FORCE = "강제 삭제";
export const DEL_FORCE_HINT = "하위 리소스가 지워지길 기다리지 않고 바로 지워요. 삭제가 멈춰 있을 때 써요";
export const DEL_ORPHAN = "하위 리소스 남기기";
export const DEL_ORPHAN_HINT = "이 리소스만 지우고 거느린 리소스(예: Deployment의 ReplicaSet과 Pod)는 그대로 둬요";
export const delTitle = (kind: string, name: string) => `${kind} ${name} 삭제`;

// 롤백
export const H_HIST_ROLLBACK = "롤백";
export const HIST_ROLLBACK = "롤백…";
export const histRollbackLabel = (id: number) => `이력 ${id} 롤백`;
export const ROLLBACK_PREVIEW = "미리 보기";
export const ROLLBACK_TARGET = "롤백할 리비전";
export const ROLLBACK_DIFF = "지금 배포 → 롤백 대상의 변경";
export const ROLLBACK_SAME = "지금 배포된 리비전과 같아요";
export const ROLLBACK_NO_DIFF = "렌더 결과가 같아요";
export const ROLLBACK_PRUNE = "대상 리비전에 없는 리소스 삭제";
export const ROLLBACK_DRY = "시험 실행";
export const ROLLBACK_AUTO_ON = "자동 동기화가 켜져 있어서 그대로는 롤백할 수 없어요";
export const ROLLBACK_AUTO_CHOICE = "자동 동기화 끄고 롤백";
export const ROLLBACK_AUTO_NOTE = "롤백한 뒤에도 자동 동기화는 꺼진 채로 남아요. 필요하면 다시 켜 주세요";
export const ROLLBACK_RUNNING = "동기화가 진행 중이라 롤백할 수 없어요";
export const rollbackTitle = (id: number) => `롤백 · 이력 ${id}`;

// 터미널 넘기기
export const SHELL_TITLE = "터미널";
export const SHELL_OPEN = "터미널 열기";
export const SHELL_CONTAINER = "컨테이너";
export const SHELL_LOADING = "kubeconfig를 읽는 중이에요";
export const SHELL_PICK = "context를 골라 주세요";
export const SHELL_WHICH = "kube context";
export const SHELL_SAVE = "이 서버의 in-cluster context로 저장";
export const SHELL_VIA = (context: string) => `EKS 탭에서 context ${context}로 열어요`;

// 대상 클러스터 ↔ kube context
export const CTX_IN_CLUSTER_NEEDS_CONTEXT = "이 앱은 ArgoCD가 있는 클러스터(in-cluster)에 배포돼요. 어느 kubeconfig context인지 알 수 없어서 골라야 해요";
export const CTX_NOT_EKS = (context: string) => `context ${context}는 EKS 클러스터가 아니라서 EKS 탭으로 열 수 없어요`;
export const ctxSavedMissing = (context: string) => `저장한 context(${context})가 kubeconfig에 없어요. 다시 골라 주세요`;
export const ctxNone = (target: string) => `kubeconfig에서 ${target}에 해당하는 context를 찾지 못했어요. 서버 주소나 이름이 같은 context가 없어요`;
export const ctxNoProfile = (context: string) => `context ${context}의 AWS 프로필을 알 수 없어요`;

// 서버 편집기의 in-cluster context
export const SERVER_KUBE_CONTEXT = "in-cluster context";
export const SERVER_KUBE_CONTEXT_NONE = "정하지 않음";
export const serverKubeContextLabel = (name: string) => `${name}의 in-cluster context`;

// 작업 중단
export const TERMINATE = "작업 중단";
export const TERMINATE_NOTE = "진행 중인 동기화 작업을 멈춰요. 이미 적용한 리소스는 되돌리지 않아요";

// 앱 상세의 액션 바
export const BAR_LABEL = "앱 작업";
export const BAR_SYNC = "동기화";
export const BAR_DEPLOY = "배포";
export const BAR_WORKLOADS = "워크로드";
export const BAR_DANGER = "위험";
export const ROLLBACK_PREVIOUS = "이전 버전으로 롤백…";
export const ROLLBACK_NO_PREVIOUS = "롤백할 이전 배포 이력이 없어요";
export const AUTO_SYNC_ON = "자동 동기화 켜기";
export const AUTO_SYNC_OFF = "자동 동기화 끄기";
export const APP_DELETE = "앱 삭제…";
export const BATCH_TARGETS = "대상 리소스";
export const BATCH_DISABLED = "지금은 이 리소스에서 실행할 수 없어요";
export const BATCH_PREVIEW = "미리 보기";
export const batchTitle = (label: string, kind: string) => `${label} · ${kind}`;
export const batchPick = (name: string) => `${name} 선택`;
export const batchButton = (label: string, kind: string, count: number) => `${label} · ${kind} ${count}`;

/** 널리 쓰는 액션 이름의 한국어 표시. 모르면 서버가 준 표시 이름, 그것도 없으면 이름 그대로 */
const ACTION_NAMES: Record<string, string> = {
  restart: "재시작",
  pause: "일시정지",
  resume: "재개",
  "promote-full": "전체 승격",
  abort: "중단",
  retry: "재시도",
  "create-job": "지금 실행",
  suspend: "일시정지",
  refresh: "새로고침",
};
export const actionLabel = (action: string, displayName: string | null) => {
  const known: unknown = ACTION_NAMES[action];
  return typeof known === "string" ? known : (displayName ?? action);
};
