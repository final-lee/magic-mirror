export type PolicySeverity = "high" | "medium" | "low";

export interface PolicyFinding {
  severity: PolicySeverity;
  title: string;
  detail: string;
  /** 정책 JSON 안의 위치. 예: `acls[2].src[0]` */
  path: string;
}

export interface TsPolicy {
  /** HuJSON 원문(주석 포함) */
  text: string;
  /** 저장할 때 If-Match로 보낼 값 */
  etag: string | null;
  externallyManaged: boolean;
  externalLink: string | null;
  findings: PolicyFinding[];
}

export type PolicyPreviewKind = "user" | "ipport";

export interface PolicyRuleMatch {
  users: string[];
  ports: string[];
  lineNumber: number;
}

export interface PolicyIssue {
  subject: string | null;
  errors: string[];
  warnings: string[];
}

export interface PolicyValidation {
  ok: boolean;
  message: string | null;
  issues: PolicyIssue[];
}

export interface PolicySaveOutcome {
  etag: string | null;
  /** 저장은 됐지만 변경 기록을 남기지 못했을 때의 안내 */
  recordError: string | null;
}
