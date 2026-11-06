import { ALL_EVENTS } from "./records";
import * as t from "./text";
import type { StartFrom } from "./types";

interface SessionControlsProps {
  running: boolean;
  paused: boolean;
  from: StartFrom;
  shards: number;
  behind: number;
  onFrom: (from: StartFrom) => void;
  onStart: () => void;
  onStop: () => void;
  onPause: (paused: boolean) => void;
}

/** 시작 지점, 시작·중지, 일시정지, 읽는 샤드 수 */
function SessionControls({ running, paused, from, shards, behind, onFrom, onStart, onStop, onPause }: SessionControlsProps) {
  return (
    <>
      <div className="ddb-stream-controls">
        <select aria-label={t.START_POSITION} value={from} disabled={running} onChange={(e) => onFrom(e.target.value as StartFrom)}>
          <option value="LATEST">{t.LATEST}</option>
          <option value="TRIM_HORIZON">{t.TRIM}</option>
        </select>
        {running ? (
          <>
            <button type="button" className={`btn small ${paused ? "tone-warn" : "tone-caution"}`} onClick={() => onPause(!paused)}>
              {paused ? t.RESUME : t.PAUSE}
            </button>
            <button type="button" className="btn small tone-caution" onClick={onStop}>
              {t.STOP}
            </button>
            <span className="dim">{t.shards(shards, behind)}</span>
          </>
        ) : (
          <button type="button" className="btn small tone-primary" onClick={onStart}>
            {t.START}
          </button>
        )}
      </div>
      {from === "TRIM_HORIZON" && <p className="dim">{t.TRIM_WARNING}</p>}
    </>
  );
}

interface FilterControlsProps {
  filter: string;
  kinds: readonly string[];
  onFilter: (filter: string) => void;
  onToggleKind: (kind: string) => void;
}

/** 레코드 필터와 이벤트 종류 칩 */
function FilterControls({ filter, kinds, onFilter, onToggleKind }: FilterControlsProps) {
  return (
    <div className="ddb-stream-controls">
      <input aria-label={t.FILTER} placeholder={t.FILTER} value={filter} onChange={(e) => onFilter(e.target.value)} />
      {ALL_EVENTS.map((kind) => (
        <button key={kind} type="button" className="btn small tone-secondary" aria-pressed={kinds.includes(kind)} onClick={() => onToggleKind(kind)}>
          {t.EVENT[kind]}
        </button>
      ))}
    </div>
  );
}

type Props = SessionControlsProps & FilterControlsProps;

/** 레코드 위의 줄들: 읽기 제어(시작 지점·일시정지)와 보기 거르기(필터·종류 칩) */
export function RecordsToolbar({ filter, kinds, onFilter, onToggleKind, ...session }: Props) {
  return (
    <>
      <SessionControls {...session} />
      <FilterControls filter={filter} kinds={kinds} onFilter={onFilter} onToggleKind={onToggleKind} />
    </>
  );
}
