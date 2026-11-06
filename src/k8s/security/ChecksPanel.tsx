import { isEnabled, withCheck, withChecks } from "./logic";
import {
  CATEGORIES, CATEGORY_LABELS, CHECKS, CHECKS_DISABLE_ALL, CHECKS_ENABLE_ALL, CHECKS_PANEL, CHECK_SKIPPED, checkCount,
} from "./text";
import type { CheckId, SecurityChecksSetting } from "./types";

interface Props {
  setting: SecurityChecksSetting;
  /** 점검 항목별로 지금 찾은 문제 수(켜고 끄기와 상관없이) */
  counts: Partial<Record<CheckId, number>>;
  /** 읽지 못해 점검하지 못한 항목 */
  skipped: CheckId[];
  onChange: (next: SecurityChecksSetting) => void;
}

/** 점검 항목 켜고 끄기. 바꾸는 즉시 설정에 저장하고 결과에서 그 항목을 뺀다(다시 읽지 않는다). */
export function ChecksPanel({ setting, counts, skipped, onChange }: Props) {
  return (
    <section className="sec-checks" aria-label={CHECKS_PANEL}>
      {CATEGORIES.map((category) => {
        const items = CHECKS.filter((c) => c.category === category);
        const ids = items.map((c) => c.id);
        return (
          <div key={category} className="sec-checks-col">
            <h4>
              {CATEGORY_LABELS[category]}
              <span className="sec-checks-all">
                <button className="link tone-secondary" onClick={() => onChange(withChecks(setting, ids, true))}>
                  {CHECKS_ENABLE_ALL}
                </button>
                <button className="link tone-secondary" onClick={() => onChange(withChecks(setting, ids, false))}>
                  {CHECKS_DISABLE_ALL}
                </button>
              </span>
            </h4>
            {items.map((c) => {
              const on = isEnabled(setting, c.id);
              return (
                <label key={c.id} className={`sec-check${on ? "" : " off"}`}>
                  <input type="checkbox" checked={on} onChange={(e) => onChange(withCheck(setting, c.id, e.target.checked))} />
                  <span className="sec-check-title">{c.title}</span>
                  {on && skipped.includes(c.id) ? (
                    <span className="k8s-chip warn" title={CHECK_SKIPPED}>
                      {CHECK_SKIPPED}
                    </span>
                  ) : (
                    (counts[c.id] ?? 0) > 0 && <span className="k8s-chip">{checkCount(counts[c.id] ?? 0)}</span>
                  )}
                </label>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
