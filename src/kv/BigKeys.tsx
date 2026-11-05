import { formatBytes } from "../lib/format";
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

interface Props {
  target: KvTarget;
  overview: KvOverview;
  state: BigKeysState;
  onStart: () => void;
  onStop: () => void;
  /** 키 이름을 누르면 키 화면에서 그 값을 연다 */
  onOpenKey: (name: KvKeyName) => void;
}

/** 큰 키: [찾기]로 SCAN 샘플링을 돌리고 진행률과 [중단]을 보인다. 결과는 상위 50개. */
export function BigKeys({ target, state, onStart, onStop, onOpenKey }: Props) {
  const running = state.status === "running";
  const pct = state.status === "running" && state.total > 0 ? Math.min(1, state.scanned / state.total) : null;
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
              {t.BIGKEYS_FIND}
            </button>
          )}
        </span>
      </div>
      {state.status === "running" && (
        <div className="kv-progress">
          <div className="kv-meter" role="progressbar" aria-label="큰 키 찾기 진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct * 100)}>
            <span className={pct === null ? "busy" : undefined} style={{ width: pct === null ? "30%" : `${pct * 100}%` }} />
          </div>
          <span className="dim">{state.stopping ? t.BIGKEYS_STOPPING : t.BIGKEYS_RUNNING(state.scanned, state.total)}</span>
        </div>
      )}
      {state.status === "error" && <KvError error={state.error} target={target} onRetry={onStart} />}
      {state.status === "done" && (
        <div className="kv-pane">
          <p className="kv-note dim">
            {state.stopped ? t.BIGKEYS_STOPPED(state.scanned) : t.BIGKEYS_DONE(state.scanned)} · {state.basis === "length" ? t.BIGKEYS_BASIS_LENGTH : t.BIGKEYS_BASIS_MEMORY}
          </p>
          {state.keys.length === 0 ? (
            <div className="empty small">{t.BIGKEYS_EMPTY}</div>
          ) : (
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
                {state.keys.map((k, i) => (
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
                    <td className="mono num">{sizeText(k, state.basis)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {state.status === "idle" && <div className="empty">{t.BIGKEYS_IDLE}</div>}
    </section>
  );
}
