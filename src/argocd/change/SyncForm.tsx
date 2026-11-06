import { useMemo, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { DiffBody } from "../detail/DiffBody";
import { useAppDiff, useAppHistory } from "../detail/queries";
import { shortRev } from "../argoParts";
import { LOADING } from "../text";
import type { ArgoApp, ArgoHistoryEntry } from "../types";
import { FormSheet } from "./FormSheet";
import { buildSync, initialDraft, outOfSyncKeys, resourceKey, selectable, type Sync, type SyncDraft, type SyncOptionKey } from "./syncModel";
import {
  SYNC_BACKOFF, SYNC_DIFF, SYNC_DIFF_NONE, SYNC_DIFF_REVISION_NOTE, SYNC_FACTOR, SYNC_FILTER, SYNC_MAX, SYNC_MULTI_SOURCE, SYNC_NO_RESOURCES, SYNC_OPTIONS, SYNC_OPTIONS_TITLE, SYNC_PICK_ALL,
  SYNC_PICK_NONE, SYNC_PICK_OUT_OF_SYNC, SYNC_PREVIEW, SYNC_RECENT, SYNC_RESOURCES, SYNC_RESOURCES_HINT, SYNC_RETRY, SYNC_RETRY_TITLE, SYNC_REVISION, SYNC_TITLE, syncPick, syncSelected,
} from "./text";

/** 최근 배포한 리비전(중복 없이, 최신 먼저)과 그 커밋 메시지 한 줄 */
function recentRevisions(entries: ArgoHistoryEntry[]) {
  const seen: { revision: string; message: string }[] = [];
  for (const entry of entries) {
    for (const r of entry.revisions) {
      if (!seen.some((s) => s.revision === r.revision)) seen.push({ revision: r.revision, message: r.metadata?.message?.split("\n")[0] ?? "" });
    }
  }
  return seen.slice(0, 6);
}

/** 고른 리소스(없으면 전체) 중 바뀌는 것의 diff */
function SyncDiff({ url, app, version, selected, revisionSet }: { url: string; app: ArgoApp; version: string | null; selected: string[]; revisionSet: boolean }) {
  const diff = useAppDiff(url, app.namespace, app.name, version, true);
  const rows = useMemo(() => (diff.data ?? []).filter((r) => r.changed && (selected.length === 0 || selected.includes(resourceKey(r.res)))), [diff.data, selected]);
  return (
    <section aria-label={SYNC_DIFF}>
      <h4>{SYNC_DIFF}</h4>
      {revisionSet && <p className="dim">{SYNC_DIFF_REVISION_NOTE}</p>}
      {diff.isError ? (
        <ErrorState error={diff.error} profile="" compact onRetry={() => void diff.refetch()} />
      ) : !diff.data ? (
        <div className="empty">{LOADING}</div>
      ) : rows.length === 0 ? (
        <p className="dim">{SYNC_DIFF_NONE}</p>
      ) : (
        rows.map((r) => (
          <details key={resourceKey(r.res)} className="argo-diff-res" open={rows.length <= 3}>
            <summary>
              <span className="dim">{r.res.kind}</span> <span className="mono">{r.res.name}</span>
              {r.res.namespace && <span className="dim"> {r.res.namespace}</span>}
            </summary>
            <DiffBody diff={r.diff} />
          </details>
        ))
      )}
    </section>
  );
}

interface Props {
  url: string;
  app: ArgoApp;
  /** 앱의 resourceVersion(바뀌면 이력·diff를 다시 읽는다) */
  version: string | null;
  onCancel: () => void;
  onPreview: (change: Sync) => void;
}

/**
 * 동기화 폼: 리비전(직접 입력 또는 최근 배포에서), 동기화할 리소스(고르지 않으면 앱 전체, OutOfSync만 한 번에 선택),
 * 모든 sync 옵션, 재시도, 적용될 변경(diff). 마치면 호출한 쪽이 변경 시트로 미리 본다.
 */
export function SyncForm({ url, app, version, onCancel, onPreview }: Props) {
  const [draft, setDraft] = useState<SyncDraft>(initialDraft);
  const [filter, setFilter] = useState("");
  const history = useAppHistory(url, app.namespace, app.name, version, true);
  const recent = useMemo(() => recentRevisions(history.data ?? []), [history.data]);
  const resources = useMemo(() => selectable(app.resources), [app.resources]);
  const shown = resources.filter((r) => `${r.kind} ${r.name}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const built = buildSync(draft, app.resources);
  const multiSource = app.sources.length > 1;
  const retry = (key: keyof SyncDraft["retry"], value: string) => setDraft({ ...draft, retry: { ...draft.retry, [key]: value } });
  const toggle = (key: string) => setDraft({ ...draft, selected: draft.selected.includes(key) ? draft.selected.filter((k) => k !== key) : [...draft.selected, key] });

  return (
    <FormSheet
      label={SYNC_TITLE}
      wide
      onCancel={onCancel}
      submit={{
        label: SYNC_PREVIEW,
        disabled: built.change === null,
        title: built.problem ?? undefined,
        onClick: () => {
          if (built.change) onPreview(built.change);
        },
      }}
    >
      <label>
        {SYNC_REVISION}
        <input value={draft.revision} disabled={multiSource} onChange={(e) => setDraft({ ...draft, revision: e.target.value })} />
      </label>
      {multiSource && <p className="dim">{SYNC_MULTI_SOURCE}</p>}
      {!multiSource && recent.length > 0 && (
        <div role="group" aria-label={SYNC_RECENT} className="argo-recent">
          {recent.map((r) => (
            <button key={r.revision} className="k8s-chip" title={r.message || r.revision} onClick={() => setDraft({ ...draft, revision: r.revision })}>
              <span className="mono">{shortRev(r.revision)}</span> {r.message}
            </button>
          ))}
        </div>
      )}

      <section aria-label={SYNC_RESOURCES}>
        <h4>
          {SYNC_RESOURCES} <span className="dim">{syncSelected(draft.selected.length)}</span>
        </h4>
        <p className="dim">{SYNC_RESOURCES_HINT}</p>
        {resources.length === 0 ? (
          <p className="dim">{SYNC_NO_RESOURCES}</p>
        ) : (
          <>
            <div className="k8s-list-bar">
              <input aria-label={SYNC_FILTER} placeholder={SYNC_FILTER} value={filter} onChange={(e) => setFilter(e.target.value)} />
              <button className="btn small tone-secondary" onClick={() => setDraft({ ...draft, selected: outOfSyncKeys(app.resources) })}>
                {SYNC_PICK_OUT_OF_SYNC}
              </button>
              <button className="btn small tone-secondary" onClick={() => setDraft({ ...draft, selected: resources.map(resourceKey) })}>
                {SYNC_PICK_ALL}
              </button>
              <button className="btn small tone-ghost" onClick={() => setDraft({ ...draft, selected: [] })}>
                {SYNC_PICK_NONE}
              </button>
            </div>
            <ul className="argo-sync-res">
              {shown.map((r) => (
                <li key={resourceKey(r)}>
                  <label className="k8s-check">
                    <input type="checkbox" aria-label={syncPick(r.name)} checked={draft.selected.includes(resourceKey(r))} onChange={() => toggle(resourceKey(r))} />
                    <span className="dim">{r.kind}</span> <span className="mono">{r.name}</span>
                    {r.namespace && <span className="dim"> {r.namespace}</span>}
                    {r.status && <span className={r.status === "OutOfSync" ? "argo-warn" : "dim"}> {r.status}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="argo-sync-options" aria-label={SYNC_OPTIONS_TITLE}>
        <h4>{SYNC_OPTIONS_TITLE}</h4>
        {(Object.keys(SYNC_OPTIONS) as SyncOptionKey[]).map((key) => (
          <label className="k8s-check argo-opt" key={key}>
            <input type="checkbox" checked={draft.options[key]} onChange={(e) => setDraft({ ...draft, options: { ...draft.options, [key]: e.target.checked } })} />
            {SYNC_OPTIONS[key]}
          </label>
        ))}
      </section>

      <section className="argo-sync-retry" aria-label={SYNC_RETRY_TITLE}>
        <h4>{SYNC_RETRY_TITLE}</h4>
        <label>
          {SYNC_RETRY}
          <input type="number" min="0" value={draft.retry.limit} onChange={(e) => retry("limit", e.target.value)} />
        </label>
        {draft.retry.limit !== "" && (
          <>
            <label>
              {SYNC_BACKOFF}
              <input value={draft.retry.duration} onChange={(e) => retry("duration", e.target.value)} />
            </label>
            <label>
              {SYNC_FACTOR}
              <input type="number" min="1" value={draft.retry.factor} onChange={(e) => retry("factor", e.target.value)} />
            </label>
            <label>
              {SYNC_MAX}
              <input value={draft.retry.maxDuration} onChange={(e) => retry("maxDuration", e.target.value)} />
            </label>
          </>
        )}
        {built.problem && (
          <p className="err" role="alert">
            {built.problem}
          </p>
        )}
      </section>

      <SyncDiff url={url} app={app} version={version} selected={draft.selected} revisionSet={draft.revision.trim() !== ""} />
    </FormSheet>
  );
}
