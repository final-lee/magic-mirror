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
