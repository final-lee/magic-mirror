import type { ArgoEvent, ArgoHistoryEntry, ArgoOperation, ArgoResourceResult, ArgoWave, AppDiffRow, ResRef } from "../types";

const HEX_REVISION = /^[0-9a-f]{7,40}$/i;

/** 저장소 주소(https·ssh·scp 꼴)에서 웹 주소의 호스트와 경로를 뽑는다. 읽지 못하면 null */
function repoParts(repoUrl: string): { host: string; path: string } | null {
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(repoUrl);
  let host: string;
  let path: string;
  if (scp) {
    [, host, path] = scp;
  } else {
    try {
      const u = new URL(repoUrl);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return host && path ? { host: host.toLowerCase(), path } : null;
}

/**
 * Git 커밋의 웹 주소. GitHub(`/commit/`)·GitLab(`/-/commit/`)·Bitbucket Cloud(`/commits/`)를 호스트로 알아본다
 * (호스트 이름에 `github`·`gitlab` 조각이 있으면 사내 서버도 같은 꼴로 본다). 커밋 해시(7~40자리 16진수)가 아니거나 모르는 호스트면 null.
 */
export function commitUrl(repoUrl: string | null | undefined, revision: string): string | null {
  if (!repoUrl || !HEX_REVISION.test(revision)) return null;
  const parts = repoParts(repoUrl);
  if (!parts) return null;
  const labels = parts.host.split(".");
  const base = `https://${parts.host}/${parts.path}`;
  if (labels.includes("github")) return `${base}/commit/${revision}`;
  if (labels.includes("gitlab")) return `${base}/-/commit/${revision}`;
  if (parts.host === "bitbucket.org") return `${base}/commits/${revision}`;
  return null;
}

/** ArgoCD 웹 UI에서 이 앱을 여는 주소 */
export const argoWebUrl = (serverUrl: string, namespace: string, name: string) => `${serverUrl.replace(/\/+$/, "")}/applications/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;

/** 로그를 받을 수 있는 리소스: Pod 하나, 또는 Pod를 거느린 워크로드(서버가 트리에서 Pod를 찾는다) */
export function logsKind(res: Pick<ResRef, "group" | "kind">): "pod" | "workload" | null {
  if (res.group === "" && res.kind === "Pod") return "pod";
  const workloads: Record<string, string[]> = { apps: ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"], batch: ["Job", "CronJob"], "argoproj.io": ["Rollout"] };
  return workloads[res.group]?.includes(res.kind) ? "workload" : null;
}

export interface DiffFilter {
  changedOnly: boolean;
  outOfSyncOnly: boolean;
}

/** Diff 탭 거르기: 바뀐 것만(줄 단위로 달라진 것), OutOfSync만(앱이 보고한 Sync 상태) */
export const filterDiffRows = (rows: AppDiffRow[], f: DiffFilter): AppDiffRow[] =>
  rows.filter((r) => (!f.changedOnly || r.changed) && (!f.outOfSyncOnly || r.syncStatus === "OutOfSync"));

const PHASE_ORDER = ["PreSync", "Sync", "PostSync", "SyncFail"];

export interface OperationRow {
  key: string;
  result: ArgoResourceResult;
  /** 렌더 결과에서 읽은 sync wave. 알 수 없으면 null */
  wave: number | null;
  /** hook 종류(결과의 hookType, 없으면 렌더 결과의 hook 주석). hook이 아니면 null */
  hook: string | null;
}

const sameResource = (r: ArgoResourceResult, w: ArgoWave) => r.group === w.group && r.kind === w.kind && r.name === w.name && (r.namespace ?? "") === (w.namespace ?? "");

/** 작업 결과를 실행 순서대로: 단계(PreSync → Sync → PostSync → SyncFail), wave, 종류, 이름. wave는 렌더 결과에서 붙인다. */
export function operationRows(results: ArgoResourceResult[], waves: ArgoWave[] | undefined): OperationRow[] {
  const rows = results.map((result, i): OperationRow => {
    const wave = waves?.find((w) => sameResource(result, w));
    return { key: `${i}:${result.group}/${result.kind}/${result.namespace ?? ""}/${result.name}`, result, wave: wave ? wave.wave : null, hook: result.hookType ?? wave?.hook ?? null };
  });
  const phase = (r: OperationRow) => {
    const i = PHASE_ORDER.indexOf(r.result.syncPhase ?? "Sync");
    return i < 0 ? PHASE_ORDER.length : i;
  };
  return rows.sort((a, b) => phase(a) - phase(b) || (a.wave ?? 0) - (b.wave ?? 0) || a.result.kind.localeCompare(b.result.kind) || a.result.name.localeCompare(b.result.name));
}

/** 작업의 경과 시간(ms). 끝났으면 끝난 때까지, 진행 중이면 지금까지. 시작 시각을 읽지 못하면 null */
export function operationElapsedMs(op: Pick<ArgoOperation, "startedAt" | "finishedAt">, now: number): number | null {
  const start = op.startedAt ? Date.parse(op.startedAt) : NaN;
  if (Number.isNaN(start)) return null;
  const end = op.finishedAt ? Date.parse(op.finishedAt) : now;
  return Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** 이 앱에서 끝난 작업 기록(최근 것부터) */
export const localOperations = (events: ArgoEvent[], namespace: string, name: string): ArgoEvent[] =>
  events.filter((e) => e.kind === "operation" && e.namespace === namespace && e.app === name).sort((a, b) => b.at.localeCompare(a.at));

export interface RevisionPair {
  /** 먼저 배포된 쪽 */
  from: ArgoHistoryEntry;
  to: ArgoHistoryEntry;
}

/** 고른 이력 두 건을 오래된 것 → 새 것 순서로. 둘이 아니면 null */
export function revisionPair(entries: ArgoHistoryEntry[], picked: number[]): RevisionPair | null {
  if (picked.length !== 2) return null;
  const [a, b] = picked.map((id) => entries.find((e) => e.id === id));
  if (!a || !b) return null;
  return a.id <= b.id ? { from: a, to: b } : { from: b, to: a };
}
