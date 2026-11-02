import type { ArgoAppRow } from "./types";

/** 화면에 보이는 환경 순서도 이 순서다(미분류가 맨 뒤) */
export const ARGO_ENVS = ["dev", "stg", "prd", "ops", "demo", "preview", "unknown"] as const;
export type ArgoEnv = (typeof ARGO_ENVS)[number];

/** 환경을 어디서 읽었는지. null이면 못 읽은 것(unknown) */
export type ArgoEnvSource = "label" | "name" | "namespace" | "cluster";

const WORDS: Record<string, ArgoEnv> = {
  dev: "dev",
  development: "dev",
  stg: "stg",
  stage: "stg",
  staging: "stg",
  prd: "prd",
  prod: "prd",
  production: "prd",
  ops: "ops",
  demo: "demo",
};

/** 글자와 숫자 덩어리로 나눈다(`x-dev2-cluster` → x, dev2, cluster). */
const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** 토큰 하나가 환경 단어인지. 뒤의 숫자는 무시한다(dev2 → dev) */
const tokenEnv = (token: string): ArgoEnv | null => WORDS[token.replace(/\d+$/, "")] ?? null;

/** 값의 마지막 토큰이 환경이면 그 환경(`ai-dev` → dev, `ai-airflow` → 없음) */
const labelEnv = (value: string | undefined): ArgoEnv | null => {
  const last = tokens(value ?? "").pop();
  return last === undefined ? null : tokenEnv(last);
};

/** 글 안의 토큰 중 뒤에서 처음 나오는 환경(이름 끝에 붙는 `-dev` 같은 꼬리표가 가장 믿을 만하다) */
const textEnv = (text: string | undefined): ArgoEnv | null => {
  const found = tokens(text ?? "").reverse();
  for (const t of found) {
    const env = tokenEnv(t);
    if (env) return env;
  }
  return null;
};

/**
 * Application의 환경과 그걸 어디서 읽었는지.
 * 순서: preview 레이블 → 레이블 environment → 레이블 env → 이름 → 네임스페이스 → 대상 클러스터. 못 읽으면 unknown.
 */
export function envOf(row: ArgoAppRow): { env: ArgoEnv; source: ArgoEnvSource | null } {
  if (row.labels.preview === "true") return { env: "preview", source: "label" };
  const fromLabel = labelEnv(row.labels.environment) ?? labelEnv(row.labels.env);
  if (fromLabel) return { env: fromLabel, source: "label" };
  const fromName = textEnv(row.name);
  if (fromName) return { env: fromName, source: "name" };
  const fromNamespace = textEnv(row.values.destNamespace);
  if (fromNamespace) return { env: fromNamespace, source: "namespace" };
  const fromCluster = textEnv(row.values.destination);
  if (fromCluster) return { env: fromCluster, source: "cluster" };
  return { env: "unknown", source: null };
}
