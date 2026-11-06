import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { argowfApi } from "./api";
import { useTokenGate } from "./catalogHooks";
import { emptyQuery } from "./wfQuery";
import { CATALOG_POLL_MS } from "./queries";
import type { ArgoWfConn, WfDetail, WfRow, WfTarget } from "./types";

export function Reports({
  conn,
  live,
  namespace,
  onOpenWorkflow,
  onTokenError,
}: {
  conn: ArgoWfConn;
  live: boolean;
  namespace: string | null;
  onOpenWorkflow(t: WfTarget): void;
  onTokenError(m: string): void;
}) {
  const [label, setLabel] = useState("");
  const suggestions = useQuery({
    queryKey: ["argowf", conn.url, "data", "report-suggestions", namespace],
    queryFn: () => argowfApi.workflows(conn, emptyQuery(namespace)),
    refetchInterval: live ? CATALOG_POLL_MS : false,
    retry: false,
  });
  // 상세를 최대 50개 읽으므로 주기적으로 다시 읽지 않는다. [다시 읽기]로만
  const report = useQuery({
    queryKey: ["argowf", conn.url, "data", "report", namespace, label],
    enabled: !!label.trim(),
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      const query = { ...emptyQuery(namespace), labelSelector: label.trim() };
      const collect = async (fetch: typeof argowfApi.workflows) => {
        const rows: WfRow[] = [];
        let token: string | null = null;
        do {
          const page = await fetch(conn, { ...query, continueToken: token });
          rows.push(...page.rows);
          token = page.continueToken;
        } while (token && rows.length < 50);
        return rows;
      };
      const [current, archived] = await Promise.all([collect(argowfApi.workflows), collect(argowfApi.archived)]);
      const seen = new Set<string>();
      const rows = [...current, ...archived]
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
        .filter((r) => {
          if (seen.has(r.uid)) return false;
          seen.add(r.uid);
          return true;
        })
        .slice(0, 50);
      const details: (WfDetail | null)[] = Array(rows.length).fill(null);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, rows.length) }, async () => {
          while (next < rows.length) {
            const i = next++;
            const r = rows[i];
            details[i] = r.archived ? await argowfApi.archivedWorkflow(conn, r.uid) : await argowfApi.workflow(conn, r.namespace, r.name);
          }
        }),
      );
      return details.filter((d): d is WfDetail => d !== null);
    },
  });
  useTokenGate([suggestions.error, report.error], onTokenError);
  const labels = Array.from(
    new Set(
      (suggestions.data?.rows ?? []).flatMap((row: WfRow) =>
        ["workflows.argoproj.io/cron-workflow", "workflows.argoproj.io/workflow-template"].flatMap((key) =>
          row.labels[key] ? [`${key}=${row.labels[key]}`] : [],
        ),
      ),
    ),
  );
  // 오래된 것부터 왼쪽에
  const data = [...(report.data ?? [])].reverse();
  const open = (row: WfRow) => onOpenWorkflow(row.archived ? { kind: "archived", uid: row.uid } : { kind: "live", namespace: row.namespace, name: row.name });
  const tone = (phase: string) => (phase === "Succeeded" ? "ok" : ["Failed", "Error"].includes(phase) ? "bad" : "run");
  const seconds = (d: WfDetail) => (d.row.startedAt && d.row.finishedAt ? Math.max(0, (Date.parse(d.row.finishedAt) - Date.parse(d.row.startedAt)) / 1000) : 0);
  const finished = data.filter((d) => d.row.finishedAt);
  const succeeded = finished.filter((d) => d.row.phase === "Succeeded").length;
  const average = finished.length ? Math.round(finished.reduce((sum, d) => sum + seconds(d), 0) / finished.length) : null;
  const chart = (title: string, unit: string, value: (d: WfDetail) => number) => {
    const max = Math.max(1, ...data.map(value));
    return (
      <section className="awc-report">
        <h3>
          {title}{" "}
          <span className="dim">
            (최대 {Math.round(max)}
            {unit})
          </span>
        </h3>
        <svg role="img" aria-label={title} width={Math.max(400, data.length * 22)} height="140">
          {data.map((d, i) => {
            const v = value(d);
            const h = Math.max(1, (v / max) * 120);
            const text = `${d.row.name}: ${Math.round(v)}${unit}`;
            return (
              <g
                key={d.row.uid}
                role="button"
                tabIndex={0}
                aria-label={text}
                className={`awc-rbar ${tone(d.row.phase)}`}
                onClick={() => open(d.row)}
                onKeyDown={(e) => e.key === "Enter" && open(d.row)}
              >
                <title>{text}</title>
                <rect x={i * 22} y={130 - h} width="16" height={h} />
              </g>
            );
          })}
        </svg>
      </section>
    );
  };
  return (
    <div className="awc">
      <div className="awc-bar">
        <h2 className="awc-title">Reports</h2>
        <input
          className="awc-report-label"
          aria-label="레이블 선택자"
          placeholder="레이블 (예: workflows.argoproj.io/cron-workflow=nightly)"
          list="report-labels"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        {label.trim() && (
          <button className="btn small tone-refresh" disabled={report.isFetching} onClick={() => void report.refetch()}>
            다시 읽기
          </button>
        )}
      </div>
      <datalist id="report-labels">
        {labels.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <div className="awc-body">
        <p className="awc-desc-line">
          레이블 하나를 고르면 그 Workflow(살아 있는 것 + 보관함)의 최근 50개 실행을 막대로 보여 줘요. 막대를 누르면 그 Workflow가 열려요.
        </p>
        {(suggestions.error || report.error) && (
          <p className="err" role="alert">
            {errorMessage(suggestions.error ?? report.error)}
          </p>
        )}
        {report.isFetching && <p className="dim">실행 상세를 읽는 중…</p>}
        {data.length > 0 && (
          <p className="awc-report-sum">
            실행 {data.length}개 · 성공률 {finished.length ? Math.round((succeeded / finished.length) * 100) : 0}% · 평균{" "}
            {average === null ? "—" : `${average}초`}
            <span className="awc-legend ok">성공</span>
            <span className="awc-legend bad">실패</span>
            <span className="awc-legend run">진행 중</span>
          </p>
        )}
        {label.trim() && !report.isFetching && data.length === 0 && !report.error && <p className="dim">이 레이블의 실행이 없어요</p>}
        {data.length > 0 && chart("걸린 시간", "초", seconds)}
        {data.length > 0 && chart("CPU", " CPU·초", (d) => d.resourcesDuration.cpu ?? 0)}
        {data.length > 0 && chart("메모리", " 메모리·초", (d) => d.resourcesDuration.memory ?? 0)}
      </div>
    </div>
  );
}
