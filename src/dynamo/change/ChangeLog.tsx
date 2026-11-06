import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import { formatDateTime } from "../../iam/format";
import type { DetailContext } from "../TableDetail";
import { changeApi } from "./api";
import { useDynamoChange } from "./ChangeFlow";
import * as t from "./text";
import type { ChangeLogEntry } from "./types";

function outcome(row: ChangeLogEntry) {
  if (!row.ok) return { label: t.FAILURE, tone: "denied" };
  if (row.undone) return { label: t.DONE, tone: "" };
  return { label: t.SUCCESS, tone: "allowed" };
}

/** 되돌리기 기록이 가리키는 원래 기록: 요약을 눌러 그 기록으로 이동한다 */
function UndoOrigin({ original, jump }: { original: ChangeLogEntry | undefined; jump: (id: string) => void }) {
  if (!original) return <p className="dim">{t.UNDO_ORIGIN_UNKNOWN}</p>;
  return <p><button className="link" onClick={() => jump(original.id)}>{t.undoOf(original.summary)}</button></p>;
}

export function ChangeLog({ profile, region, table }: DetailContext) {
  const target = { profile, region, table: table.name };
  const changes = useQuery({
    queryKey: ["dynamo", profile, region, table.name, "changes"],
    queryFn: () => changeApi.changes(target),
  });
  const flow = useDynamoChange(target);
  const articles = useRef(new Map<string, HTMLElement>());
  const jump = (id: string) => articles.current.get(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  const byId = new Map(changes.data?.map(row => [row.id, row]));

  return <section className="ddb-change-log">
    <button className="btn small tone-refresh" onClick={() => void changes.refetch()}>{t.RELOAD}</button>
    {changes.isError && <p className="err">{errorMessage(changes.error)}</p>}
    {flow.error && <p className="err">{flow.error}</p>}
    {changes.data?.length === 0 && <p className="dim">{t.EMPTY}</p>}
    {changes.data?.map(row => {
      const result = outcome(row);
      return <article key={row.id} ref={element => { if (element) articles.current.set(row.id, element); else articles.current.delete(row.id); }}>
        <header>
          <strong>{row.summary}</strong>
          <time dateTime={row.at}>{formatDateTime(row.at)}</time>
          <span className={`iam-chip ${result.tone}`}>{result.label}</span>
        </header>
        <p className="dim">{row.calls.join(", ")}</p>
        {row.undoOf && <UndoOrigin original={byId.get(row.undoOf)} jump={jump} />}
        {row.error && <p className="err">{row.error}</p>}
        {row.ok && row.reversible && !row.undone && row.undoAvailable === false
          ? <span className="dim">{t.UNDO_UNAVAILABLE}</span>
          : row.ok && row.reversible && !row.undone
            ? <button className="btn small tone-caution" disabled={flow.loading} onClick={() => void flow.undo(row.id)}>{t.UNDO}</button>
            : !row.reversible && <span className="dim">{t.UNAVAILABLE}</span>}
      </article>;
    })}
    {flow.dialog}
  </section>;
}
