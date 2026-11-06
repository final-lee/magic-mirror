import { AGE_FILTERS, hasRestarts, isFiltered, NO_FILTER, valueChoices, valueFilterKeys, type AgeFilter, type ListFilter } from "./listFilter";
import { orderStates, stateTone } from "./status";
import { AGE_FILTER_LABELS, COLUMN_LABELS, FILTER_AGE, FILTER_ANY, FILTER_RESET, FILTER_RESTARTED, FILTER_STATE, ONLY_PROBLEMS } from "./text";
import type { K8sKindRef, K8sRow } from "./types";

interface Props {
  kind: K8sKindRef;
  /** 고를 거리를 셀 행(찾기 줄로 거른 뒤) */
  rows: K8sRow[];
  /** 상태 칩의 수: 상태 말고 다른 필터까지 거친 행의 상태별 수 */
  stateCounts: Map<string, number>;
  filter: ListFilter;
  onChange: (next: ListFilter) => void;
}

/** 목록 위 필터 줄: 상태 칩(여럿 고름), 종류별 값 고르기, 나이, 재시작 있음, 문제 있는 것만 */
export function ListFilterBar({ kind, rows, stateCounts, filter, onChange }: Props) {
  const set = (patch: Partial<ListFilter>) => onChange({ ...filter, ...patch });
  // 고른 상태가 지금 없더라도 칩을 남겨 풀 수 있게 한다
  const counts = new Map(stateCounts);
  for (const s of filter.states) if (!counts.has(s)) counts.set(s, 0);
  const toggleState = (s: string) => set({ states: filter.states.includes(s) ? filter.states.filter((x) => x !== s) : [...filter.states, s] });
  const pickValue = (key: string, value: string) => {
    const values = { ...filter.values };
    if (value) values[key] = value;
    else delete values[key];
    set({ values });
  };
  const selects = valueFilterKeys(kind)
    .map((key) => ({ key, choices: valueChoices(rows, key) }))
    .filter(({ key, choices }) => choices.length > 1 || filter.values[key] !== undefined);
  return (
    <div className="k8s-list-bar k8s-filters">
      {counts.size > 0 && (
        <div className="k8s-chips" role="group" aria-label={FILTER_STATE}>
          {orderStates(counts).map(([state, n]) => {
            const on = filter.states.includes(state);
            return (
              <button key={state} type="button" className={`k8s-chip tone-${stateTone(state)}${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggleState(state)}>
                {state}
                <span className="k8s-chip-n">{n}</span>
              </button>
            );
          })}
        </div>
      )}
      {selects.map(({ key, choices }) => (
        <label key={key} className="k8s-check">
          {COLUMN_LABELS[key] ?? key}
          <select value={filter.values[key] ?? ""} onChange={(e) => pickValue(key, e.target.value)}>
            <option value="">{FILTER_ANY}</option>
            {choices.map((c) => <option key={c} value={c}>{c}</option>)}
            {filter.values[key] !== undefined && !choices.includes(filter.values[key]) && <option value={filter.values[key]}>{filter.values[key]}</option>}
          </select>
        </label>
      ))}
      <label className="k8s-check">
        {FILTER_AGE}
        <select value={filter.age} onChange={(e) => set({ age: e.target.value as AgeFilter })}>
          {AGE_FILTERS.map((a) => <option key={a} value={a}>{AGE_FILTER_LABELS[a]}</option>)}
        </select>
      </label>
      {hasRestarts(kind) && (
        <label className="k8s-check">
          <input type="checkbox" checked={filter.restarted} onChange={(e) => set({ restarted: e.target.checked })} />
          {FILTER_RESTARTED}
        </label>
      )}
      <label className="k8s-check">
        <input type="checkbox" checked={filter.onlyProblems} onChange={(e) => set({ onlyProblems: e.target.checked })} />
        {ONLY_PROBLEMS}
      </label>
      {isFiltered(filter) && (
        <button type="button" className="link k8s-filter-reset" onClick={() => onChange(NO_FILTER)}>
          {FILTER_RESET}
        </button>
      )}
    </div>
  );
}
