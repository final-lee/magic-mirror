import type { SnsCheckInfo, SnsFinding } from "./types";
import * as t from "./accessText";

/** 계정과 주제의 점검을 항목별로 묶는다. */
export function FindingsList({ findings, onOpenTopic, checks = [] }: { findings: SnsFinding[]; onOpenTopic?: (finding: SnsFinding) => void; checks?: SnsCheckInfo[] }) {
  if (findings.length === 0) return <p className="sns-note dim">{t.FINDINGS_EMPTY}</p>;
  const groups = new Map<string, SnsFinding[]>();
  for (const finding of [...findings].sort(t.byLevel)) groups.set(finding.check, [...(groups.get(finding.check) ?? []), finding]);
  return <div aria-label={t.FINDINGS_LABEL}>
    {[...groups].map(([id, items]) => {
      const first = items[0];
      const title = checks.find((c) => c.id === id)?.title ?? first.summary;
      return <div className="fx-items pg-fx" key={id} data-check={id}>
        <h3 className="fx-items-title">{title} <span className={`sns-level ${first.level}`}>{t.LEVEL_LABEL[first.level]}</span> <span className="dim">{items.length}건</span></h3>
        <table aria-label={title}><thead><tr>{onOpenTopic && <th scope="col" className="nosort">대상 주제</th>}<th scope="col" className="nosort">내용</th></tr></thead>
          <tbody>{items.map((f) => <tr key={`${f.topicArn}|${f.check}`}>
            {onOpenTopic && <td><button type="button" className="link mono" title={t.OPEN_TOPIC(f.topicName)} onClick={() => onOpenTopic(f)}>{f.topicName}</button></td>}
            <td>{f.summary === title && !onOpenTopic ? null : f.summary}{f.detail && <div className="dim">{f.detail}</div>}{f.items.map((item) => <div key={item} className="dim mono">{item}</div>)}</td>
          </tr>)}</tbody>
        </table>
      </div>;
    })}
  </div>;
}
