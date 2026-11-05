import { formatBytes } from "../lib/format";
import { formatDuration, formatUnix } from "./format";
import { KvError } from "./KvError";
import { TypeBadge } from "./KeyBrowser";
import * as t from "./text";
import type { KvBigKey, KvKeyName, KvOverview, KvTarget } from "./types";
import type { BigKeysState } from "./useBigKeys";

/** 크기 열: 메모리 기준이면 바이트, 길이 기준이면 문자열·JSON은 바이트, 컬렉션은 원소 수 */
function sizeText(k: KvBigKey, basis: "memory" | "length"): string {
  if (basis === "memory" || k.type === "string" || k.type === "json") return formatBytes(k.size);
  return t.BIGKEYS_ELEMENTS(k.size);
}

/** 지금까지의 빠르기로 어림한 남은 시간(초). 아직 어림할 수 없으면 null */
export function secondsLeft(scanned: number, total: number, elapsedMs: number): number | null {
  if (scanned <= 0 || total <= scanned || elapsedMs <= 0) return null;
  return ((total - scanned) * elapsedMs) / scanned / 1000;
}

interface Props {
  target: KvTarget;
  overview: KvOverview;
  state: BigKeysState;
  onStart: () => void;
  onStop: () => void;
  /** 키 이름을 누르면 키 화면에서 그 값을 연다 */
  onOpenKey: (name: KvKeyName) => void;
}

function KeyTable({ keys, basis, onOpenKey }: { keys: KvBigKey[]; basis: "memory" | "length"; onOpenKey: (name: KvKeyName) => void }) {
  if (keys.length === 0) return <div className="empty small">{t.BIGKEYS_EMPTY}</div>;
  return (
    <table className="kv-table" aria-label={t.BIGKEYS_LABEL}>
      <thead>
        <tr>
          {Object.values(t.BIGKEYS_COLS).map((c) => (
            <th key={c} scope="col" className="nosort">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {keys.map((k, i) => (
          <tr key={`${k.name.base64 ?? k.name.text}-${i}`}>
            <td className="dim num">{i + 1}</td>
            <td className="mono kv-bigkey">
              <button type="button" className="link" onClick={() => onOpenKey(k.name)}>
                {k.name.text}
              </button>
            </td>
            <td>
              <TypeBadge type={k.type} />
            </td>
            <td className="mono num">{sizeText(k, basis)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 큰 키: [찾기]로 모든 키를 훑으며 진행 막대·남은 시간·5만 개마다의 중간 결과를 보인다. 결과는 상위 50개.
 * 끝난 결과는 대상·DB마다 저장되어 [다시 찾기]를 누르기 전까지 앱을 다시 켜도 보인다.
 */
export function BigKeys({ target, overview, state, onStart, onStop, onOpenKey }: Props) {
  const running = state.status === "running";
  const pct = running && state.total > 0 ? Math.min(1, state.scanned / state.total) : null;
  const left = running ? secondsLeft(state.scanned, state.total, Date.now() - state.startedAt) : null;
  // 서버리스는 길이 기준이다(중간 결과의 크기 표시)
  const runningBasis = overview.mode === "serverless" ? "length" : "memory";
  return (
    <section className="center kv-screen kv-bigkeys" aria-label="큰 키">
      <div className="kv-bar">
        <span className="dim">{t.BIGKEYS_INTRO}</span>
        <span className="kv-bar-end">
          {running ? (
            <button className="btn small" onClick={onStop} disabled={state.stopping}>
              {t.BIGKEYS_STOP}
            </button>
          ) : (
            <button className="btn small primary" onClick={onStart}>
              {state.status === "done" ? t.BIGKEYS_REFIND : t.BIGKEYS_FIND}
            </button>
          )}
        </span>
      </div>
      {state.status === "running" && (
        <>
          <div className="kv-progress">
            <div className="kv-meter" role="progressbar" aria-label="큰 키 찾기 진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct * 100)}>
              <span className={pct === null ? "busy" : undefined} style={{ width: pct === null ? "30%" : `${pct * 100}%` }} />
            </div>
            <span className="dim">
              {state.stopping ? t.BIGKEYS_STOPPING : t.BIGKEYS_RUNNING(state.scanned, state.total)}
              {!state.stopping && left !== null && ` · ${t.BIGKEYS_LEFT(formatDuration(Math.ceil(left)))}`}
            </span>
          </div>
          {state.partial && (
            <div className="kv-pane">
              <p className="kv-note dim">{t.BIGKEYS_PARTIAL(state.partial.scanned)}</p>
              <KeyTable keys={state.partial.keys} basis={runningBasis} onOpenKey={onOpenKey} />
            </div>
          )}
        </>
      )}
      {state.status === "error" && <KvError error={state.error} target={target} onRetry={onStart} />}
      {state.status === "done" && (
        <div className="kv-pane">
          <p className="kv-note dim">
            {state.stopped ? t.BIGKEYS_STOPPED(state.scanned) : t.BIGKEYS_DONE(state.scanned)} · {state.basis === "length" ? t.BIGKEYS_BASIS_LENGTH : t.BIGKEYS_BASIS_MEMORY}
          </p>
          <p className="kv-note dim">{t.BIGKEYS_MADE(formatDuration((Date.now() - state.generatedAt) / 1000), formatUnix(state.generatedAt / 1000))}</p>
          <KeyTable keys={state.keys} basis={state.basis} onOpenKey={onOpenKey} />
        </div>
      )}
      {state.status === "idle" && <div className="empty">{t.BIGKEYS_IDLE}</div>}
    </section>
  );
}
