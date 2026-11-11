import type { StreamEvent } from "./types";

// 사용자에게 보이는 문구(스트림 탭: 연결 그림과 실시간 레코드). 연결 진단 문구는 백엔드(src-tauri/src/dynamo/health.rs)가 만든다.

// 연결 카드
export const CONNECTIONS = "연결";
export const LOADING = "연결을 읽고 있어요…";
export const REFRESH = "다시 읽기";
export const STREAM = "스트림";
export const NO_STREAM = "이 테이블의 스트림이 꺼져 있어요.";
export const NO_CONSUMERS = "연결된 소비자가 없어요.";
export const MAPPING_SETTINGS = "매핑 설정";
export const JUMP = "Lambda 상세 열기";
export const FINDINGS = "연결 진단";
export const GAP = "읽지 못한 연결";
export const DEFAULT_CLASS = "STANDARD";
export const NONE_VALUE = "—";

const GAP_SECTION: Record<string, string> = {
  lambda: "Lambda 매핑",
  pipes: "EventBridge Pipes",
  kinesis: "Kinesis 대상",
  iteratorAge: "Lambda 처리 지연 지표",
  replicationLatency: "복제 지연 지표",
};
export const gapLine = (section: string, error: string) => `${GAP}: ${GAP_SECTION[section] ?? section} — ${error}`;

export const seconds = (ms: number | null) => (ms === null ? NONE_VALUE : `${Math.round(ms / 1000)}초`);
export const batchAndAge = (batch: number | null, ageMs: number | null) => `배치 ${batch ?? NONE_VALUE} · 지연 ${seconds(ageMs)}`;
export const replicaLine = (status: string, tableClass: string | null, latencyMs: number | null) => `${status} · ${tableClass ?? DEFAULT_CLASS} · ${seconds(latencyMs)}`;
export const lambdaNode = (name: string) => `Lambda ${name}`;
export const pipeNode = (name: string) => `Pipe ${name}`;
export const replicaNode = (region: string) => `↔ ${region}`;
export const KINESIS = "Kinesis";

// 실시간 레코드
export const LIVE = "실시간 레코드";
export const START = "읽기 시작";
export const STOP = "읽기 중지";
export const PAUSE = "일시정지";
export const RESUME = "재개";
export const START_POSITION = "시작 위치";
export const LATEST = "지금부터";
export const TRIM = "24시간 전부터";
export const TRIM_WARNING = "보관된 레코드를 처음부터 읽으므로 많은 레코드를 읽을 수 있어요.";
export const FILTER = "레코드 필터";
export const EMPTY = "표시할 레코드가 없어요.";
export const shards = (reading: number, behind: number) => `읽는 샤드 ${reading}개${behind > 0 ? ` · 대기 ${behind}개` : ""}`;

export const EVENT: Record<StreamEvent, string> = { INSERT: "추가", MODIFY: "변경", REMOVE: "삭제" };
export const eventLabel = (event: string) => EVENT[event as StreamEvent] ?? event;
export const sizeLabel = (bytes: number | null) => (bytes === null ? NONE_VALUE : `${bytes} B`);

// 이미지 비교
export const ATTRIBUTE = "속성";
export const OLD = "이전 이미지";
export const NEW = "새 이미지";
export const MISSING = "이미지 없음";
