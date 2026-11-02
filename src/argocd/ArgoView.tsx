import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { age } from "../k8s/format";
import { DETAIL_PCT } from "../k8s/lanes";
import { ArgoBadge } from "./argoParts";
import { ArgoDetail } from "./ArgoDetail";
import { isTokenError, useApps, useAppsets } from "./queries";
import {
  ARGO_ALL_PROJECTS, ARGO_APPS_LABEL, ARGO_AUTO_OFF, ARGO_AUTO_ON, ARGO_GROUP_BY_SET, ARGO_HEALTH_GROUP, ARGO_HEALTH_STATUSES, ARGO_IN_CLUSTER,
  ARGO_NO_APPS, ARGO_NO_MATCH, ARGO_PROJECT, ARGO_SEARCH, ARGO_SYNC_GROUP, ARGO_SYNC_STATUSES, ARGO_UNGROUPED, COL_NAME, H_ARGO_AUTO, H_ARGO_DEST,
  H_ARGO_LAST_SYNC, H_ARGO_OPERATION, H_ARGO_REVISION, LOADING, argoAppCount, argoCaution, argoErrors, argoGenerators, argoOk, argoOutOfSync, argoWarnings,
} from "./text";
import type { ArgoAppRow, ArgoAppSetRow } from "./types";

interface Props {
  /** ArgoCD 서버 주소 */
  url: string;
  /** 탭이 보이는 동안만 10초마다 다시 읽는다 */
  live: boolean;
  /** 토큰이 없거나 무효라는 오류가 나면 부른다(메시지 포함) */
  onTokenError: (message: string) => void;
  now?: number;
}

/** 알려진 상태가 아니거나 없으면 Unknown 칸으로 센다 */
const bucket = (value: string | undefined, list: readonly string[]) => (value && list.includes(value) ? value : "Unknown");
const syncOf = (r: ArgoAppRow) => bucket(r.values.sync, ARGO_SYNC_STATUSES);
const healthOf = (r: ArgoAppRow) => bucket(r.values.health, ARGO_HEALTH_STATUSES);

/** 눈여겨볼 앱: 어긋났거나, 건강하지 않거나, 오류 조건이 있거나, 마지막 작업이 실패 */
export const isProblem = (r: ArgoAppRow): boolean =>
  r.values.sync === "OutOfSync" ||
  r.values.health !== "Healthy" ||
  Number(r.values.errors ?? 0) > 0 ||
  r.values.operation === "Failed" ||
  r.values.operation === "Error";

export type ArgoLevel = "err" | "warn" | "ok";

/**
 * 앱 하나의 심각도. 오류(빨강): 오류 조건, Degraded·Missing, 작업 Failed·Error.
 * 주의(노랑): 그 밖의 문제(OutOfSync, Progressing·Unknown 등). 나머지는 정상.
 */
export function levelOf(r: ArgoAppRow): ArgoLevel {
  const v = r.values;
  if (Number(v.errors ?? 0) > 0 || v.health === "Degraded" || v.health === "Missing" || v.operation === "Failed" || v.operation === "Error") return "err";
  return isProblem(r) ? "warn" : "ok";
}

const LEVEL_RANK: Record<ArgoLevel, number> = { err: 0, warn: 1, ok: 2 };

const bySeverityThenName = (a: ArgoAppRow, b: ArgoAppRow) =>
  LEVEL_RANK[levelOf(a)] - LEVEL_RANK[levelOf(b)] || a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace);

/** 묶음의 앱을 한 칸씩 센다: 오류 > OutOfSync > 그 밖의 주의 > 정상 */
interface Tally {
  err: number;
  outOfSync: number;
  caution: number;
  ok: number;
}

function tally(apps: ArgoAppRow[]): Tally {
  const t: Tally = { err: 0, outOfSync: 0, caution: 0, ok: 0 };
  for (const r of apps) {
    const level = levelOf(r);
    if (level === "err") t.err++;
    else if (level === "ok") t.ok++;
    else if (r.values.sync === "OutOfSync") t.outOfSync++;
    else t.caution++;
  }
  return t;
}

/** 묶음 색: ApplicationSet 자체가 Error이거나 오류 앱이 있으면 빨강, 주의 앱이 있으면 노랑 */
const groupLevel = (set: ArgoAppSetRow | null, t: Tally): ArgoLevel => (set?.status === "Error" || t.err > 0 ? "err" : t.outOfSync + t.caution > 0 ? "warn" : "ok");

const toggled = <T,>(set: Set<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
};

const rowKey = (namespace: string, name: string) => `${namespace}/${name}`;

const IN_CLUSTER = ["https://kubernetes.default.svc", "in-cluster"];

/** 대상 클러스터: 이 ArgoCD가 있는 클러스터(in-cluster)는 "이 클러스터"로 */
const destinationText = (v: Record<string, string>) => {
  const cluster = v.destination && IN_CLUSTER.includes(v.destination) ? ARGO_IN_CLUSTER : v.destination;
  return [cluster, v.destNamespace].filter(Boolean).join("/");
};

interface Group {
  key: string;
  /** null이면 ApplicationSet이 없는 앱들 */
  name: string | null;
  set: ArgoAppSetRow | null;
  apps: ArgoAppRow[];
}

/** 열 너비를 고정해 묶음 카드가 나뉘어도 열이 위아래로 맞는다 */
const COLUMN_WIDTHS = ["22%", "9%", "16%", "8%", "8%", "8%", "15%", "8%", "6%"];
const Columns = () => (
  <colgroup>
    {COLUMN_WIDTHS.map((w, i) => (
      <col key={i} style={{ width: w }} />
    ))}
  </colgroup>
);

/** 묶음 머리의 상태 막대: 정상·오류·OutOfSync·그 밖의 주의 비율 */
function TallyBar({ t }: { t: Tally }) {
  return (
    <span className="argo-tally" aria-hidden="true">
      <i className="argo-tally-ok" style={{ flex: t.ok }} />
      <i className="argo-tally-err" style={{ flex: t.err }} />
      <i className="argo-tally-out" style={{ flex: t.outOfSync }} />
      <i className="argo-tally-caution" style={{ flex: t.caution }} />
    </span>
  );
}

function count(rows: ArgoAppRow[], of: (r: ArgoAppRow) => string): Record<string, number> {
  const n: Record<string, number> = {};
  for (const r of rows) n[of(r)] = (n[of(r)] ?? 0) + 1;
  return n;
}

interface ChipsProps {
  label: string;
  statuses: readonly string[];
  counts: Record<string, number>;
  picked: Set<string>;
  onToggle: (s: string) => void;
}

function Chips({ label, statuses, counts, picked, onToggle }: ChipsProps) {
  return (
    <div className="k8s-levels" role="group" aria-label={label}>
      {statuses.map((s) => (
        <button key={s} className={`k8s-lvl argo-lvl argo-lvl-${s}`} aria-pressed={picked.has(s)} onClick={() => onToggle(s)}>
          {s} <span className="k8s-lvl-n">{(counts[s] ?? 0).toLocaleString("ko-KR")}</span>
        </button>
      ))}
    </div>
  );
}

/** 한 서버의 Application·ApplicationSet 목록. 행을 누르면 상세가 겹쳐 뜬다. */
export function ArgoView({ url, live, onTokenError, now }: Props) {
  const apps = useApps(url, live);
  const sets = useAppsets(url, live);
  const appRows = useMemo(() => apps.data ?? [], [apps.data]);
  const setRows = useMemo(() => sets.data ?? [], [sets.data]);

  // 토큰 문제는 목록이 아니라 서버 단위의 일이라 토큰 폼으로 돌려보낸다
  const onToken = useRef(onTokenError);
  onToken.current = onTokenError;
  useEffect(() => {
    const bad = [apps.error, sets.error].find(isTokenError);
    if (bad) onToken.current(errorMessage(bad));
  }, [apps.error, sets.error]);

  const [syncPick, setSyncPick] = useState<Set<string>>(new Set());
  const [healthPick, setHealthPick] = useState<Set<string>>(new Set());
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(true);
  // 처음에는 모두 펼친다. 사용자가 머리 줄을 눌러 접은 묶음만 이 탭이 열려 있는 동안 기억한다.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ namespace: string; name: string } | null>(null);
  const at = now ?? Date.now();

  const projects = useMemo(() => [...new Set(appRows.map((r) => r.values.project).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b)), [appRows]);
  // 칩의 개수는 칩을 뺀 조건(프로젝트·이름)에 맞는 앱 기준이라, 칩을 눌러도 다른 칩의 숫자가 변하지 않는다.
  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return appRows.filter((r) => (project === "" || r.values.project === project) && (q === "" || r.name.toLowerCase().includes(q)));
  }, [appRows, project, search]);
  const syncCounts = useMemo(() => count(scoped, syncOf), [scoped]);
  const healthCounts = useMemo(() => count(scoped, healthOf), [scoped]);
  const visible = useMemo(
    () => scoped.filter((r) => (syncPick.size === 0 || syncPick.has(syncOf(r))) && (healthPick.size === 0 || healthPick.has(healthOf(r)))).sort(bySeverityThenName),
    [scoped, syncPick, healthPick],
  );
  const filtering = syncPick.size > 0 || healthPick.size > 0 || project !== "" || search.trim() !== "";

  const groups = useMemo<Group[]>(() => {
    if (!grouped) return [];
    const byKey = new Map<string, Group>();
    for (const s of setRows) byKey.set(rowKey(s.namespace, s.name), { key: rowKey(s.namespace, s.name), name: s.name, set: s, apps: [] });
    const loose: Group = { key: "", name: null, set: null, apps: [] };
    for (const r of visible) {
      const owner = r.values.appSet;
      if (!owner) {
        loose.apps.push(r);
        continue;
      }
      const key = rowKey(r.namespace, owner);
      // 목록에 없는 ApplicationSet(권한이 없거나 이미 지워진 것)도 이름만 달고 묶는다
      const g = byKey.get(key) ?? { key, name: owner, set: null, apps: [] };
      g.apps.push(r);
      byKey.set(key, g);
    }
    // 조건을 걸었을 때는 앱이 하나도 안 남은 ApplicationSet을 감춘다. 조건이 없으면 앱 없는 것(생성 실패)도 보인다.
    const real = [...byKey.values()].filter((g) => g.apps.length > 0 || !filtering);
    // 빨강(오류) → 노랑(주의) → 정상, 같으면 이름 순
    const rank = (g: Group) => LEVEL_RANK[groupLevel(g.set, tally(g.apps))];
    real.sort((a, b) => rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? ""));
    return loose.apps.length > 0 ? [...real, loose] : real;
  }, [grouped, setRows, visible, filtering]);

  const selectedRow = selected ? appRows.find((r) => r.name === selected.name && r.namespace === selected.namespace) : undefined;

  const row = (r: ArgoAppRow) => {
    const v = r.values;
    const errors = Number(v.errors ?? 0);
    const warnings = Number(v.warnings ?? 0);
    const on = selected !== null && selected.name === r.name && selected.namespace === r.namespace;
    const open = () => setSelected(on ? null : { namespace: r.namespace, name: r.name });
    return (
      <tr
        key={rowKey(r.namespace, r.name)}
        className={`argo-row${on ? " on" : ""}${isProblem(r) ? " argo-problem" : ""}`}
        tabIndex={0}
        aria-selected={on}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter") open();
        }}
      >
        <td className="mono k8s-wrap" title={rowKey(r.namespace, r.name)}>
          {r.name}
          {errors > 0 && <span className="k8s-problem argo-chip">{argoErrors(errors)}</span>}
          {warnings > 0 && <span className="k8s-chip argo-chip argo-chip-warn">{argoWarnings(warnings)}</span>}
        </td>
        <td>{v.project ?? ""}</td>
        <td className="mono">{destinationText(v)}</td>
        <td>
          <ArgoBadge status={v.sync ?? "Unknown"} />
        </td>
        <td>
          <ArgoBadge status={v.health ?? "Unknown"} />
        </td>
        <td>
          <ArgoBadge status={v.operation} />
        </td>
        <td className="mono" title={v.targetRevision ?? ""}>
          {v.revision ?? ""}
        </td>
        <td title={v.lastSync ?? ""}>{age(v.lastSync ?? null, at)}</td>
        <td>{v.autoSync === "true" ? ARGO_AUTO_ON : v.autoSync === "false" ? ARGO_AUTO_OFF : ""}</td>
      </tr>
    );
  };

  return (
    <div className="argo">
      {apps.isError && <ErrorState error={apps.error} profile="" compact onRetry={() => void apps.refetch()} />}
      {sets.isError && <ErrorState error={sets.error} profile="" compact onRetry={() => void sets.refetch()} />}
      <div className="argo-bar">
        <Chips label={ARGO_SYNC_GROUP} statuses={ARGO_SYNC_STATUSES} counts={syncCounts} picked={syncPick} onToggle={(s) => setSyncPick((p) => toggled(p, s))} />
        <Chips label={ARGO_HEALTH_GROUP} statuses={ARGO_HEALTH_STATUSES} counts={healthCounts} picked={healthPick} onToggle={(s) => setHealthPick((p) => toggled(p, s))} />
        <select aria-label={ARGO_PROJECT} value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">{ARGO_ALL_PROJECTS}</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input className="k8s-filter" aria-label={ARGO_SEARCH} placeholder={ARGO_SEARCH} value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="k8s-check">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          {ARGO_GROUP_BY_SET}
        </label>
      </div>
      <div className="argo-scroll">
        {apps.isPending ? (
          <div className="empty">{LOADING}</div>
        ) : appRows.length === 0 ? (
          !apps.isError && <div className="empty">{ARGO_NO_APPS}</div>
        ) : visible.length === 0 ? (
          <div className="empty">{ARGO_NO_MATCH}</div>
        ) : (
          // 묶을 때는 카드의 테두리 폭만큼 머리 표도 안쪽으로 들여 열을 카드와 맞춘다
          <div className={grouped ? "argo-cards-head" : undefined}>
            <table className={`k8s-table argo-table${grouped ? " argo-fixed" : ""}`} aria-label={ARGO_APPS_LABEL}>
              {grouped && <Columns />}
              <thead>
                <tr>
                  <th>{COL_NAME}</th>
                  <th>{ARGO_PROJECT}</th>
                  <th>{H_ARGO_DEST}</th>
                  <th>Sync</th>
                  <th>Health</th>
                  <th>{H_ARGO_OPERATION}</th>
                  <th>{H_ARGO_REVISION}</th>
                  <th>{H_ARGO_LAST_SYNC}</th>
                  <th>{H_ARGO_AUTO}</th>
                </tr>
              </thead>
              {!grouped && <tbody>{visible.map(row)}</tbody>}
            </table>
          </div>
        )}
        {grouped && !apps.isPending && visible.length > 0 && (
          <div className="argo-cards">
            {groups.map((g) => {
              const key = g.key || "ungrouped";
              const name = g.name ?? ARGO_UNGROUPED;
              const t = tally(g.apps);
              const open = !folded.has(key);
              return (
                <section key={key} className={`argo-card argo-card-${groupLevel(g.set, t)}`} aria-label={name}>
                  <button className="argo-band" aria-expanded={open} onClick={() => setFolded((f) => toggled(f, key))}>
                    <span className="argo-band-tw">{open ? "▾" : "▸"}</span>
                    <b className="argo-band-name">{name}</b>
                    {g.apps.length > 0 && <TallyBar t={t} />}
                    <span className="argo-band-chips">
                      {t.err > 0 && <span className="argo-badge argo-bad">{argoErrors(t.err)}</span>}
                      {t.outOfSync > 0 && <span className="argo-badge argo-warn">{argoOutOfSync(t.outOfSync)}</span>}
                      {t.caution > 0 && <span className="argo-badge argo-dim">{argoCaution(t.caution)}</span>}
                      {t.ok > 0 && <span className="argo-badge argo-ok">{argoOk(t.ok)}</span>}
                    </span>
                    {g.set && g.set.generators.length > 0 && <span className="dim">{argoGenerators(g.set.generators.join(", "))}</span>}
                    <ArgoBadge status={g.set?.status} />
                    {g.set?.message && <span className="err argo-band-msg">{g.set.message}</span>}
                    <span className="dim">{argoAppCount(g.apps.length)}</span>
                  </button>
                  {open && g.apps.length > 0 && (
                    <table className="k8s-table argo-table argo-card-rows" aria-label={name}>
                      <Columns />
                      <tbody>{g.apps.map(row)}</tbody>
                    </table>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
      {selected && (
        <ArgoDetail
          key={rowKey(selected.namespace, selected.name)}
          url={url}
          namespace={selected.namespace}
          name={selected.name}
          resourceVersion={selectedRow?.resourceVersion ?? null}
          live={live}
          onClose={() => setSelected(null)}
          onTokenError={onTokenError}
          now={now}
          widthPct={DETAIL_PCT}
        />
      )}
    </div>
  );
}
