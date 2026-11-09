import type { SqsFinding } from "./types";
import * as t from "./text";

/** 진단 목록: 항목마다 수준 아이콘과 한 줄 요약, 자세한 설명이 있으면 접어 둔다 */
export function SqsFindings({ findings, emptyText = t.FINDINGS_OK }: { findings: SqsFinding[]; emptyText?: string }) {
  if (findings.length === 0) return <p className="dim sqs-findings-empty">{emptyText}</p>;
  return (
    <ul className="sqs-findings">
      {findings.map((f, i) => {
        const level = t.FINDING_LEVEL[f.level];
        return (
          <li key={`${f.id}-${i}`} className={`sqs-finding ${f.level}`}>
            {f.detail ? (
              <details>
                <summary>
                  <FindingHead icon={level.icon} label={level.label} summary={f.summary} />
                </summary>
                <p className="sqs-finding-detail">{f.detail}</p>
              </details>
            ) : (
              <div className="sqs-finding-row">
                <FindingHead icon={level.icon} label={level.label} summary={f.summary} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FindingHead({ icon, label, summary }: { icon: string; label: string; summary: string }) {
  return (
    <>
      <span className="sqs-finding-icon" role="img" aria-label={label}>
        {icon}
      </span>
      <span className="sqs-finding-summary">{summary}</span>
    </>
  );
}
