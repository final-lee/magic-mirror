import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ListTable, type ListColumn } from "../../iam/ListTable";
import { K8sError } from "../K8sError";
import { DETAIL_PCT, LaneResizer, type Lane } from "../lanes";
import type { K8sChange, K8sTarget, ObjectRef } from "../types";
import { ChecksPanel } from "./ChecksPanel";
import { FindingDetail } from "./FindingDetail";
import { Gaps } from "./Gaps";
import {
  DEFAULT_SETTING, NO_FILTER, countFindings, filterFindings, groupByCheck, hiddenSystemCount, skippedTitles, targetLabel, visibleFindings, withIncludeSystem,
  SEVERITY_RANK, type FindingFilter,
} from "./logic";
import { securityKey, useSecurityFindings } from "./queries";
import { SeverityChip } from "./SeverityChip";
import { Summary } from "./Summary";
import {
  ALL_CLEAR, CHECKS_PANEL, CHECKS_PANEL_TITLE, CHECK_BY_ID, FILTER_PLACEHOLDER, FINDINGS_TABLE_LABEL, FIX_AVAILABLE, GROUP_BY_CHECK, GROUP_COLLAPSE, H_CHECK, H_FIX,
  H_MESSAGE, H_NAMESPACE, H_SEVERITY, H_TARGET, INCLUDE_SYSTEM, INCLUDE_SYSTEM_TITLE, LOADING, NO_MATCH, REFRESH, SCOPE_NOTE, SECURITY_LABEL, DASH, fetchedAt, groupCount,
} from "./text";
import type { CheckId, Finding, SecurityChecksSetting } from "./types";

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  /** 저장된 설정(없으면 모든 항목을 켜고 시스템 네임스페이스는 뺀다) */
  setting: SecurityChecksSetting | undefined;
  /** 설정을 바꾼다. 바꾸는 즉시 저장하고 결과에서 걸러 보인다 */
  onSetting: (next: SecurityChecksSetting) => void;
  /** 방금 적용한 변경. 객체를 고치는 변경이면 점검을 바로 다시 읽는다 */
  appliedChange: K8sChange | null;
  /** 고치기: 기존 변경 미리보기를 시작한다 */
  onChange: (change: K8sChange) => void;
  /** 대상 객체를 워크로드 화면에서 연다 */
  onOpenObject: (ref: ObjectRef) => void;
  onOpenIam?: (arn: string) => void;
  onOpenAccess: () => void;
  lanes: {
    width: (lane: Lane) => number | undefined;
    resize: (lane: Lane, width: number) => void;
    commit: (lane: Lane, width: number) => void;
  };
}

function columns(grouped: boolean): ListColumn<Finding>[] {
  return [
    { key: "severity", label: H_SEVERITY, render: (f) => <SeverityChip severity={f.severity} />, sort: (f) => -SEVERITY_RANK[f.severity] },
    ...(grouped ? [] : [{ key: "check", label: H_CHECK, render: (f: Finding) => CHECK_BY_ID[f.check].title, sort: (f: Finding) => CHECK_BY_ID[f.check].title }]),
    { key: "target", label: H_TARGET, render: (f) => <span className="mono">{targetLabel(f.target)}</span>, sort: (f) => targetLabel(f.target) },
    { key: "namespace", label: H_NAMESPACE, render: (f) => f.namespace ?? DASH, sort: (f) => f.namespace },
    { key: "message", label: H_MESSAGE, render: (f) => <span className="k8s-wrap">{f.message}</span> },
    { key: "fix", label: H_FIX, render: (f) => (f.fix ? <span className="sec-fixable">{FIX_AVAILABLE}</span> : DASH), sort: (f) => (f.fix ? 0 : 1) },
  ];
}

/**
 * 보안 점검: 심각도·분류 요약, 문제 목록(검색, 점검 항목별 묶기), 점검 항목 켜고 끄기, 시스템 네임스페이스 제외.
 * 문제를 누르면 목록 너비의 70%를 덮는 상세가 열린다. 읽기만 하고, 고치기는 공통 변경 미리보기로 간다.
 */
export function SecurityView({ target, context, ssoProfile, live, setting, onSetting, appliedChange, onChange, onOpenObject, onOpenIam, onOpenAccess, lanes }: Props) {
  const qc = useQueryClient();
  const q = useSecurityFindings(target, context, ssoProfile, live);
  const [filter, setFilter] = useState<FindingFilter>(NO_FILTER);
  const [grouped, setGrouped] = useState(false);
  const [panel, setPanel] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<CheckId>>(new Set());
  const current = setting ?? DEFAULT_SETTING;

  // 객체를 고치는 변경을 적용하면 점검을 바로 다시 읽는다
  const seen = useRef(appliedChange);
  useEffect(() => {
    if (appliedChange === seen.current) return;
    seen.current = appliedChange;
    if (appliedChange?.type === "apply") void qc.invalidateQueries({ queryKey: securityKey(target, context) });
  }, [appliedChange, qc, target, context]);

  const report = q.data;
  const visible = useMemo(() => (report ? visibleFindings(report.findings, current) : []), [report, current]);
  const shown = useMemo(() => filterFindings(visible, filter), [visible, filter]);
  const counts = useMemo(() => countFindings(visible), [visible]);
  const perCheck = useMemo(() => {
    const out: Partial<Record<CheckId, number>> = {};
    for (const f of report?.findings ?? []) if (current.includeSystem || !f.system) out[f.check] = (out[f.check] ?? 0) + 1;
    return out;
  }, [report, current.includeSystem]);
  const cols = useMemo(() => columns(grouped), [grouped]);
  const groups = useMemo(() => groupByCheck(shown), [shown]);
  const selected = selectedId ? shown.find((f) => f.id === selectedId) : undefined;

  // 고른 문제가 사라지면(고쳤거나 항목을 껐다) 상세를 닫는다
  useEffect(() => {
    if (selectedId && report && !shown.some((f) => f.id === selectedId)) setSelectedId(null);
  }, [shown, selectedId, report]);

  if (q.isError) return <K8sError error={q.error} target={target} ssoProfile={target.profile} />;
  if (!report) return <div className="empty">{LOADING}</div>;
  const refetch = () => void q.refetch();
  const detailPct = lanes.width("detailPct") ?? DETAIL_PCT;
  const table = (rows: Finding[], label: string) => (
    <ListTable
      label={label}
      rows={rows}
      columns={cols}
      rowKey={(f) => f.id}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onClear={() => setSelectedId(null)}
      onOpen={setSelectedId}
      empty={visible.length === 0 ? ALL_CLEAR : NO_MATCH}
    />
  );
  const toggleGroup = (id: CheckId) =>
    setClosed((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="k8s-workloads">
      <div className="k8s-list-pane sec-pane">
        <div className="k8s-list">
          <div className="sec-head">
            <b>{SECURITY_LABEL}</b>
            <span className="dim sec-note">{SCOPE_NOTE}</span>
            <span className="dim sec-fetched">{fetchedAt(report.fetchedAt)}</span>
          </div>
          <Summary counts={counts} severity={filter.severity} category={filter.category} onSeverity={(severity) => setFilter((f) => ({ ...f, severity }))} onCategory={(category) => setFilter((f) => ({ ...f, category }))} hiddenSystem={hiddenSystemCount(report.findings, current)} />
          <div className="k8s-list-bar">
            <input type="search" className="k8s-filter" aria-label={FILTER_PLACEHOLDER} placeholder={FILTER_PLACEHOLDER} value={filter.query} onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))} />
            <label className="k8s-check" title={INCLUDE_SYSTEM_TITLE}>
              <input type="checkbox" checked={current.includeSystem} onChange={(e) => onSetting(withIncludeSystem(current, e.target.checked))} />
              {INCLUDE_SYSTEM}
            </label>
            <label className="k8s-check">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
              {GROUP_BY_CHECK}
            </label>
            <button className={`btn small tone-secondary${panel ? " on" : ""}`} aria-expanded={panel} title={CHECKS_PANEL_TITLE} onClick={() => setPanel((p) => !p)}>
              {CHECKS_PANEL}
            </button>
            <button className="btn small tone-secondary" disabled={q.isFetching} onClick={refetch}>
              {REFRESH}
            </button>
          </div>
          {panel && <ChecksPanel setting={current} counts={perCheck} skipped={report.skipped} onChange={onSetting} />}
          <Gaps gaps={report.gaps} skipped={skippedTitles(report, current)} awsProfile={target.profile} k8sProfile={ssoProfile} onRetry={refetch} />
          {grouped && shown.length > 0 ? (
            <div className="sec-groups">
              {groups.map((g) => {
                const title = CHECK_BY_ID[g.check].title;
                const open = !closed.has(g.check);
                return (
                  <section key={g.check} className="sec-group" aria-label={title}>
                    <button className="sec-group-head" aria-expanded={open} aria-label={GROUP_COLLAPSE(title, open)} title={GROUP_COLLAPSE(title, open)} onClick={() => toggleGroup(g.check)}>
                      <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                      <SeverityChip severity={g.severity} />
                      <b>{title}</b>
                      <span className="k8s-chip">{groupCount(g.findings.length)}</span>
                    </button>
                    {open && table(g.findings, title)}
                  </section>
                );
              })}
            </div>
          ) : (
            table(shown, FINDINGS_TABLE_LABEL)
          )}
        </div>
        {selected && <LaneResizer lane="detailPct" onResize={lanes.resize} onCommit={lanes.commit} style={{ right: `${detailPct}%` }} />}
        {selected && (
          <FindingDetail
            key={selected.id}
            finding={selected}
            target={target}
            context={context}
            ssoProfile={ssoProfile}
            live={live}
            widthPct={detailPct}
            onClose={() => setSelectedId(null)}
            onChange={onChange}
            onOpenObject={onOpenObject}
            onOpenIam={onOpenIam}
            onOpenAccess={onOpenAccess}
          />
        )}
      </div>
    </div>
  );
}
