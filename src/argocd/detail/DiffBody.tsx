import { TextDiffView } from "../../explorer/TextDiffView";
import type { TextDiff } from "../change/types";
import { RES_DIFF_SAME, diffStats } from "./text";

/** 줄 단위 diff(좌: 이전, 우: 이후)와 요약. 바뀐 줄이 없으면 같다고 알린다. `same`은 같을 때의 안내 글. */
export function DiffBody({ diff, same = RES_DIFF_SAME }: { diff: TextDiff; same?: string }) {
  const { added, removed, changed } = diff.stats;
  if (added + removed + changed === 0) return <p className="dim">{same}</p>;
  return (
    <div className="argo-diff">
      <p className="dim argo-diff-stats mono">{diffStats(diff.stats)}</p>
      <TextDiffView rows={diff.rows} />
    </div>
  );
}
