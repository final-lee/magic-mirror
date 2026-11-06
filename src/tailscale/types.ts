export type TsCheckId = "cli" | "backend" | "dns" | "route" | "acceptRoutes" | "peer" | "ping" | "tcp" | "udp";
export type TsCheckStatus = "ok" | "warn" | "fail" | "skip";

export interface TsCheck {
  id: TsCheckId;
  status: TsCheckStatus;
  summary: string;
  detail: string | null;
}

export interface TsDiagnosis {
  host: string;
  port: number;
  address: string | null;
  tailnet: string | null;
  checks: TsCheck[];
  verdict: string;
  fix: "acceptRoutes" | null;
}

export interface TsPeer {
  hostName: string;
  dnsName: string;
  os: string;
  ips: string[];
  online: boolean;
  routes: string[];
  exitNodeOption: boolean;
  exitNode: boolean;
  tags: string[];
  relay: string;
  curAddr: string;
  lastSeen: string | null;
  keyExpiry: string | null;
  owner: string | null;
}

export interface TsNode {
  cli: string | null;
  version: string | null;
  backendState: string | null;
  health: string[];
  tailnet: string | null;
  magicDnsSuffix: string | null;
  user: string | null;
  self: TsPeer | null;
  prefs: {
    acceptRoutes: boolean;
    acceptDns: boolean;
    exitNode: string;
    shieldsUp: boolean;
    ssh: boolean;
    autoUpdate: boolean;
    advertiseRoutes: string;
    advertiseExitNode: boolean;
  } | null;
  peers: TsPeer[];
}

export type TsApiKind = "oauth" | "token";

/** 키체인에 저장되는 API 자격 증명. 연결 명령의 인자로만 나간다. */
export type TsCredential =
  | { kind: "oauth"; clientId: string; clientSecret: string }
  | { kind: "token"; token: string };

/** 테일넷의 키체인 자격 증명 상태. kind가 null이면 저장된 자격 증명이 없다. */
export interface TsApiStatus {
  tailnet: string | null;
  kind: TsApiKind | null;
}

export interface TsApiConnection {
  devices: number;
  magicDnsSuffix: string | null;
}
