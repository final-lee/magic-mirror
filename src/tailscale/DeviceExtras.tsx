import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { devicesApi } from "./api";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import * as t from "./deviceExtraText";

type Plan = { action: string; id: string; body: unknown; before: unknown; call: string; confirm?: string };
export function DeviceExtras({ tailnet, ids, close }: { tailnet: string; ids: string[]; close: () => void }) {
  const attributes = useQuery({
    queryKey: ["tailscale", "attributes", tailnet, ids],
    queryFn: async () => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await devicesApi.extraList(tailnet, id, false)]))),
    retry: false,
  });
  const invites = useQuery({
    queryKey: ["tailscale", "device-invites", tailnet, ids[0]],
    queryFn: async () => {
      const value = await devicesApi.extraList(tailnet, ids[0], true);
      return Array.isArray(value) ? value as Record<string, unknown>[] : [];
    },
    enabled: ids.length === 1,
    retry: false,
  });
  const [key, setKey] = useState("custom:");
  const [value, setValue] = useState('""');
  const [expiry, setExpiry] = useState("");
  const [comment, setComment] = useState("");
  const [email, setEmail] = useState("");
  const [allowExitNode, setAllowExitNode] = useState(false);
  const [multiUse, setMultiUse] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".modal")) close();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (document.querySelector(".modal")) return;
      const target = event.target;
      if (target instanceof Element && target.matches(".argowf-list, .argowf-table-wrap, .argowf-content")) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [close]);
  const build = (remove: boolean) => {
    try {
      const parsed: unknown = remove ? null : JSON.parse(value);
      if (!key.startsWith("custom:") || key.length === 7 || (!remove && !["string", "number", "boolean"].includes(typeof parsed))) throw new Error();
      const attribute = remove ? null : { value: parsed, ...(expiry ? { expiry } : {}) };
      const nodes = Object.fromEntries(ids.map((id) => [id, { [key]: attribute }]));
      const body = { nodes, ...(comment ? { comment } : {}) };
      setError("");
      setPlan({
        action: "attributes", id: "", body, before: attributes.data,
        call: "PATCH /tailnet/-/device-attributes", confirm: remove ? key : undefined,
      });
    } catch { setError(t.VALUE); }
  };
  return (
    <div className="awc-panel">
      <div className="ts-panel-head">
        <h3>{t.TITLE}</h3>
        <button className="btn small tone-ghost" aria-label={t.CLOSE} onClick={close}>✕</button>
      </div>
      {result && <pre role="status">{result}</pre>}
      <section>
        <h3>{t.ATTRIBUTES}</h3>
        <p className="dim">{t.ATTRIBUTE_DESCRIPTION}</p>
        {attributes.isError && <div className="err">{errorMessage(attributes.error)}</div>}
        {attributes.data && Object.entries(attributes.data).map(([id, data]) => {
          const fields = data && typeof data === "object" && "attributes" in data && data.attributes && typeof data.attributes === "object"
            ? Object.entries(data.attributes) : [];
          return <div key={id}>
            <h4 className="mono">{id}</h4>
            {fields.length ? <dl className="kv">{fields.map(([name, item]) => (
              <div key={name}><dt>{name}</dt><dd>{typeof item === "object" ? JSON.stringify(item) : String(item)}</dd></div>
            ))}</dl> : <p className="dim">{t.NO_ATTRIBUTES}</p>}
          </div>;
        })}
        <details><summary>{t.RAW}</summary><pre>{JSON.stringify(attributes.data, null, 2)}</pre></details>
        <div className="awc-form-grid">
          <label className="field">{t.KEY}<input aria-label={t.KEY} value={key} onChange={(e) => setKey(e.target.value)} /></label>
          <label className="field">{t.VALUE}<input aria-label={t.VALUE} value={value} onChange={(e) => setValue(e.target.value)} /></label>
          <label className="field">
            {t.EXPIRY}
            <input aria-label={t.EXPIRY} placeholder={t.EXPIRY} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </label>
          <label className="field">
            {t.COMMENT}
            <input aria-label={t.COMMENT} placeholder={t.COMMENT} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </div>
        <div className="awc-editor-opts">
          <button className="btn small tone-primary" disabled={!attributes.data} onClick={() => build(false)}>{t.SET}</button>
          <button className="btn small tone-danger" disabled={!attributes.data} onClick={() => build(true)}>{t.DELETE}</button>
        </div>
        {error && <div className="err">{error}</div>}
      </section>
      {ids.length === 1 && (
        <>
          <h3>{t.INVITES}</h3>
          <p className="dim">{t.SHARE_DESCRIPTION}</p>
          {invites.isError && <div className="err">{errorMessage(invites.error)}</div>}
          <div className="awc-editor-opts">
            <label>{t.EMAIL} <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" /></label>
            <label title="allowExitNode">
              <input type="checkbox" checked={allowExitNode} onChange={(e) => setAllowExitNode(e.target.checked)} />
              {t.ALLOW_EXIT_NODE}
            </label>
            <label title="multiUse">
              <input type="checkbox" checked={multiUse} onChange={(e) => setMultiUse(e.target.checked)} />
              {t.MULTI_USE}
            </label>
            <button className="btn small tone-create" onClick={() => setPlan({
              action: "createInvite", id: ids[0], body: { ...(email ? { email } : {}), allowExitNode, multiUse },
              before: null, call: `POST /device/${encodeURIComponent(ids[0])}/device-invites`,
            })}>{t.CREATE}</button>
          </div>
          {!invites.isLoading && !invites.isError && !invites.data?.length && <p className="dim">{t.NO_INVITES}</p>}
          {(invites.data ?? []).map((invite) => (
            <p key={String(invite.id)}>
              {String(invite.email ?? "-")}
              <button className="btn small tone-primary" onClick={() => setPlan({
                action: "resendInvite", id: String(invite.id), body: null, before: invite,
                call: `POST /device-invites/${encodeURIComponent(String(invite.id))}/resend`,
              })}>{t.RESEND}</button>
              <button className="btn small tone-danger" onClick={() => setPlan({
                action: "deleteInvite", id: String(invite.id), body: null, before: invite,
                call: `DELETE /device-invites/${encodeURIComponent(String(invite.id))}`,
              })}>{t.DELETE_INVITE}</button>
            </p>
          ))}
        </>
      )}
      {plan && (
        <ExtraDialog tailnet={tailnet} plan={plan} cancel={() => setPlan(null)} done={(value) => {
          setResult(value);
          setPlan(null);
          void attributes.refetch();
          void invites.refetch();
        }} />
      )}
    </div>
  );
}
function ExtraDialog({ tailnet, plan, cancel, done }: { tailnet: string; plan: Plan; cancel: () => void; done: (value: string) => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab } = useModal(() => { if (!sending) cancel(); });
  const expected = plan.action === "deleteInvite" ? plan.id : plan.confirm;
  const tone = plan.action === "createInvite" ? "create" : plan.action === "deleteInvite" || plan.confirm ? "danger" : "primary";
  const apply = async () => {
    setSending(true);
    try {
      const result = await devicesApi.extraApply({ tailnet, ...plan, typed });
      done(JSON.stringify(result, null, 2));
    } catch (e) {
      setError(errorMessage(e));
      setSending(false);
    }
  };
  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !sending) cancel(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={t.PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{t.PREVIEW}</h3>
        <pre>{plan.call}{"\n"}{JSON.stringify(plan.action === "createInvite" ? [plan.body] : plan.body, null, 2)}</pre>
        {expected && <label>{expected}<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
        {error && <div className="err">{error}</div>}
        <div className="foot">
          <button className="btn small tone-ghost" disabled={sending} onClick={cancel}>{t.CANCEL}</button>
          <button className={`btn small tone-${tone}`} disabled={sending || (!!expected && typed !== expected)}
            onClick={() => void apply()}>{t.APPLY}</button>
        </div>
      </div>
    </div>
  );
}
