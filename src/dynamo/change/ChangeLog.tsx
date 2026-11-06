import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import type { DetailContext } from "../TableDetail";
import { changeApi } from "./api";
import { useDynamoChange } from "./ChangeFlow";
import * as t from "./text";

export function ChangeLog({ profile, region, table }: DetailContext) {
  const target = { profile, region, table: table.name };
  const q = useQuery({ queryKey: ["dynamo", profile, region, table.name, "changes"], queryFn: () => changeApi.changes(target) });
  const flow = useDynamoChange(target);
  return <section className="ddb-change-log"><button className="btn small tone-refresh" onClick={() => void q.refetch()}>{t.RELOAD}</button>
    {q.isError && <p className="err">{errorMessage(q.error)}</p>}{flow.error && <p className="err">{flow.error}</p>}
    {q.data?.length === 0 && <p className="dim">{t.EMPTY}</p>}
    {q.data?.map((row) => <article key={row.id}><strong>{row.summary}</strong> <time>{row.at}</time> <span>{row.ok ? row.undone ? t.DONE : "성공" : "실패"}</span>
      <p className="dim">{row.calls.join(", ")}{row.undoOf ? ` · ${row.undoOf}` : ""}</p>{row.error && <p className="err">{row.error}</p>}
      {row.ok && row.reversible && !row.undone ? <button className="btn small tone-caution" disabled={flow.loading} onClick={() => void flow.undo(row.id)}>{t.UNDO}</button> : !row.reversible && <span className="dim">{t.UNAVAILABLE}</span>}
    </article>)}{flow.dialog}</section>;
}
