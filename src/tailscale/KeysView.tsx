import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { PreviewFooter } from "../iam/PreviewFooter";
import { ConfirmField, ReversibleNote, WarningList, useSheetFocus } from "../iam/previewParts";
import { fuzzyKeep } from "../lib/fuzzy";
import { ApiRequired } from "./ApiRequired";
import { tailscaleApi } from "./api";
import { LockControls } from "./LockControls";
import { KeyEditor } from "./KeyEditor";
import * as editorText from "./keyEditorText";
import type { TsKey, TsKeyDeletePreview, TsKeyFinding, TsKeyKind, TsKeys, TsLock } from "./keyTypes";
import * as k from "./keysText";
import * as t from "./text";
import type { TsNode } from "./types";
import { useTailscaleApi } from "./useTailscaleApi";

const KINDS: TsKeyKind[] = ["auth", "client", "federated", "api"];

/** 날짜까지만. RFC 3339의 앞 10자 */
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : k.NONE);

const keyName = (key: TsKey) => key.description || key.id;

/** 이 키가 가진 권한: auth key는 재사용·임시·사전 승인·태그, 나머지는 스코프와 태그 */
function Access({ item }: { item: TsKey }) {
  const chips =
    item.kind === "auth"
      ? [
          item.reusable && k.REUSABLE,
          item.ephemeral && k.EPHEMERAL,
          item.preauthorized && k.PREAUTHORIZED,
          ...item.tags,
        ]
      : [...item.scopes, ...item.tags];
  const shown = chips.filter((chip): chip is string => typeof chip === "string");
  if (shown.length === 0) return <>{k.NONE}</>;
  return (
    <>
      {shown.map((chip) => (
        <span key={chip} className="k8s-chip">
          {chip}
        </span>
      ))}
    </>
  );
}

type Pending = {
  phase: "loading" | "ready" | "applying";
  preview: TsKeyDeletePreview | null;
  error: { kind: "preview" | "apply"; message: string } | null;
  stale: boolean;
};

/** 삭제 미리보기 → 키 ID 입력 → 삭제 → 결과. 되돌릴 수 없어서 ID를 정확히 쳐야 [삭제]가 켜진다. */
function KeyDeleteSheet({
  tailnet,
  item,
  onClose,
  onDeleted,
}: {
  tailnet: string;
  item: TsKey;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState<Pending>({ phase: "loading", preview: null, error: null, stale: false });
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<{ logged: boolean } | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setPending({ phase: "loading", preview: null, error: null, stale: false });
    setTyped("");
    try {
      const preview = await tailscaleApi.keyDeletePreview(tailnet, item.id);
      if (alive.current && seq.current === mine) setPending({ phase: "ready", preview, error: null, stale: false });
    } catch (error) {
      if (alive.current && seq.current === mine)
        setPending({
          phase: "ready",
          preview: null,
          error: { kind: "preview", message: errorMessage(error) },
          stale: false,
        });
    }
  }, [tailnet, item.id]);
  useEffect(() => void load(), [load]);

  const phase = result ? "done" : pending.phase;
  const cancel = () => {
    if (pending.phase !== "applying") onClose();
  };
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, cancel);
  const { preview } = pending;

  const apply = async (confirm: string) => {
    if (!preview || pending.phase !== "ready" || pending.stale || confirm !== preview.confirmName) return;
    setPending({ ...pending, phase: "applying", error: null });
    try {
      const deleted = await tailscaleApi.keyDelete(tailnet, item.id, confirm);
      if (!alive.current) return;
      setResult(deleted);
      onDeleted();
    } catch (error) {
      if (alive.current)
        setPending({ ...pending, phase: "ready", error: { kind: "apply", message: errorMessage(error) }, stale: true });
    }
  };

  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="sheet wide cp"
        role="dialog"
        aria-modal="true"
        aria-label={k.DELETE_PREVIEW}
        ref={sheetRef}
        onKeyDown={trapTab}
      >
        <div className="cp-body">
          <h3>{k.DELETE_PREVIEW}</h3>
          <p>
            <strong>{keyName(item)}</strong>{" "}
            <span className="dim">
              {k.KIND_LABEL[item.kind]} · {item.id}
            </span>
          </p>
          {pending.phase === "loading" && <p>{k.DELETE_PREVIEW_LOADING}</p>}
          {preview && !result && (
            <>
              <h4>{k.CALLS}</h4>
              <ul className="cp-calls" aria-label={k.CALLS}>
                {preview.calls.map((call) => (
                  <li key={`${call.method} ${call.path}`}>
                    <code>
                      {call.method} {call.path}
                    </code>
                    <div className="cp-param">
                      <span className="dim">{k.CALL_SCOPE}</span>
                      <span className="cp-val mono">{call.scope}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <WarningList warnings={preview.warnings.map((message) => ({ level: "warn" as const, message }))} />
              <ReversibleNote reversible={preview.reversible} />
              <ConfirmField
                required={preview.confirmName}
                typed={typed}
                onTyped={setTyped}
                locked={pending.phase === "applying"}
                label={k.CONFIRM_LABEL(preview.confirmName)}
                mismatchHint={k.CONFIRM_MISMATCH}
              />
            </>
          )}
          {result && (
            <div role="status">
              <p>{k.deleted(keyName(item))}</p>
              {!result.logged && <p className="err">{k.NOT_LOGGED}</p>}
            </div>
          )}
        </div>
        {result ? (
          <div className="foot">
            <button className="btn plain tone-ghost" onClick={onClose} autoFocus>
              {k.CLOSE}
            </button>
          </div>
        ) : (
          <PreviewFooter
            gated={
              preview
                ? {
                    confirmText: preview.confirmName,
                    warnings: preview.warnings.map((message) => ({ level: "warn" as const, message })),
                  }
                : null
            }
            phase={pending.phase}
            error={pending.error}
            stale={pending.stale}
            typed={typed}
            cancelRef={cancelRef}
            retryRef={retryRef}
            onApply={(confirm) => void apply(confirm)}
            onRetry={() => void load()}
            onCancel={cancel}
            applyLabel={k.APPLY}
            applyTone="danger"
            busyLabel={k.APPLYING}
          />
        )}
      </div>
    </div>
  );
}

function LockPanel() {
  const lock = useQuery({ queryKey: ["tailscale", "lock"], queryFn: tailscaleApi.lockStatus, retry: false });
  if (lock.isLoading) return <p className="dim">{k.LOCK_LOADING}</p>;
  if (lock.isError) {
    return (
      <section className="ts-lock" aria-label={k.LOCK_TITLE}>
        <h3>{k.LOCK_TITLE}</h3>
        <p className="err" role="alert">
          {k.LOCK_ERROR}: {errorMessage(lock.error)}
        </p>
      </section>
    );
  }
  // CLI가 없으면 이 Mac의 잠금 상태를 알 수 없어서 패널을 숨긴다
  if (!lock.data) return null;
  return <LockDetails lock={lock.data} />;
}

function LockDetails({ lock }: { lock: TsLock }) {
  return (
    <section className="ts-lock" aria-label={k.LOCK_TITLE}>
      <h3>{k.LOCK_TITLE}</h3>
      <dl className="ts-details">
        <div>
          <dt>{k.LOCK_ENABLED}</dt>
          <dd>{lock.enabled ? k.LOCK_ON : k.LOCK_OFF}</dd>
        </div>
        {lock.publicKey && (
          <div>
            <dt>{k.LOCK_THIS_KEY}</dt>
            <dd>
              <code>{lock.publicKey}</code>
              {lock.thisKeyTrusted !== null && <div>{lock.thisKeyTrusted ? k.LOCK_TRUSTED : k.LOCK_NOT_TRUSTED}</div>}
            </dd>
          </div>
        )}
        {lock.enabled && (
          <>
            <div>
              <dt>{k.LOCK_NODE_KEY}</dt>
              <dd>{lock.nodeKeySigned ? k.LOCK_SIGNED : k.LOCK_UNSIGNED}</dd>
            </div>
            <div>
              <dt>{k.LOCK_TRUSTED_COUNT}</dt>
              <dd>{lock.trustedKeys}</dd>
            </div>
            <div>
              <dt>{k.LOCK_NEEDS_SIGNATURE}</dt>
              <dd>{lock.needsSignature.length === 0 ? k.LOCK_NONE_PENDING : lock.needsSignature.length}</dd>
            </div>
          </>
        )}
      </dl>
      {!lock.enabled && <p className="dim ts-note">{k.LOCK_DISABLED_NOTE}</p>}
      <LockControls lock={lock} />
    </section>
  );
}

function KeysPanel({ tailnet }: { tailnet: string }) {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ["tailscale", "keys", tailnet],
    queryFn: () => tailscaleApi.keys(tailnet),
    retry: false,
  });
  const [kind, setKind] = useState<TsKeyKind | "all" | "findings">("all");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<TsKey | null>(null);
  const [editing, setEditing] = useState<TsKey | "new" | null>(null);
  if (keys.isError) {
    return (
      <div>
        <p className="err" role="alert">
          {k.READ_ERROR}: {errorMessage(keys.error)}
        </p>
        <button className="btn small tone-refresh" onClick={() => void keys.refetch()}>
          {k.REFRESH}
        </button>
        <button className="btn small tone-create" onClick={() => setEditing("new")}>
          {editorText.CREATE_OPEN}
        </button>
        {editing === "new" && (
          <KeyEditor
            tailnet={tailnet}
            item={null}
            onClose={() => setEditing(null)}
            onDone={() => void qc.invalidateQueries({ queryKey: ["tailscale", "keys", tailnet] })}
          />
        )}
        <LockPanel />
      </div>
    );
  }
  if (!keys.data) {
    return (
      <div>
        <p className="empty">{k.LOADING}</p>
        <LockPanel />
      </div>
    );
  }
  return (
    <KeysTable
      data={keys.data}
      kind={kind}
      onKind={setKind}
      query={query}
      onQuery={setQuery}
      onRefresh={() => void keys.refetch()}
      onDelete={setDeleting}
      onCreate={() => setEditing("new")}
      onEdit={setEditing}
      sheet={
        <>
          {deleting && (
            <KeyDeleteSheet
              tailnet={tailnet}
              item={deleting}
              onClose={() => setDeleting(null)}
              onDeleted={() => void qc.invalidateQueries({ queryKey: ["tailscale", "keys", tailnet] })}
            />
          )}
          {editing && (
            <KeyEditor
              tailnet={tailnet}
              item={editing === "new" ? null : editing}
              onClose={() => setEditing(null)}
              onDone={() => void qc.invalidateQueries({ queryKey: ["tailscale", "keys", tailnet] })}
            />
          )}
        </>
      }
    />
  );
}

interface TableProps {
  data: TsKeys;
  kind: TsKeyKind | "all" | "findings";
  onKind: (kind: TsKeyKind | "all" | "findings") => void;
  query: string;
  onQuery: (query: string) => void;
  onRefresh: () => void;
  onDelete: (key: TsKey) => void;
  onCreate: () => void;
  onEdit: (key: TsKey) => void;
  sheet: ReactNode;
}

function KeysTable({ data, kind, onKind, query, onQuery, onRefresh, onDelete, onCreate, onEdit, sheet }: TableProps) {
  const byKey = new Map<string, TsKeyFinding[]>();
  for (const finding of data.findings) byKey.set(finding.keyId, [...(byKey.get(finding.keyId) ?? []), finding]);
  const searched = fuzzyKeep(data.keys, query, (key) => [
    key.description,
    key.id,
    key.userId,
    ...key.tags,
    ...key.scopes,
  ]);
  const matches = (key: TsKey, filter: typeof kind) =>
    filter === "all" ? true : filter === "findings" ? byKey.has(key.id) : key.kind === filter;
  const shown = searched.filter((key) => matches(key, kind));
  const named = new Map(data.keys.map((key) => [key.id, key]));
  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">{k.TAB_KEYS}</h2>
        <span className="awc-stat">
          {k.ALL} <b>{data.keys.length}</b>
        </span>
        <span className="awc-stat">
          {k.FINDINGS_ONLY} <b>{byKey.size}</b>
        </span>
        <span className="awc-stat">
          {k.findingShort.expiring} <b>{data.findings.filter((finding) => finding.kind === "expiring").length}</b>
        </span>
        <input
          className="k8s-filter"
          aria-label={k.SEARCH}
          placeholder={k.SEARCH}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <div className="awc-bar-end">
          <button className="btn small tone-create" onClick={onCreate}>
            {editorText.CREATE_OPEN}
          </button>
          <button className="btn small tone-refresh" onClick={onRefresh}>
            {k.REFRESH}
          </button>
        </div>
      </div>
      <div className="awc-panel">
        <section aria-label={k.FINDINGS_TITLE}>
          <h3>{k.FINDINGS_TITLE}</h3>
          {data.findings.length === 0 ? (
            <p className="dim">{k.NO_FINDINGS}</p>
          ) : (
            <ul className="ts-findings">
              {data.findings.map((finding) => (
                <li key={`${finding.keyId}-${finding.kind}`}>
                  <strong>{keyName(named.get(finding.keyId)!)}</strong>{" "}
                  <span className="dim">{k.KIND_LABEL[named.get(finding.keyId)!.kind]}</span> — {k.findingText(finding)}
                </li>
              ))}
            </ul>
          )}
        </section>
        <LockPanel />
      </div>
      <div className="argowf-filters">
        <button className="btn small" aria-pressed={kind === "all"} onClick={() => onKind("all")}>
          {k.ALL} {searched.length}
        </button>
        {KINDS.map((id) => (
          <button key={id} className="btn small" aria-pressed={kind === id} onClick={() => onKind(id)}>
            {k.KIND_LABEL[id]} {searched.filter((key) => key.kind === id).length}
          </button>
        ))}
        <button className="btn small" aria-pressed={kind === "findings"} onClick={() => onKind("findings")}>
          {k.FINDINGS_ONLY} {searched.filter((key) => byKey.has(key.id)).length}
        </button>
      </div>
      <div className="argowf-table-wrap">
        <table className="argowf-table">
          <thead>
            <tr>
              {[k.COL_KIND, k.COL_DESCRIPTION, k.COL_CREATED, k.COL_EXPIRES, k.COL_ACCESS, k.COL_FINDINGS].map(
                (label) => (
                  <th key={label}>{label}</th>
                ),
              )}
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((key) => (
              <tr key={key.id}>
                <td>{k.KIND_LABEL[key.kind]}</td>
                <td>
                  <strong>{key.description || k.NO_DESCRIPTION}</strong>
                  <div className="dim">{key.id}</div>
                </td>
                <td>{day(key.created)}</td>
                <td>{key.expires ? day(key.expires) : k.NO_EXPIRY}</td>
                <td>
                  <Access item={key} />
                </td>
                <td>
                  {(byKey.get(key.id) ?? []).map((finding) => (
                    <span key={finding.kind} className="sec-chip sev-medium" title={k.findingText(finding)}>
                      {k.findingShort[finding.kind]}
                    </span>
                  ))}
                </td>
                <td>
                  {(key.kind === "client" || key.kind === "federated") && (
                    <button className="btn small tone-primary" onClick={() => onEdit(key)}>
                      {editorText.EDIT_OPEN}
                    </button>
                  )}
                  <button className="btn small tone-danger" aria-label={k.deleteLabel(keyName(key))} onClick={() => onDelete(key)}>
                    {k.DELETE}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="empty small">{data.keys.length === 0 ? k.NO_KEYS : k.NO_MATCH}</p>}
      {sheet}
    </div>
  );
}

/** 테일넷의 키(auth key, OAuth 클라이언트, federated identity, API 토큰)와 이 Mac의 Tailnet Lock. */
export function KeysView(_props: { node: TsNode }) {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.API_LOADING}</div>;
  if (!connected || tailnet === null)
    return (
      <>
        <ApiRequired title={k.TAB_KEYS} />
        <LockPanel />
      </>
    );
  return <KeysPanel tailnet={tailnet} />;
}
