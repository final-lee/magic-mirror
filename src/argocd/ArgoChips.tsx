interface Props {
  label: string;
  statuses: readonly string[];
  counts: Record<string, number>;
  picked: ReadonlySet<string>;
  onToggle: (s: string) => void;
  /** 칩 앞 점의 색을 정하는 클래스 */
  dot: (s: string) => string;
  text?: (s: string) => string;
}

/** 상태·환경을 여러 개 켜고 끄는 칩 줄. 칩마다 개수가 붙는다 */
export function ArgoChips({ label, statuses, counts, picked, onToggle, dot, text }: Props) {
  return (
    <div className="k8s-levels" role="group" aria-label={label}>
      {statuses.map((s) => (
        <button key={s} className={`k8s-lvl argo-lvl ${dot(s)}`} aria-pressed={picked.has(s)} onClick={() => onToggle(s)}>
          {text ? text(s) : s} <span className="k8s-lvl-n">{(counts[s] ?? 0).toLocaleString("ko-KR")}</span>
        </button>
      ))}
    </div>
  );
}
