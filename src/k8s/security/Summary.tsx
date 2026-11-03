import type { Counts } from "./logic";
import { BY_CATEGORY_LABEL, BY_SEVERITY_LABEL, CATEGORIES, CATEGORY_LABELS, FILTER_TITLE, HIDDEN_SYSTEM, SEVERITIES, SEVERITY_LABELS, SUMMARY_LABEL, TOTAL } from "./text";
import type { Category, Severity } from "./types";

interface Props {
  counts: Counts;
  severity: Severity | null;
  category: Category | null;
  onSeverity: (s: Severity | null) => void;
  onCategory: (c: Category | null) => void;
  /** 시스템 네임스페이스라서 숨긴 문제 수 */
  hiddenSystem: number;
}

/** 심각도별·분류별 개수. 카드를 누르면 그 조건으로 목록을 거르고, 다시 누르면 푼다. */
export function Summary({ counts, severity, category, onSeverity, onCategory, hiddenSystem }: Props) {
  return (
    <section className="sec-summary" aria-label={SUMMARY_LABEL}>
      <div className="sec-total">
        <b>{TOTAL(counts.total)}</b>
        {hiddenSystem > 0 && <span className="dim">{HIDDEN_SYSTEM(hiddenSystem)}</span>}
      </div>
      <div className="sec-cards" role="group" aria-label={BY_SEVERITY_LABEL}>
        {SEVERITIES.map((s) => {
          const label = SEVERITY_LABELS[s];
          return (
            <button key={s} className={`sec-card sev-${s}${severity === s ? " on" : ""}`} aria-pressed={severity === s} title={FILTER_TITLE(label, severity === s)} onClick={() => onSeverity(severity === s ? null : s)}>
              <span className="sec-card-n">{counts.severity[s]}</span>
              <span className="sec-card-l">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="sec-cards" role="group" aria-label={BY_CATEGORY_LABEL}>
        {CATEGORIES.map((c) => {
          const label = CATEGORY_LABELS[c];
          return (
            <button key={c} className={`sec-card cat${category === c ? " on" : ""}`} aria-pressed={category === c} title={FILTER_TITLE(label, category === c)} onClick={() => onCategory(category === c ? null : c)}>
              <span className="sec-card-n">{counts.category[c]}</span>
              <span className="sec-card-l">{label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
