export interface TsAuditParty {
  name: string;
  kind: string;
  /** 대상에서 바뀐 속성(예: KEY_EXPIRY). 행위자에는 없다 */
  property: string | null;
}

export interface TsAuditEvent {
  time: string;
  actor: TsAuditParty;
  action: string;
  target: TsAuditParty;
  origin: string;
  error: string | null;
  details: string | null;
  old: string | null;
  new: string | null;
}

/** `events`는 최신순이고 많으면 일부만 싣는다. `total`은 기간 안의 전체 수 */
export interface TsAuditLog {
  start: string;
  end: string;
  events: TsAuditEvent[];
  total: number;
}

export interface TsFlowRow {
  nodeId: string;
  nodeName: string | null;
  class: "tailnet" | "subnet" | "exit";
  proto: string;
  src: string;
  srcName: string | null;
  dst: string;
  dstName: string | null;
  txBytes: number;
  rxBytes: number;
  txPkts: number;
  rxPkts: number;
}

/** `enabled`가 false면 테일넷에서 흐름 로그가 꺼져 있어서 읽지 않았다 */
export interface TsFlowLogs {
  enabled: boolean;
  start: string;
  end: string;
  flows: TsFlowRow[];
  total: number;
}

export interface TsStreamStatus {
  lastActivity: string | null;
  lastError: string | null;
  entriesSent: number;
  bytesSent: number;
  requests: number;
  failedRequests: number;
}

export type TsLogType = "configuration" | "network";

export interface TsLogStream {
  logType: TsLogType;
  configured: boolean;
  destinationType: string | null;
  url: string | null;
  user: string | null;
  uploadPeriodMinutes: number | null;
  compression: string | null;
  status: TsStreamStatus | null;
}

export interface TsWebhook {
  id: string;
  endpoint: string;
  provider: string;
  creator: string | null;
  created: string | null;
  modified: string | null;
  subscriptions: string[];
}
