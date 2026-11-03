import { type ChangeEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { age } from "../k8s/format";
import { DETAIL_PCT } from "../k8s/lanes";
import { ARGO_ENVS, type ArgoEnv, envOf } from "./argoEnv";
import { type LabelPick, labelMatch, labelOptions, parsePick, pickText, searchMatch } from "./argoFilter";
import { type Group, type GroupDim, type Tally, bySeverityThenName, buildGroups, clusterOf, clusterText, dimText, groupLevel, isProblem, labelDim, labelKey, labelKeys, namespaceOf, parseDim, projectOf, rowKey, tally } from "./argoGroup";
import { ArgoBadge } from "./argoParts";
import { ArgoDetail } from "./ArgoDetail";
import { ArgoLabelFilter } from "./ArgoLabelFilter";
import { ArgoMultiSelect } from "./ArgoMultiSelect";
import { isTokenError, useApps, useAppsets } from "./queries";
import {
  ARGO_APPS_LABEL, ARGO_AUTO_OFF, ARGO_AUTO_ON, ARGO_CLUSTER_FILTER, ARGO_ENV_GROUP, ARGO_ENV_SOURCE, ARGO_ENV_TEXT, ARGO_GROUP_BY, ARGO_GROUP_THEN, ARGO_HEALTH_GROUP,
  ARGO_HEALTH_STATUSES, ARGO_NO_APPS, ARGO_NO_MATCH, ARGO_PROJECT, ARGO_SEARCH, ARGO_SYNC_GROUP, ARGO_SYNC_STATUSES, COL_NAME, H_ARGO_AUTO, H_ARGO_DEST, H_ARGO_ENV,
  H_ARGO_LAST_SYNC, H_ARGO_OPERATION, H_ARGO_REVISION, LOADING, ARGO_EXPAND_ALL, ARGO_FOLD_OK, argoAppCount, argoCaution, argoErrors, argoGenerators, argoOk, argoOkApps, argoOutOfSync, argoWarnings,
} from "./text";
import type { ArgoAppRow, ArgoViewState } from "./types";

interface Props {
  /** ArgoCD 서버 주소 */
  url: string;
  /** 탭이 보이는 동안만 10초마다 다시 읽는다 */
  live: boolean;
  /** 토큰이 없거나 무효라는 오류가 나면 부른다(메시지 포함) */
  onTokenError: (message: string) => void;
  now?: number;
  /** 이 서버에서 지난번에 고른 필터·묶기(없으면 기본: ApplicationSet으로 묶고 거르지 않는다) */
  saved?: ArgoViewState | null;
  /** 필터·묶기를 바꿀 때마다 부른다(검색어는 넣지 않는다) */
  onSave?: (view: ArgoViewState) => void;
}

/** 알려진 상태가 아니거나 없으면 Unknown 칸으로 센다 */
const bucket = (value: string | undefined, list: readonly string[]) => (value && list.includes(value) ? value : "Unknown");
const syncOf = (r: ArgoAppRow) => bucket(r.values.sync, ARGO_SYNC_STATUSES);
const healthOf = (r: ArgoAppRow) => bucket(r.values.health, ARGO_HEALTH_STATUSES);
const envNameOf = (r: ArgoAppRow) => envOf(r).env;

const toggled = <T,>(set: Set<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
};

/** 대상 클러스터: 이 ArgoCD가 있는 클러스터(in-cluster)는 "이 클러스터"로 */
const destinationText = (r: ArgoAppRow) => [clusterText(clusterOf(r)), namespaceOf(r)].filter(Boolean).join("/");

/** 열 너비를 고정해 묶음 카드가 나뉘어도 열이 위아래로 맞는다. 환경 열이 있을 때와 없을 때(환경으로 묶을 때)의 두 벌 */
const COLUMN_WIDTHS = ["22%", "9%", "16%", "8%", "8%", "8%", "15%", "8%", "6%"];
const COLUMN_WIDTHS_WITH_ENV = ["18%", "7%", "9%", "15%", "8%", "8%", "8%", "13%", "8%", "6%"];
const Columns = ({ withEnv }: { withEnv: boolean }) => (
  <colgroup>
    {(withEnv ? COLUMN_WIDTHS_WITH_ENV : COLUMN_WIDTHS).map((w, i) => (
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

/** 묶음 머리의 요약 칩(앱 하나는 한 칸으로만 센다) */
const TallyChips = ({ t }: { t: Tally }) => (
  <span className="argo-band-chips">
    {t.err > 0 && <span className="argo-badge argo-bad">{argoErrors(t.err)}</span>}
    {t.outOfSync > 0 && <span className="argo-badge argo-warn">{argoOutOfSync(t.outOfSync)}</span>}
    {t.caution > 0 && <span className="argo-badge argo-dim">{argoCaution(t.caution)}</span>}
    {t.ok > 0 && <span className="argo-badge argo-ok">{argoOk(t.ok)}</span>}
  </span>
);

/** 환경 이름표. 마우스를 올리면 어디서 읽었는지 보인다 */
function EnvBadge({ row }: { row: ArgoAppRow }) {
  const { env, source } = envOf(row);
  return (
    <span className={`argo-envb argo-env-${env}`} title={ARGO_ENV_SOURCE[source ?? "none"]}>
      {ARGO_ENV_TEXT[env]}
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
  /** 칩 앞 점의 색을 정하는 클래스 */
  dot: (s: string) => string;
  text?: (s: string) => string;
}

function Chips({ label, statuses, counts, picked, onToggle, dot, text }: ChipsProps) {
  return (
    <div className="k8s-levels" role="group" aria-label={label}>
      {statuses.map((s) => (
        <button key={s} className={`k8s-lvl argo-lvl ${dot(s)}`} aria-pressed={picked.has(s)} onClick={() => onToggle(s)}>
          {text ? text(s) : s} <span className="k8s-lvl-n">{(counts[s] ?? 0).toLocaleString("ko-KR")}</span>
        </button>
      ))}
    </div>
  );
}

/** 묶기 기준 목록: 데이터에 있는 레이블 키마다 하나씩. exclude는 1단계에서 이미 고른 기준 */
const dimsFor = (keys: string[], exclude: GroupDim | null): GroupDim[] =>
  (["set", "env", "cluster", "project", "namespace", ...keys.map(labelDim), "none"] as GroupDim[]).filter((d) => d === "none" || d !== exclude);

/** 한 서버의 Application·ApplicationSet 목록. 행을 누르면 상세가 겹쳐 뜬다. */
export function ArgoView({ url, live, onTokenError, now, saved, onSave }: Props) {
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

  const [syncPick, setSyncPick] = useState<Set<string>>(() => new Set(saved?.sync));
  const [healthPick, setHealthPick] = useState<Set<string>>(() => new Set(saved?.health));
  const [envPick, setEnvPick] = useState<Set<ArgoEnv>>(() => new Set((saved?.envs ?? []).filter((e): e is ArgoEnv => (ARGO_ENVS as readonly string[]).includes(e))));
  const [clusterPick, setClusterPick] = useState<Set<string>>(() => new Set(saved?.clusters));
  const [projectPick, setProjectPick] = useState<Set<string>>(() => new Set(saved?.projects));
  const [labelPicks, setLabelPicks] = useState<LabelPick[]>(() => (saved?.labels ?? []).map(parsePick).filter((p): p is LabelPick => p !== null));
  const [search, setSearch] = useState("");
  const [primary, setPrimary] = useState<GroupDim>(() => parseDim(saved?.groupBy) ?? "set");
  const [secondaryPick, setSecondaryPick] = useState<GroupDim>(() => parseDim(saved?.thenBy) ?? "none");
  // 문제가 있는 묶음은 펴고, 정상인 묶음·정상 행은 접어 문제를 먼저 보인다. 사용자가 직접 펴거나 접은 것은 탭이 열린 동안 그대로 둔다.
  const [manual, setManual] = useState<Map<string, boolean>>(new Map());
  // "모두 펼치기": 기본을 모두 펼침으로 바꾼다. 다시 누르면 처음 규칙(정상 접기)으로 돌아간다. 둘 다 그동안 직접 펴고 접은 것은 잊는다.
  const [allOpen, setAllOpen] = useState(false);
  const [selected, setSelected] = useState<{ namespace: string; name: string } | null>(null);
  const at = now ?? Date.now();

  // 고른 필터·묶기를 서버별로 남긴다. 처음 그린 상태(지난번에 남긴 것)와 같으면 다시 저장하지 않는다.
  const viewState = useMemo<ArgoViewState>(
    () => ({
      sync: [...syncPick],
      health: [...healthPick],
      envs: [...envPick],
      clusters: [...clusterPick],
      projects: [...projectPick],
      labels: labelPicks.map(pickText),
      groupBy: primary,
      thenBy: secondaryPick,
    }),
    [syncPick, healthPick, envPick, clusterPick, projectPick, labelPicks, primary, secondaryPick],
  );
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const lastSaved = useRef<string | null>(null);
  lastSaved.current ??= JSON.stringify(viewState);
  useEffect(() => {
    const text = JSON.stringify(viewState);
    if (text === lastSaved.current) return;
    lastSaved.current = text;
    onSaveRef.current?.(viewState);
  }, [viewState]);

  // 2단계는 1단계와 같을 수 없고, 1단계가 없음이면 쓸 수 없다(없음으로 본다)
  const secondary: GroupDim = primary === "none" || secondaryPick === primary ? "none" : secondaryPick;
  const grouped = primary !== "none";
  // 환경으로 묶으면 환경 열은 군더더기라 뺀다
  const showEnv = primary !== "env" && secondary !== "env";

  const clusters = useMemo(() => [...new Set(appRows.map(clusterOf).filter(Boolean))].map((value) => ({ value, text: clusterText(value) })).sort((a, b) => a.text.localeCompare(b.text)), [appRows]);
  const projects = useMemo(() => [...new Set(appRows.map(projectOf).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [appRows]);
  const envs = useMemo(() => ARGO_ENVS.filter((e) => appRows.some((r) => envNameOf(r) === e)), [appRows]);
  const keys = useMemo(() => [...new Set([...labelKeys(appRows), ...[primary, secondaryPick].map(labelKey).filter((k): k is string => k !== null)])].sort((a, b) => a.localeCompare(b)), [appRows, primary, secondaryPick]);

  // 조건 종류마다 앱을 거르는 함수. Sync와 Health는 한 묶음(chips)으로 취급한다.
  const tests = useMemo(() => {
    const q = search.trim().toLowerCase();
    return {
      search: (r: ArgoAppRow) => q === "" || searchMatch(q, r),
      sync: (r: ArgoAppRow) => syncPick.size === 0 || syncPick.has(syncOf(r)),
      health: (r: ArgoAppRow) => healthPick.size === 0 || healthPick.has(healthOf(r)),
      env: (r: ArgoAppRow) => envPick.size === 0 || envPick.has(envNameOf(r)),
      cluster: (r: ArgoAppRow) => clusterPick.size === 0 || clusterPick.has(clusterOf(r)),
      project: (r: ArgoAppRow) => projectPick.size === 0 || projectPick.has(projectOf(r)),
      label: (r: ArgoAppRow) => labelPicks.length === 0 || labelMatch(labelPicks, r),
    };
  }, [search, syncPick, healthPick, envPick, clusterPick, projectPick, labelPicks]);
  const filtering = syncPick.size + healthPick.size + envPick.size + clusterPick.size + projectPick.size + labelPicks.length > 0 || search.trim() !== "";

  // 선택지 옆의 개수는 그 종류의 선택만 뺀 나머지 조건에 맞는 앱 기준이라, 고르는 중에도 자기 숫자는 변하지 않는다.
  // Sync·Health 칩은 둘 다 뺀 기준(서로의 선택에도 숫자가 변하지 않는다).
  const view = useMemo(() => {
    const keysOfTests = Object.keys(tests) as (keyof typeof tests)[];
    const passing = (skip: (keyof typeof tests)[]) => appRows.filter((r) => keysOfTests.every((k) => skip.includes(k) || tests[k](r)));
    const status = passing(["sync", "health"]);
    return {
      visible: passing([]).sort(bySeverityThenName),
      syncCounts: count(status, syncOf),
      healthCounts: count(status, healthOf),
      envCounts: count(passing(["env"]), envNameOf),
      clusterCounts: count(passing(["cluster"]), clusterOf),
      projectCounts: count(passing(["project"]), projectOf),
      labelOpts: labelOptions(appRows, passing(["label"])),
    };
  }, [appRows, tests]);
  const { visible } = view;

  const groups = useMemo(
    () =>
      grouped
        ? buildGroups(primary as Exclude<GroupDim, "none">, visible, setRows, filtering).map((g) => ({
            g,
            subs: secondary === "none" ? null : buildGroups(secondary, g.apps, [], true),
          }))
        : [],
    [grouped, primary, secondary, visible, setRows, filtering],
  );

  const selectedRow = selected ? appRows.find((r) => r.name === selected.name && r.namespace === selected.namespace) : undefined;
  // Sync·Health 칩이나 검색으로 직접 찾을 때는 찾은 것을 접지 않는다
  const quietOk = syncPick.size === 0 && healthPick.size === 0 && search.trim() === "";
  const isOpen = (id: string, byDefault: boolean) => manual.get(id) ?? (allOpen || byDefault);
  const setOpen = (id: string, open: boolean) => setManual((m) => new Map(m).set(id, open));
  const colCount = showEnv ? 10 : 9;

  const row = (r: ArgoAppRow, inSub = false) => {
    const v = r.values;
    const errors = Number(v.errors ?? 0);
    const warnings = Number(v.warnings ?? 0);
    const on = selected !== null && selected.name === r.name && selected.namespace === r.namespace;
    const open = () => setSelected(on ? null : { namespace: r.namespace, name: r.name });
    return (
      <tr
        key={rowKey(r.namespace, r.name)}
        className={`argo-row${on ? " on" : ""}${isProblem(r) ? " argo-problem" : ""}${inSub ? " argo-in-sub" : ""}`}
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
        {showEnv && (
          <td>
            <EnvBadge row={r} />
          </td>
        )}
        <td>{v.project ?? ""}</td>
        <td className="mono">{destinationText(r)}</td>
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

  /** 행 목록: 문제 행 다음에 정상 행. 문제와 정상이 섞여 있으면 정상 행은 한 줄로 접고, 그 줄에 정상 앱 이름을 늘어놓아 무엇이 있는지 보이게 한다 */
  const rowsOf = (id: string, rows: ArgoAppRow[], inSub: boolean) => {
    const bad = rows.filter(isProblem);
    const ok = rows.filter((r) => !isProblem(r));
    if (!quietOk || bad.length === 0 || ok.length === 0) return rows.map((r) => row(r, inSub));
    const okId = `${id}|ok`;
    const open = isOpen(okId, false);
    return [
      ...bad.map((r) => row(r, inSub)),
      <tr key={okId} className={`argo-okfold${inSub ? " argo-in-sub" : ""}`}>
        <td colSpan={colCount}>
          <button className="argo-okfold-btn" aria-expanded={open} onClick={() => setOpen(okId, !open)}>
            <span className="argo-band-tw">{open ? "▾" : "▸"}</span>
            <span className="argo-badge argo-ok">{argoOkApps(ok.length)}</span>
            {!open && <span className="argo-okfold-names mono">{ok.map((r) => r.name).join(" · ")}</span>}
          </button>
        </td>
      </tr>,
      ...(open ? ok.map((r) => row(r, inSub)) : []),
    ];
  };

  /** 카드 안의 2단계 묶음: 접을 수 있는 소제목 줄 다음에 그 묶음의 행. 모두 정상이면 처음에 접어 둔다 */
  const subgroup = (cardId: string, sg: Group) => {
    const id = `${cardId}|${secondary}|${sg.id}`;
    const t = tally(sg.apps);
    const open = isOpen(id, !quietOk || t.ok < sg.apps.length);
    return (
      <Fragment key={id}>
        <tr className="argo-subgroup">
          <td colSpan={colCount}>
            <button className="argo-subband" aria-expanded={open} onClick={() => setOpen(id, !open)}>
              <span className="argo-band-tw">{open ? "▾" : "▸"}</span>
              <b>{sg.name}</b>
              <TallyChips t={t} />
              <span className="dim">{argoAppCount(sg.apps.length)}</span>
            </button>
          </td>
        </tr>
        {open && rowsOf(id, sg.apps, true)}
      </Fragment>
    );
  };

  /** 1단계 묶음의 카드. 정상 카드는 처음에 접어 얇은 머리 줄만 보인다 */
  const card = (id: string, g: Group, subs: Group[] | null) => {
    const t = tally(g.apps);
    const level = groupLevel(g.set, t);
    const open = isOpen(id, !quietOk || level !== "ok");
    return (
      <section key={id} className={`argo-card argo-card-${level}${level === "ok" && !open ? " argo-card-quiet" : ""}`} aria-label={g.name}>
        <button className="argo-band" aria-expanded={open} onClick={() => setOpen(id, !open)}>
          <span className="argo-band-tw">{open ? "▾" : "▸"}</span>
          <b className="argo-band-name">{g.name}</b>
          {g.apps.length > 0 && <TallyBar t={t} />}
          <TallyChips t={t} />
          {g.set && g.set.generators.length > 0 && <span className="dim">{argoGenerators(g.set.generators.join(", "))}</span>}
          <ArgoBadge status={g.set?.status} />
          {g.set?.message && <span className="err argo-band-msg">{g.set.message}</span>}
          <span className="dim">{argoAppCount(g.apps.length)}</span>
        </button>
        {open && g.apps.length > 0 && (
          <table className="k8s-table argo-table argo-card-rows" aria-label={g.name}>
            <Columns withEnv={showEnv} />
            <tbody>{subs ? subs.map((sg) => subgroup(id, sg)) : rowsOf(id, g.apps, false)}</tbody>
          </table>
        )}
      </section>
    );
  };

  const onDim = (set: (d: GroupDim) => void) => (e: ChangeEvent<HTMLSelectElement>) => set(e.target.value as GroupDim);

  return (
    <div className="argo">
      {apps.isError && <ErrorState error={apps.error} profile="" compact onRetry={() => void apps.refetch()} />}
      {sets.isError && <ErrorState error={sets.error} profile="" compact onRetry={() => void sets.refetch()} />}
      <div className="argo-bar">
        <Chips label={ARGO_SYNC_GROUP} statuses={ARGO_SYNC_STATUSES} counts={view.syncCounts} picked={syncPick} onToggle={(s) => setSyncPick((p) => toggled(p, s))} dot={(s) => `argo-lvl-${s}`} />
        <Chips label={ARGO_HEALTH_GROUP} statuses={ARGO_HEALTH_STATUSES} counts={view.healthCounts} picked={healthPick} onToggle={(s) => setHealthPick((p) => toggled(p, s))} dot={(s) => `argo-lvl-${s}`} />
        <Chips
          label={ARGO_ENV_GROUP}
          statuses={envs}
          counts={view.envCounts}
          picked={envPick}
          onToggle={(s) => setEnvPick((p) => toggled(p, s as ArgoEnv))}
          dot={(s) => `argo-env-${s}`}
          text={(s) => ARGO_ENV_TEXT[s as ArgoEnv]}
        />
        <ArgoMultiSelect
          label={ARGO_CLUSTER_FILTER}
          options={clusters.map((c) => ({ ...c, count: view.clusterCounts[c.value] ?? 0 }))}
          picked={clusterPick}
          onToggle={(v) => setClusterPick((p) => toggled(p, v))}
          onClear={() => setClusterPick(new Set())}
        />
        <ArgoMultiSelect
          label={ARGO_PROJECT}
          options={projects.map((p) => ({ value: p, text: p, count: view.projectCounts[p] ?? 0 }))}
          picked={projectPick}
          onToggle={(v) => setProjectPick((p) => toggled(p, v))}
          onClear={() => setProjectPick(new Set())}
        />
        <ArgoLabelFilter
          options={view.labelOpts}
          picks={labelPicks}
          onAdd={(p) => setLabelPicks((l) => [...l, p])}
          onRemove={(p) => setLabelPicks((l) => l.filter((x) => x !== p))}
        />
        <input className="k8s-filter" aria-label={ARGO_SEARCH} placeholder={ARGO_SEARCH} value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="argo-group-pick">
          {ARGO_GROUP_BY}
          <select value={primary} onChange={onDim(setPrimary)}>
            {dimsFor(keys, null).map((d) => (
              <option key={d} value={d}>
                {dimText(d)}
              </option>
            ))}
          </select>
        </label>
        <label className="argo-group-pick">
          {ARGO_GROUP_THEN}
          <select value={secondary} disabled={primary === "none"} onChange={onDim(setSecondaryPick)}>
            {dimsFor(keys, primary).map((d) => (
              <option key={d} value={d}>
                {dimText(d)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn small tone-secondary"
          onClick={() => {
            setAllOpen(!allOpen);
            setManual(new Map());
          }}
        >
          {allOpen ? ARGO_FOLD_OK : ARGO_EXPAND_ALL}
        </button>
      </div>
      <div
        className="argo-scroll"
        onClick={(e) => {
          // 행·머리글·묶음 단추 밖의 빈 곳을 누르면 선택을 푼다
          if (!(e.target as Element).closest("thead, tbody tr, button")) setSelected(null);
        }}
      >
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
              {grouped && <Columns withEnv={showEnv} />}
              <thead>
                <tr>
                  <th>{COL_NAME}</th>
                  {showEnv && <th>{H_ARGO_ENV}</th>}
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
              {!grouped && <tbody>{rowsOf("flat", visible, false)}</tbody>}
            </table>
          </div>
        )}
        {grouped && !apps.isPending && visible.length > 0 && (
          <div className="argo-cards">
            {groups.map(({ g, subs }) => card(`${primary}|${g.id}`, g, subs))}
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
