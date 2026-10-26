import { desktop } from "../api/desktop";
import { BadgeList } from "./Badges";
import { formatAgo, formatDay } from "./format";
import { KIND_LABEL } from "./labels";
import type { PrincipalSummary } from "./types";

/** 사용자·그룹·역할 상세의 머리글: 이름, ARN, 배지, 만든 날, 마지막 사용, 태그 */
export function PrincipalHeader({ summary, tags }: { summary: PrincipalSummary; tags: Record<string, string> }) {
  const tagList = Object.entries(tags);
  return (
    <header className="iam-head">
      <div className="iam-title">
        <h2>{summary.name}</h2>
        <span className="iam-kind">{KIND_LABEL[summary.kind]}</span>
        {summary.path !== "/" && <span className="iam-path mono">{summary.path}</span>}
      </div>
      <div className="iam-arn">
        <span className="mono">{summary.arn}</span>
        <button className="link" aria-label="ARN 복사" onClick={() => void desktop.copy(summary.arn)}>
          복사
        </button>
      </div>
      <BadgeList badges={summary.badges} />
      <div className="iam-meta dim">
        {summary.createdAt && <span>만든 날 {formatDay(summary.createdAt)}</span>}
        {summary.kind !== "group" &&
          (summary.lastUsed ? (
            <span>
              마지막 사용 {formatDay(summary.lastUsed)} ({formatAgo(summary.lastUsed)})
            </span>
          ) : (
            <span>마지막 사용 기록 없음</span>
          ))}
      </div>
      {tagList.length > 0 && (
        <div>
          {tagList.map(([k, v]) => (
            <span className="tag" key={k}>
              {k}={v}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}
