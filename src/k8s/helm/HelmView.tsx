import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ListFind, useListFind } from "../../components/ListFind";
import { ListTable, type ListColumn } from "../../iam/ListTable";
import { age } from "../format";
import { K8sError } from "../K8sError";
import { DETAIL_PCT, LaneResizer, type Lane } from "../lanes";
import { useK8sRules } from "../queries";
import type { K8sChange, K8sKind, K8sTarget, ObjectRef } from "../types";
import { HelmDetail } from "./HelmDetail";
import { HelmInstallDialog } from "./HelmInstallDialog";
import { helmKeys, useHelmReleases, useHelmTool } from "./queries";
import { StatusBadge } from "./StatusBadge";
import * as t from "./text";
import type { HelmRelease } from "./types";

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  /** 탭이 보이는 동안에만 목록을 다시 읽는다 */
  visible: boolean;
  /** 고른 네임스페이스. 모든 네임스페이스면 null */
  namespace: string | null;
  kinds: K8sKind[];
  /** 방금 적용한 변경. Helm 변경이면 목록과 상세를 바로 다시 읽는다 */
  appliedChange: K8sChange | null;
  onChange: (change: K8sChange) => void;
  /** 리소스를 워크로드 화면에서 연다 */
  onOpenObject: (ref: ObjectRef) => void;
  lanes: {
    width: (lane: Lane) => number | undefined;
    resize: (lane: Lane, width: number) => void;
    commit: (lane: Lane, width: number) => void;
  };
  /** 나이 계산 기준(시험용). 없으면 그리는 시각 */
  now?: number;
}

const keyOf = (r: { namespace: string; name: string }) => `${r.namespace}/${r.name}`;

/** Helm 릴리스 목록(⌘F로 이름·차트·네임스페이스 찾기, 문제 있는 것만)과 70% 상세 */
export function HelmView({ target, context, ssoProfile, live, visible, namespace, kinds, appliedChange, onChange, onOpenObject, lanes, now }: Props) {
  const qc = useQueryClient();
  // ⌘F: 이 목록(과 위에 뜬 상세) 안에서만 찾는다. 평소에는 찾기 줄이 없다
  const pane = useRef<HTMLDivElement>(null);
  const find = useListFind(pane, { enabled: visible });
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [selected, setSelected] = useState<{ namespace: string; name: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const releases = useHelmReleases(target, context, namespace, ssoProfile, live && visible);
  const tool = useHelmTool();
  const rules = useK8sRules(target, context, selected?.namespace ?? null, ssoProfile, live && selected !== null);

  // Helm 변경을 적용하면 목록과 상세를 바로 다시 읽는다
  const seen = useRef(appliedChange);
  useEffect(() => {
    if (appliedChange === seen.current) return;
    seen.current = appliedChange;
    if (appliedChange?.type.startsWith("helm")) void qc.invalidateQueries({ queryKey: helmKeys.root(target) });
  }, [appliedChange, qc, target]);

  const rows = releases.data;
  const needle = find.query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => (!onlyProblems || r.problem) && (needle === "" || [r.name, r.chart, r.namespace, r.status].some((v) => v.toLowerCase().includes(needle))),
      ),
    [rows, onlyProblems, needle],
  );
  const problemCount = (rows ?? []).filter((r) => r.problem).length;
  const at = now ?? Date.now();
  const columns = useMemo<ListColumn<HelmRelease>[]>(
    () => [
      { key: "name", label: t.COL_NAME, render: (r) => <span className="mono">{r.name}</span>, sort: (r) => r.name },
      ...(namespace === null ? [{ key: "namespace", label: t.COL_NAMESPACE, render: (r: HelmRelease) => r.namespace, sort: (r: HelmRelease) => r.namespace }] : []),
      { key: "status", label: t.COL_STATUS, render: (r) => <StatusBadge status={r.status} />, sort: (r) => (r.problem ? 0 : 1) },
      { key: "chart", label: t.COL_CHART, render: (r) => (r.unreadable ? <span className="err">{t.UNREADABLE_ROW}</span> : <span className="mono">{r.chart}</span>), sort: (r) => r.chart },
      { key: "app", label: t.COL_APP_VERSION, render: (r) => r.appVersion, sort: (r) => r.appVersion },
      { key: "revision", label: t.COL_REVISION, render: (r) => r.revision, sort: (r) => r.revision, numeric: true },
      { key: "updated", label: t.COL_UPDATED, render: (r) => <span title={r.updated ?? ""}>{age(r.updated, at)}</span>, sort: (r) => (r.updated ? Date.parse(r.updated) : null), numeric: true },
      { key: "description", label: t.COL_DESCRIPTION, render: (r) => <span className="k8s-wrap">{r.description}</span> },
    ],
    [namespace, at],
  );
  const pick = (id: string, then: (r: HelmRelease) => void) => {
    const row = rows?.find((r) => keyOf(r) === id);
    if (row) then(row);
  };
  const select = (r: HelmRelease) => setSelected({ namespace: r.namespace, name: r.name });
  // 선택한 릴리스가 목록에서 사라지면(삭제) 상세를 닫는다
  useEffect(() => {
    if (selected && rows && !rows.some((r) => keyOf(r) === keyOf(selected))) setSelected(null);
  }, [rows, selected]);
  const detailPct = lanes.width("detailPct") ?? DETAIL_PCT;
  const blocked = tool.data === undefined ? t.TOOL_CHECKING : tool.data.available ? undefined : (tool.data.reason ?? t.TOOL_CHECKING);

  return (
    <div className="k8s-workloads">
      <div className="k8s-list-pane" ref={pane}>
        <div className="k8s-list">
          <ListFind find={find} placeholder={t.FILTER_PLACEHOLDER} count={shown.length} />
          <div className="k8s-list-bar">
            <label className="k8s-check">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              {t.ONLY_PROBLEMS}
            </label>
            {problemCount > 0 && <span className="k8s-chip warn">{t.PROBLEM_COUNT(problemCount)}</span>}
            <span className="dim helm-refresh">{t.REFRESH_HINT}</span>
            <button className="btn small tone-primary" disabled={!!blocked} title={blocked} aria-description={blocked} onClick={() => setInstalling(true)}>
              {t.ACT_INSTALL}
            </button>
          </div>
          {releases.error && <K8sError error={releases.error} target={target} ssoProfile={ssoProfile} compact />}
          {rows === undefined && !releases.error ? (
            <div className="empty">{t.LOADING}</div>
          ) : (
            <ListTable
              label={t.HELM_LABEL}
              rows={shown}
              columns={columns}
              rowKey={keyOf}
              selectedId={selected ? keyOf(selected) : null}
              onSelect={(id) => pick(id, select)}
              onClear={() => setSelected(null)}
              onOpen={(id) => pick(id, select)}
              empty={(rows ?? []).length === 0 ? t.LIST_EMPTY : t.LIST_NO_MATCH}
              vimKeys
            />
          )}
        </div>
        {selected && <LaneResizer lane="detailPct" onResize={lanes.resize} onCommit={lanes.commit} style={{ right: `${detailPct}%` }} />}
        {selected && (
          <HelmDetail
            key={keyOf(selected)}
            target={target}
            context={context}
            ssoProfile={ssoProfile}
            live={live}
            namespace={selected.namespace}
            name={selected.name}
            kinds={kinds}
            tool={tool.data}
            rules={rules.data}
            onChange={onChange}
            onOpenObject={onOpenObject}
            onClose={() => setSelected(null)}
            widthPct={detailPct}
          />
        )}
      </div>
      {installing && (
        <HelmInstallDialog
          namespace={namespace ?? "default"}
          onPreview={(change) => {
            setInstalling(false);
            onChange(change);
          }}
          onClose={() => setInstalling(false)}
        />
      )}
    </div>
  );
}
