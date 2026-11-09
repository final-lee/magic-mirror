import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import { ListFind, useListFind } from "../../components/ListFind";
import { formatDateTime } from "../../iam/format";
import { vimTableKeys } from "../../iam/ListTable";
import { fuzzyKeep } from "../../lib/fuzzy";
import { sqsApi } from "../api";
import { sqsKeys } from "../queries";
import * as t from "./text";

export function SqsChangeLog({ profile, region, url }: { profile: string; region: string; url: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const find = useListFind(host);
  const query = useQuery({ queryKey: sqsKeys.changes(profile, region), queryFn: () => sqsApi.changes(profile, region) });
  const entries = [...(query.data ?? [])].reverse().filter((row) => !url || row.queueUrl === url);
  const rows = fuzzyKeep(entries, find.query, (row) => [row.queueName, row.kind, row.summary, row.error ?? ""]);

  return (
    <div className="sqs-change-log" ref={host}>
      <ListFind find={find} count={rows.length} />
      {query.isLoading && <p>{t.LOADING_LOG}</p>}
      {query.isError && <p role="alert">{errorMessage(query.error)}</p>}
      {query.data && rows.length === 0 && <div className="empty">{t.NO_LOG}</div>}
      {rows.length > 0 && (
        <table className="k8s-table k8s-vim-rows" aria-label={t.LOG} tabIndex={0} onKeyDown={vimTableKeys}>
          <thead><tr><th>{t.TIME}</th><th>{t.QUEUE}</th><th>{t.CHANGE}</th><th>{t.RESULT}</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} tabIndex={-1}>
                <td>{formatDateTime(row.at)}</td>
                <td>{row.queueName}</td>
                <td>{row.summary}</td>
                <td>{row.ok ? t.SUCCESS : t.FAILURE(row.error)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
