import * as t from "./text";
import type { Finding } from "./types";

/** 진단 목록: 항목마다 수준 아이콘과 한 줄 요약, 자세한 설명이 있으면 접어 둔다 */
export function Findings({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <p className="dim ddb-findings-empty">{t.FINDINGS_OK}</p>;
  return (
    <ul className="ddb-findings">
      {findings.map((f, i) => {
        const level = t.FINDING_LEVEL[f.level];
        const head = (
          <>
            <span className="ddb-finding-icon" role="img" aria-label={level.label}>
              {level.icon}
            </span>
            <span className="ddb-finding-summary">{f.summary}</span>
          </>
        );
        return (
          <li key={`${f.id}-${f.index ?? ""}-${i}`} className={`ddb-finding ${f.level}`}>
            {f.detail ? (
              <details>
                <summary>{head}</summary>
                <p className="ddb-finding-detail">{f.detail}</p>
              </details>
            ) : (
              <div className="ddb-finding-row">{head}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
