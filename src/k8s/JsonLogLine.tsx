import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import { desktop } from "../api/desktop";
import { inlineValue, isErrorField, parseJsonLog } from "./jsonLog";
import { highlight, matchRanges, searchPattern } from "./logSearch";
import { COPIED, LOG_COPY_JSON, LOG_FIELDS_HIDE, LOG_FIELDS_SHOW } from "./text";

/**
 * JSON 로그 한 줄: 시각, 레벨, 메시지를 한 줄로 보이고, 오류 필드와 찾는 말이 든 필드는 그 옆에 `key=value`로 붙인다.
 * ▸를 누르면 필드 전체를 펼친다. JSON이 아니면 원래 줄 그대로. lead는 줄 맨 앞에 붙는 출처·서버 시각.
 */
export const JsonLogLine = memo(function JsonLogLine({ line, query, lead }: { line: string; query: string; lead?: ReactNode }) {
  const log = useMemo(() => parseJsonLog(line), [line]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const re = searchPattern(query);
  if (!log) return <>{lead}{highlight(line, re)}{"\n"}</>;
  const beside = log.fields.filter(([k, v]) => isErrorField(k) || (re !== null && matchRanges(`${k}=${inlineValue(v)}`, re).length > 0));

  return (
    <div className={`lj-row${log.tone ? ` lj-${log.tone}` : ""}`}>
      {lead}
      <button className="lj-tw tone-secondary" aria-expanded={open} aria-label={open ? LOG_FIELDS_HIDE : LOG_FIELDS_SHOW} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"}
      </button>
      {log.time !== null && (
        <span className="lj-time" title={log.timeRaw ?? undefined}>
          {highlight(log.time, re)}
        </span>
      )}
      {log.level !== null && <span className="lj-lv">{highlight(log.level, re)}</span>}
      {log.message !== null && <span className="lj-msg">{highlight(log.message, re)}</span>}
      {beside.map(([k, v]) => (
        <span key={k} className={isErrorField(k) ? "lj-f lj-f-err" : "lj-f"}>
          <span className="lj-k">{highlight(k, re)}</span>={highlight(inlineValue(v), re)}
        </span>
      ))}
      {open && (
        <div className="lj-detail">
          <dl>
            {Object.entries(log.value).map(([k, v]) => (
              <Fragment key={k}>
                <dt>{highlight(k, re)}</dt>
                <dd className={typeof v === "string" ? "lj-str" : typeof v === "number" ? "lj-num" : typeof v === "object" && v !== null ? "lj-obj" : "lj-lit"}>
                  {highlight(typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? String(v)), re)}
                </dd>
              </Fragment>
            ))}
          </dl>
          <button
            className="link tone-secondary"
            onClick={() => void desktop.copy(JSON.stringify(log.value, null, 2)).then(() => setCopied(true))}
            onBlur={() => setCopied(false)}
          >
            {copied ? COPIED : LOG_COPY_JSON}
          </button>
        </div>
      )}
    </div>
  );
});
