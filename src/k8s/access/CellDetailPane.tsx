import { DETAIL_PCT } from "../lanes";
import { useAccessCell } from "./queries";
import { PathList, SubjectName, uniquePaths } from "./paths";
import {
  ALLOWED, CELL_LABELS, H_PATH_COUNT, H_PROBE, H_RESULT, CELL_RULES, CLOSE, DENIED, DETAIL_COLUMN, DETAIL_LABEL, DIRECT, IAM_IDENTITY, INDIRECT, LOADING, NAMES_ONLY, NO_PATHS, OPEN_IAM, PATHS_TITLE, PROBES_TITLE,
  levelText, verbResource,
} from "./text";
import type { Cell, MappingRow, Subject } from "./types";
import type { K8sTarget } from "../types";
import { K8sError } from "../K8sError";
import { CellActions } from "../rbac/CellActions";
import type { K8sChange } from "../types";

interface Props {
  target: K8sTarget;
  context: string | null;
  ssoProfile: string;
  selected: { subject: Subject; cell: Cell; namespace: string | null };
  /** IAM 주체의 매핑(쿠버네티스 사용자·그룹을 보여 준다) */
  mapping?: MappingRow;
  widthPct?: number;
  onClose: () => void;
  onOpenIam?: (arn: string) => void;
  /** 있으면 "권한 바꾸기"(장바구니에 담기·미리보기)를 보인다 */
  onChange?: (change: K8sChange) => void;
}

/** 권한 표 칸 하나의 근거: 확인한 동작마다 허용 여부와, 허용하는 바인딩 경로 */
export function CellDetailPane({ target, context, ssoProfile, selected, mapping, widthPct = DETAIL_PCT, onClose, onOpenIam, onChange }: Props) {
  const q = useAccessCell(target, context, ssoProfile, selected);
  const d = q.data;
  const grants = d ? d.probes.flatMap((p) => p.grants) : [];
  const iamArn = selected.subject.kind === "iam" ? selected.subject.name : null;
  return (
    <aside className="k8s-detail" aria-label={DETAIL_LABEL} style={{ width: `${widthPct}%` }}>
      <div className="k8s-detail-head">
        <b>{CELL_LABELS[selected.cell]}</b>
        <span className="k8s-wrap">
          <SubjectName subject={selected.subject} label={mapping?.label} />
        </span>
        <span className="dim">· {DETAIL_COLUMN(selected.namespace)}</span>
        <button className="icon k8s-push tone-ghost" aria-label={CLOSE} title={CLOSE} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="k8s-actions k8s-toolbar">
        {iamArn && onOpenIam && (
          <button className="btn small tone-nav" onClick={() => onOpenIam(iamArn)}>
            {OPEN_IAM}
          </button>
        )}
      </div>
      <div className="k8s-detail-body">
        {q.isError && <K8sError error={q.error} target={target} ssoProfile={ssoProfile} compact />}
        {!d && !q.isError && <p className="dim">{LOADING}</p>}
        {d && (
          <>
            <p>
              <span className={`acc-level lv${d.level}`}>{levelText(d.cell, d.level)}</span>
              <span className="dim"> {CELL_RULES[d.cell]}</span>
            </p>
            {mapping && (
              <dl className="kv">
                <dt>{IAM_IDENTITY}</dt>
                <dd className="mono k8s-wrap">
                  {mapping.username}
                  {mapping.groups.length > 0 && ` · ${mapping.groups.join(", ")}`}
                </dd>
              </dl>
            )}
            <h5 className="acc-h">{PATHS_TITLE}</h5>
            {grants.length === 0 ? <p className="dim">{NO_PATHS}</p> : <PathList grants={grants} label={PATHS_TITLE} />}
            {onChange && <CellActions target={target} context={context} ssoProfile={ssoProfile} subject={selected.subject} cell={selected.cell} namespace={selected.namespace} grants={grants} mapping={mapping} onStart={onChange} />}
            <h5 className="acc-h">{PROBES_TITLE}</h5>
            <table className="k8s-table" aria-label={PROBES_TITLE}>
              <thead>
                <tr>
                  <th>{H_PROBE}</th>
                  <th>{H_RESULT}</th>
                  <th>{H_PATH_COUNT}</th>
                </tr>
              </thead>
              <tbody>
                {d.probes.map((p) => {
                  const paths = uniquePaths(p.grants);
                  return (
                    <tr key={`${p.query.verb}|${p.query.group}|${p.query.resource}|${p.query.subresource}`}>
                      <td className="mono">{verbResource(p.query.verb, p.query.group, p.query.resource, p.query.subresource)}</td>
                      <td>
                        <span className={`acc-badge ${p.allowed ? "ok" : p.namesOnly ? "warn" : "none"}`}>{p.allowed ? ALLOWED : p.namesOnly ? NAMES_ONLY : DENIED}</span>
                        {d.cell === "escalate" && <span className="dim"> {p.direct ? DIRECT : INDIRECT}</span>}
                      </td>
                      <td className="dim">{paths.length === 0 ? "" : `${paths.length}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </aside>
  );
}
