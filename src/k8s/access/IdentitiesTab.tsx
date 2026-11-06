import { Fragment, useMemo, useRef, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { ListFind, useListFind } from "../../components/ListFind";
import { vimTableKeys } from "../../iam/ListTable";
import { fuzzyKeep } from "../../lib/fuzzy";
import type { K8sChange, K8sTarget } from "../types";
import { EntryActions, EntryCreateButton } from "../rbac/EntryActions";
import {
  AWS_AUTH_NONE, AWS_AUTH_PRESENT, COLLAPSE, CELL_GLYPHS, CELL_LABELS, CELLS, DANGLING_TITLE, EFFECTIVE, EKS_SECTIONS, EXPAND, H_GROUPS, H_POLICIES, H_PRINCIPAL, H_SOURCE, H_STATE,
  H_SUMMARY, H_USERNAME, IDENTITIES_LABEL, IDENTITY_FILTER, INACTIVE, MODE_LABEL, MODE_NOTES, MODE_UNKNOWN, NONE, NOT_EVALUATED, NO_IDENTITY_MATCH, NO_MAPPINGS, OPEN_IAM, RBAC_MISSING, SECTION_LABELS, SEE_MATRIX, SEE_MATRIX_TITLE,
  SOURCE_LABELS, SSO_GROUP_TITLE, awsAuthAccounts, danglingText, fetchedAt, gapText, levelText, policyScopeText, ssoGroupRow,
} from "./text";
import type { AccessView, MappingRow, Subject } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  view: AccessView;
  onRetry: () => void;
  onOpenIam?: (arn: string) => void;
  /** 권한 표에서 이 주체를 본다 */
  onOpenSubject: (subject: Subject) => void;
  onChange?: (change: K8sChange) => void;
}

/** 권한 요약: 클러스터 전체 열의 일곱 칸을 작은 표시로 */
function Summary({ levels, name }: { levels: number[]; name: string }) {
  return (
    <span className="acc-cells" role="img" aria-label={`${name}: ${CELLS.map((c, i) => `${CELL_LABELS[c]} ${levelText(c, levels[i] ?? 0)}`).join(", ")}`}>
      {CELLS.map((c, i) => (
        <span key={c} className={`acc-cell static lv${levels[i] ?? 0}${c === "escalate" ? " esc" : ""}`} title={`${CELL_LABELS[c]}: ${levelText(c, levels[i] ?? 0)}`}>
          {CELL_GLYPHS[c]}
        </span>
      ))}
    </span>
  );
}

function Row({ m, indent, onOpenIam, onOpenSubject, onChange, mode }: { m: MappingRow; indent?: boolean; mode: AccessView["mode"] } & Pick<Props, "onOpenIam" | "onOpenSubject" | "onChange">) {
  return (
    <tr tabIndex={-1} className={m.effective ? undefined : "acc-inactive"}>
      <td className={indent ? "acc-indent" : undefined}>
        <div className="acc-principal">
          <b>{m.label}</b>
          <span className="mono dim k8s-wrap" title={m.principalArn}>{m.principalArn}</span>
        </div>
        <div className="acc-row-actions">
          {onOpenIam && m.kind !== "other" && (
            <button className="link tone-nav" onClick={() => onOpenIam(m.principalArn)}>
              {OPEN_IAM}
            </button>
          )}
          {m.subject && (
            <button className="link tone-nav" title={SEE_MATRIX_TITLE} onClick={() => onOpenSubject(m.subject!)}>
              {SEE_MATRIX}
            </button>
          )}
          {onChange && <EntryActions m={m} mode={mode} onChange={onChange} />}
        </div>
      </td>
      <td>
        {SOURCE_LABELS[m.source]}
        {m.accessType && m.accessType !== "STANDARD" && <span className="dim"> · {m.accessType}</span>}
      </td>
      <td className="mono k8s-wrap">{m.username}</td>
      <td className="mono k8s-wrap">{m.groups.length > 0 ? m.groups.join(", ") : <span className="dim">{NONE}</span>}</td>
      <td>
        {m.policies.length === 0 && <span className="dim">{NONE}</span>}
        {m.policies.map((p) => (
          <div key={p.policyArn + JSON.stringify(p.scope)}>
            <span className="mono">{p.policyName}</span> <span className="dim">· {policyScopeText(p.scope)}</span>
            {p.role === null && <span className="acc-badge warn">{NOT_EVALUATED}</span>}
          </div>
        ))}
      </td>
      <td>
        <span className={`acc-badge ${m.effective ? "ok" : "none"}`}>{m.effective ? EFFECTIVE : INACTIVE}</span>
        {m.inactiveReason && <div className="dim">{m.inactiveReason}</div>}
      </td>
      <td>{m.levels ? <Summary levels={m.levels} name={m.label} /> : <span className="dim">-</span>}</td>
    </tr>
  );
}

/** 신원 연결: IAM 주체가 쿠버네티스에서 누가 되는지(access entry와 aws-auth), 어느 쪽이 유효한지, SSO 권한 세트별 묶음 */
export function IdentitiesTab({ target, ssoProfile, view, onRetry, onOpenIam, onOpenSubject, onChange }: Props) {
  // ⌘F: 이 표 안에서만 찾는다. 찾는 동안에는 권한 세트 묶음을 풀어 맞는 행만 바로 보인다
  const tab = useRef<HTMLDivElement>(null);
  const find = useListFind(tab);
  const [grouped, setGrouped] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (set: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(set)) next.add(set);
      return next;
    });
  const searching = find.query.trim() !== "";
  const mappings = useMemo(
    () =>
      searching
        ? fuzzyKeep(view.mappings, find.query, (m) => [m.label, m.principalArn, m.username, m.permissionSet, SOURCE_LABELS[m.source], ...m.groups, ...m.policies.map((p) => p.policyName)])
        : view.mappings,
    [view.mappings, find.query, searching],
  );
  const bySet = new Map<string, MappingRow[]>();
  const plain: MappingRow[] = [];
  for (const m of mappings) {
    if (grouped && !searching && m.permissionSet) {
      const list = bySet.get(m.permissionSet) ?? [];
      list.push(m);
      bySet.set(m.permissionSet, list);
    } else {
      plain.push(m);
    }
  }
  const mode = view.mode;
  return (
    <div className="acc-identities" ref={tab}>
      <ListFind find={find} placeholder={IDENTITY_FILTER} count={mappings.length} />
      {view.gaps.map((g, i) => (
        <div key={`${g.section}-${i}`} className="k8s-gap">
          <p className="dim">{gapText(SECTION_LABELS[g.section])}</p>
          <ErrorState error={g.error} profile={EKS_SECTIONS.has(g.section) ? target.profile : ssoProfile} compact onRetry={onRetry} onLoggedIn={onRetry} />
        </div>
      ))}
      {!view.rbacAvailable && <p className="err">{RBAC_MISSING}</p>}
      <dl className="kv">
        <dt>{MODE_LABEL}</dt>
        <dd>
          <span className="mono">{view.authMode ?? NONE}</span> <span className="dim">{mode ? MODE_NOTES[mode] : MODE_UNKNOWN}</span>
        </dd>
        <dt>aws-auth</dt>
        <dd>
          {view.awsAuth.present ? AWS_AUTH_PRESENT : AWS_AUTH_NONE}
          {view.awsAuth.accounts.length > 0 && <div className="dim">{awsAuthAccounts(view.awsAuth.accounts)}</div>}
          {view.awsAuth.errors.map((e) => (
            <div key={e} className="err">{e}</div>
          ))}
        </dd>
      </dl>
      <div className="acc-bar">
        <label className="acc-check">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          {SSO_GROUP_TITLE}
        </label>
        {onChange && <EntryCreateButton mode={mode} onChange={onChange} />}
        <span className="dim acc-push">{fetchedAt(view.fetchedAt)}</span>
      </div>
      <div className="tbl acc-table k8s-vim-rows" tabIndex={0} onKeyDown={vimTableKeys}>
        <table aria-label={IDENTITIES_LABEL}>
          <thead>
            <tr>
              <th>{H_PRINCIPAL}</th>
              <th>{H_SOURCE}</th>
              <th>{H_USERNAME}</th>
              <th>{H_GROUPS}</th>
              <th>{H_POLICIES}</th>
              <th>{H_STATE}</th>
              <th>{H_SUMMARY}</th>
            </tr>
          </thead>
          <tbody>
            {[...bySet.entries()].map(([set, rows]) => {
              const expanded = open.has(set);
              return (
                <Fragment key={set}>
                  <tr className="acc-group-row" tabIndex={-1}>
                    <td colSpan={7}>
                      <button className="link tone-secondary" aria-expanded={expanded} aria-label={`${ssoGroupRow(set, rows.length)} ${expanded ? COLLAPSE : EXPAND}`} onClick={() => toggle(set)}>
                        {expanded ? "▾" : "▸"} {ssoGroupRow(set, rows.length)}
                      </button>
                    </td>
                  </tr>
                  {expanded && rows.map((m) => <Row key={m.source + m.principalArn} m={m} indent mode={mode} onOpenIam={onOpenIam} onOpenSubject={onOpenSubject} onChange={onChange} />)}
                </Fragment>
              );
            })}
            {plain.map((m) => (
              <Row key={m.source + m.principalArn} m={m} mode={mode} onOpenIam={onOpenIam} onOpenSubject={onOpenSubject} onChange={onChange} />
            ))}
          </tbody>
        </table>
        {mappings.length === 0 && <div className="empty small">{view.mappings.length === 0 ? NO_MAPPINGS : NO_IDENTITY_MATCH}</div>}
      </div>
      {view.dangling.length > 0 && (
        <section className="k8s-sect" aria-label={DANGLING_TITLE}>
          <h4>{DANGLING_TITLE}</h4>
          <ul>
            {view.dangling.map((d) => (
              <li key={`${d.binding.kind}/${d.binding.namespace}/${d.binding.name}`} className="mono">
                {danglingText(`${d.binding.kind} ${d.binding.namespace ? `${d.binding.namespace}/` : ""}${d.binding.name}`, `${d.role.kind} ${d.role.name}`)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
