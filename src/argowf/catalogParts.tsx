import type { ReactNode } from "react";
import { DETAIL_PCT } from "../k8s/lanes";
import { isFailed, RUNS_SHOWN } from "./catalogData";
import { durationText, relTime } from "./catalogFormat";
import {
  CAT_CLOSE,
  CAT_NO_RUNS,
  CAT_ORIGIN_CRON,
  CAT_ORIGIN_DIRECT,
  CAT_ORIGIN_TEMPLATE,
  COL_DURATION,
  COL_MESSAGE,
  COL_NAME,
  COL_STARTED,
  COL_STATE,
  runsLabel,
} from "./catalogText";
import type { WfRow } from "./types";

/** 이름·값 목록 한 칸. 값이 없으면 줄을 그리지 않는다 */
export function Kv({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "" || children === false) return null;
  return (
    <div className="k8s-kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Sect({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="k8s-sect" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** phase 색 점. 모르는 phase는 회색 */
export const PhaseDot = ({ phase }: { phase: string }) => <span className={`awc-dot awc-dot-${phase || "none"}`} aria-hidden="true" />;

/** 상태 칸: phase 점 + 이름 + 진행(`3/7`) */
export function PhaseCell({ row }: { row: WfRow }) {
  return (
    <span className="awc-phase">
      <PhaseDot phase={row.phase} />
      {row.phase || "–"}
      {row.progress && <span className="dim awc-progress">{row.progress}</span>}
    </span>
  );
}

/** 원천 칸: `⏱ cron` · `📄 template` · `직접` */
export function OriginCell({ row }: { row: WfRow }) {
  if (!row.cron && !row.template) return <span className="dim">{CAT_ORIGIN_DIRECT}</span>;
  return (
    <span className="awc-origin">
      {row.cron && <span className="mono">{CAT_ORIGIN_CRON(row.cron)}</span>}
      {row.template && <span className="mono">{CAT_ORIGIN_TEMPLATE(row.template)}</span>}
    </span>
  );
}

/** 막대 한 칸의 색 종류 */
const runClass = (phase: string) => (phase === "Succeeded" ? "ok" : isFailed(phase) ? "fail" : phase === "Running" ? "run" : "other");

/** 최근 실행 막대. runs는 최근 것부터, 막대는 오래된 것이 왼쪽 */
export function RunsBar({ runs, now }: { runs: readonly WfRow[]; now: number }) {
  const shown = runs.slice(0, RUNS_SHOWN).reverse();
  return (
    <span className="awc-runs" role="img" aria-label={runsLabel(shown.map((w) => w.phase))}>
      {Array.from({ length: RUNS_SHOWN - shown.length }, (_, i) => (
        <i key={`none${i}`} className="awc-run none" />
      ))}
      {shown.map((w) => (
        <i key={w.uid || w.name} className={`awc-run ${runClass(w.phase)}`} title={`${w.name} · ${w.phase || "–"} · ${relTime(w.startedAt, now)}`} />
      ))}
    </span>
  );
}

/** 상세의 실행 목록(Cron·템플릿의 이력). 행을 누르면 그 Workflow 상세로 */
export function RunsTable({ runs, now, onOpen }: { runs: readonly WfRow[]; now: number; onOpen: (row: WfRow) => void }) {
  if (runs.length === 0) return <p className="dim">{CAT_NO_RUNS}</p>;
  return (
    <table className="k8s-table awc-table">
      <thead>
        <tr>
          <th>{COL_NAME}</th>
          <th>{COL_STATE}</th>
          <th>{COL_STARTED}</th>
          <th>{COL_DURATION}</th>
          <th>{COL_MESSAGE}</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((w) => (
          <tr
            key={w.uid || `${w.namespace}/${w.name}`}
            className="awc-row"
            tabIndex={0}
            onClick={() => onOpen(w)}
            onKeyDown={(e) => e.key === "Enter" && onOpen(w)}
          >
            <td className="mono k8s-wrap">{w.name}</td>
            <td>
              <PhaseCell row={w} />
            </td>
            <td title={w.startedAt ?? ""}>{relTime(w.startedAt, now)}</td>
            <td>{durationText(w.startedAt, w.finishedAt, now)}</td>
            <td className={isFailed(w.phase) ? "err awc-msg" : "awc-msg"} title={w.message ?? ""}>
              {w.message}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface FrameProps {
  /** 접근성 이름(aside) */
  label: string;
  /** 머리 앞의 종류 글자(CronWorkflow 등) */
  kind: string;
  title: string;
  actions: ReactNode;
  tabs: [string, string][];
  tab: string;
  onTab: (id: string) => void;
  onClose: () => void;
  /** 머리 아래(동작 결과·오류) */
  banner?: ReactNode;
  children: ReactNode;
}

/** 오른쪽에 겹쳐 뜨는 상세의 틀(ArgoDetail과 같은 모양): 머리·동작·닫기, 탭, 본문 */
export function DetailFrame({ label, kind, title, actions, tabs, tab, onTab, onClose, banner, children }: FrameProps) {
  return (
    <aside className="k8s-detail" aria-label={label} style={{ width: `${DETAIL_PCT}%` }}>
      <div className="k8s-detail-head">
        <b>{kind}</b>
        <span className="mono k8s-wrap">{title}</span>
        <span className="awc-acts k8s-push">{actions}</span>
        <button className="icon" aria-label={CAT_CLOSE} title={CAT_CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      {banner}
      <div role="tablist" className="k8s-tabs">
        {tabs.map(([id, text]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>
            {text}
          </button>
        ))}
      </div>
      <div className="k8s-detail-body">{children}</div>
    </aside>
  );
}
