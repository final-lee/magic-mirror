import type { SnsFinding } from "./types";
import * as t from "./accessText";

/** 점검 결과 목록(주제 탭 정책 화면, 계정 개요 공용). onOpenTopic이 있으면 주제 이름이 그 주제 탭으로 가는 링크다 */
export function FindingsList({ findings, onOpenTopic }: { findings: SnsFinding[]; onOpenTopic?: (finding: SnsFinding) => void }) {
  if (findings.length === 0) return <p className="sns-note dim">{t.FINDINGS_EMPTY}</p>;
  return (
    <ul className="sns-findings" aria-label={t.FINDINGS_LABEL}>
      {findings.map((f) => (
        <li key={`${f.topicArn}|${f.check}`} className="sns-finding" data-check={f.check}>
          <div className="sns-finding-head">
            <span className={`sns-level ${f.level}`}>{t.LEVEL_LABEL[f.level]}</span>
            {onOpenTopic && (
              <button type="button" className="link mono" title={t.OPEN_TOPIC(f.topicName)} onClick={() => onOpenTopic(f)}>
                {f.topicName}
              </button>
            )}
            <span>{f.summary}</span>
          </div>
          {f.detail && <p className="sns-note dim">{f.detail}</p>}
          {f.items.length > 0 && (
            <ul className="sns-finding-items mono" aria-label={t.FINDING_ITEMS}>
              {f.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
