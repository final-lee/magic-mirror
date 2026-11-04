import { useMemo, useRef, useState } from "react";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { findings, type FindingGroup, type FindingItem, type FindingKind } from "./findings";
import {
  CAT_FIND_COUNT_UNIT,
  FIND_COL_DETAIL,
  FIND_COL_SCOPE,
  FIND_COL_SUBJECT,
  FIND_COL_TARGET,
  FIND_ITEMS_LABEL,
  FIND_LEVEL,
  FIND_NONE,
  FIND_NO_PROBLEMS,
  FIND_CARDS_LABEL,
} from "./catalogText";
import type { CronRow, TemplateKind, TemplateRow, WfRow, WfTarget } from "./types";

interface Props {
  workflows: WfRow[];
  crons: CronRow[];
  templates: TemplateRow[];
  /** 기준 시각(밀리초): 오래 실행·대기와 상대 시각이 이 값으로 정해진다 */
  now: number;
  onOpenWorkflow: (target: WfTarget) => void;
  onOpenCron: (namespace: string, name: string) => void;
  onOpenTemplate: (kind: TemplateKind, namespace: string | null, name: string) => void;
}

/** 점검 화면: 카드(건수와 위험·주의·참고 색)를 누르면 아래에 그 목록, 항목을 누르면 상세. IAM 점검 화면과 같은 틀이다. */
export function Findings({ workflows, crons, templates, now, onOpenWorkflow, onOpenCron, onOpenTemplate }: Props) {
  const groups = useMemo(() => findings({ workflows, crons, templates, now }), [workflows, crons, templates, now]);
  const [picked, setPicked] = useState<FindingKind | null>(null);
  // 고른 카드가 없거나 지금은 문제가 없으면 문제가 있는 첫 카드를 보인다
  const current = groups.find((g) => g.kind === picked && g.items.length > 0) ?? groups.find((g) => g.items.length > 0) ?? null;
  const listRef = useRef<HTMLDivElement>(null);
  const find = useListFind(listRef);
  const visible = fuzzyKeep(current?.items ?? [], find.query, (item) => [item.subject, item.name, item.scope, item.detail]);

  const open = (item: FindingItem) => {
    const t = item.target;
    if (t.type === "workflow") onOpenWorkflow(t.target);
    else if (t.type === "cron") onOpenCron(t.namespace, t.name);
    else onOpenTemplate(t.kind, t.namespace, t.name);
  };

  return (
    <section className="awc awc-findings">
      <div className="awc-bar">
        <h2 className="awc-title">점검</h2>
        <span className="dim">지금 읽어 둔 Workflow·Cron·템플릿에서 손볼 곳</span>
      </div>
      <div className="awc-scroll">
        <div className="fx-cards" role="group" aria-label={FIND_CARDS_LABEL}>
          {groups.map((g) => (
            <Card key={g.kind} group={g} selected={g === current} onPick={() => setPicked(g.kind)} />
          ))}
        </div>
        {current ? (
          <div className="fx-items" ref={listRef}>
            <ListFind find={find} count={visible.length} />
            <h3 className="fx-items-title">
              {current.title}{" "}
              <span className="dim">
                {current.items.length}
                {CAT_FIND_COUNT_UNIT}
              </span>
            </h3>
            <table aria-label={FIND_ITEMS_LABEL}>
              <thead>
                <tr>
                  <th scope="col" className="nosort">
                    {FIND_COL_SUBJECT}
                  </th>
                  <th scope="col" className="nosort">
                    {FIND_COL_TARGET}
                  </th>
                  <th scope="col" className="nosort">
                    {FIND_COL_SCOPE}
                  </th>
                  <th scope="col" className="nosort">
                    {FIND_COL_DETAIL}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td className="dim">{item.subject}</td>
                    <td>
                      <button className="link mono" onClick={() => open(item)}>
                        {item.name}
                      </button>
                    </td>
                    <td className="mono">{item.scope}</td>
                    <td>{item.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty small">{FIND_NO_PROBLEMS}</div>
        )}
      </div>
    </section>
  );
}

function Card({ group, selected, onPick }: { group: FindingGroup; selected: boolean; onPick: () => void }) {
  const n = group.items.length;
  return (
    <button
      className={`fx-card ${group.level}${n === 0 ? " empty" : ""}${selected ? " on" : ""}`}
      data-kind={group.kind}
      aria-pressed={selected}
      disabled={n === 0}
      onClick={onPick}
    >
      <span className="fx-title">{group.title}</span>
      {n === 0 ? (
        <span className="fx-ok">{FIND_NONE}</span>
      ) : (
        <span className="fx-count">
          <b className="fx-n">
            {n}
            <small>{CAT_FIND_COUNT_UNIT}</small>
          </b>
          <span className={`iam-badge ${group.level}`}>{FIND_LEVEL[group.level]}</span>
        </span>
      )}
    </button>
  );
}
