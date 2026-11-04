import { SEVERITY_LABELS } from "./text";
import type { Severity } from "./types";

/** 심각도 배지. 색만으로 구분하지 않도록 글자를 함께 쓴다. */
export function SeverityChip({ severity }: { severity: Severity }) {
  return <span className={`sec-chip sev-${severity}`}>{SEVERITY_LABELS[severity]}</span>;
}
