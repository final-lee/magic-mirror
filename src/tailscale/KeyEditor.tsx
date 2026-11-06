import { useEffect, useState } from "react";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { invoke } from "../api/invoke";
import { useModal } from "../iam/useModal";
import type { TsKey } from "./keyTypes";
import * as t from "./keyEditorText";

type Kind = "auth" | "client" | "federated";
type Detail = {
  keyType?: Kind;
  description?: string;
  scopes?: string[];
  tags?: string[];
  issuer?: string;
  subject?: string;
  audience?: string;
  customClaimRules?: Record<string, string>;
};
const GROUPS: Record<string, string[]> = {
  [t.GROUP_ALL]: ["all:read", "all"],
  [t.GROUP_DEVICES]: [
    "devices:core:read",
    "devices:core",
    "devices:routes:read",
    "devices:routes",
    "devices:posture_attributes:read",
    "devices:posture_attributes",
    "device_invites:read",
    "device_invites",
  ],
  [t.GROUP_KEYS]: [
    "auth_keys:read",
    "auth_keys",
    "oauth_keys:read",
    "oauth_keys",
    "federated_keys:read",
    "federated_keys",
    "api_access_tokens:read",
    "api_access_tokens",
  ],
  [t.GROUP_POLICY_USERS]: ["policy_file:read", "policy_file", "users:read", "users"],
  [t.GROUP_SETTINGS_INTEGRATIONS]: [
    "feature_settings:read",
    "feature_settings",
    "networking_settings:read",
    "networking_settings",
    "account_settings:read",
    "account_settings",
    "webhooks:read",
    "webhooks",
    "oauth_apps:read",
    "oauth_apps",
    "log_streaming:read",
    "log_streaming",
  ],
  [t.GROUP_LOGS_SERVICES]: [
    "logs:configuration:read",
    "logs:network:read",
    "logs:network",
    "services:read",
    "services",
    "tailnets:read",
    "tailnets",
  ],
};
const split = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
function ScopeFields({ scopes, setScopes, extra, setExtra }: {
  scopes: string[];
  setScopes: (scopes: string[]) => void;
  extra: string;
  setExtra: (extra: string) => void;
}) {
  return (
    <>
      <h3>{t.SCOPES}</h3>
      <p className="dim">{t.SCOPE_DESCRIPTION}</p>
      <div className="awc-form-grid">
      {Object.entries(GROUPS).map(([group, values]) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          <div className="awc-form-grid">
          {values.map((scope) => (
            <label className="awc-editor-opts" key={scope} title={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(e) =>
                  setScopes(e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope))
                }
              />
              {t.scopeLabel(scope)}
            </label>
          ))}
          </div>
        </fieldset>
      ))}
      </div>
      <label className="field">
        {t.EXTRA_SCOPES}
        <input value={extra} onChange={(e) => setExtra(e.target.value)} />
      </label>
    </>
  );
}

export function KeyEditor({
  tailnet,
  item,
  onClose,
  onDone,
}: {
  tailnet: string;
  item: TsKey | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<Kind>(item?.kind === "client" || item?.kind === "federated" ? item.kind : "auth");
  const [description, setDescription] = useState(item?.description ?? "");
  const [reusable, setReusable] = useState(false);
  const [ephemeral, setEphemeral] = useState(false);
  const [preauthorized, setPreauthorized] = useState(false);
  const [expiry, setExpiry] = useState("7776000");
  const [tags, setTags] = useState(item?.tags.join(", ") ?? "");
  const [scopes, setScopes] = useState<string[]>(
    (item?.scopes ?? []).filter((scope) => Object.values(GROUPS).some((group) => group.includes(scope))),
  );
  const [extra, setExtra] = useState(
    (item?.scopes ?? []).filter((scope) => !Object.values(GROUPS).some((group) => group.includes(scope))).join(", "),
  );
  const [issuer, setIssuer] = useState("");
  const [subject, setSubject] = useState("");
  const [audience, setAudience] = useState("");
  const [claims, setClaims] = useState("{}");
  const [body, setBody] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [previous, setPrevious] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(item));
  const [error, setError] = useState("");
  const close = () => {
    if (!busy && !loading) onClose();
  };
  const { sheetRef, trapTab } = useModal(close);
  useEffect(() => {
    if (!item) return;
    let active = true;
    invoke<Detail>("tailscale_key_detail", { tailnet, id: item.id })
      .then((d) => {
        if (!active) return;
        setIssuer(d.issuer ?? "");
        setSubject(d.subject ?? "");
        setAudience(d.audience ?? "");
        setClaims(JSON.stringify(d.customClaimRules ?? {}, null, 2));
        const old: Record<string, unknown> = {
          keyType: item.kind,
          description: d.description ?? item.description,
          scopes: d.scopes ?? item.scopes,
          tags: d.tags ?? item.tags,
        };
        if (item.kind === "federated") {
          old.issuer = d.issuer ?? "";
          old.subject = d.subject ?? "";
          old.audience = d.audience ?? "";
          old.customClaimRules = d.customClaimRules ?? {};
        }
        setPrevious(old);
      })
      .catch((e: unknown) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [item, tailnet]);
  function preview() {
    setError("");
    const selected = Array.from(new Set([...scopes, ...split(extra)]));
    const tagList = split(tags);
    if (kind !== "auth" && selected.some((s) => s === "devices:core" || s === "auth_keys") && !tagList.length) {
      setError(t.NEED_TAG);
      return;
    }
    const value: Record<string, unknown> = { keyType: kind, description };
    if (kind === "auth") {
      value.expirySeconds = Number(expiry);
      value.capabilities = { devices: { create: { reusable, ephemeral, preauthorized, tags: tagList } } };
    } else {
      value.scopes = selected;
      value.tags = tagList;
    }
    if (kind === "federated") {
      try {
        const parsed: unknown = JSON.parse(claims);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((v) => typeof v !== "string")
        )
          throw new Error();
        value.issuer = issuer;
        value.subject = subject;
        if (audience) value.audience = audience;
        value.customClaimRules = parsed;
      } catch {
        setError(t.BAD_CLAIMS);
        return;
      }
    }
    setBody(value);
  }
  async function apply() {
    if (!body) return;
    setBusy(true);
    setError("");
    try {
      setResult(await invoke<Record<string, unknown>>("tailscale_key_save", { tailnet, id: item?.id ?? null, body }));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const secret =
    typeof result?.key === "string" ? result.key : typeof result?.secret === "string" ? result.secret : null;
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="sheet wide"
        role="dialog"
        aria-modal="true"
        aria-label={result ? t.DONE : body ? t.PREVIEW : item ? t.EDIT : t.CREATE}
        ref={sheetRef}
        onKeyDown={trapTab}
      >
        <h3>{result ? t.DONE : body ? t.PREVIEW : item ? t.EDIT : t.CREATE}</h3>
        {!body && !result && (
          <div className="awc-body">
            <h3>{t.BASIC_INFO}</h3>
            <p className="dim">{t.BASIC_DESCRIPTION}</p>
            <div className="awc-form-grid">
            <label className="field" title="keyType">
              {t.TYPE}
              <select value={kind} disabled={Boolean(item)} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="auth">{t.AUTH_KEY}</option>
                <option value="client">{t.OAUTH_CLIENT}</option>
                <option value="federated">{t.FEDERATED_ID}</option>
              </select>
            </label>
            <label className="field" title="description">
              {t.DESCRIPTION}
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            {kind === "auth" && (
              <>
                <label className="awc-editor-opts" title="reusable">
                  <input type="checkbox" checked={reusable} onChange={(e) => setReusable(e.target.checked)} />
                  {t.REUSABLE}
                </label>
                <label className="awc-editor-opts" title="ephemeral">
                  <input type="checkbox" checked={ephemeral} onChange={(e) => setEphemeral(e.target.checked)} />
                  {t.EPHEMERAL}
                </label>
                <label className="awc-editor-opts" title="preauthorized">
                  <input type="checkbox" checked={preauthorized} onChange={(e) => setPreauthorized(e.target.checked)} />
                  {t.PREAUTHORIZED}
                </label>
                <label className="field" title="expirySeconds">
                  {t.EXPIRY}
                  <input type="number" min="1" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                </label>
              </>
            )}
            <label className="field" title="tags">
              {t.TAGS}
              <input aria-label={t.TAGS} value={tags} onChange={(e) => setTags(e.target.value)} />
              <small className="dim">{t.COMMA_HELP}</small>
            </label>
            </div>
            {kind !== "auth" && (
              <ScopeFields scopes={scopes} setScopes={setScopes} extra={extra} setExtra={setExtra} />
            )}
            {kind === "federated" && (
              <>
                <h3>{t.FEDERATED_SETTINGS}</h3>
                <p className="dim">{t.FEDERATED_DESCRIPTION}</p>
                <div className="awc-form-grid">
                <label className="field" title="issuer">
                  {t.ISSUER}
                  <input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
                </label>
                <label className="field" title="subject">
                  {t.SUBJECT}
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} />
                </label>
                <label className="field" title="audience">
                  {t.AUDIENCE}
                  <input value={audience} onChange={(e) => setAudience(e.target.value)} />
                </label>
                <label className="field" title="customClaimRules">
                  {t.CLAIMS}
                  <textarea value={claims} onChange={(e) => setClaims(e.target.value)} />
                </label>
                </div>
              </>
            )}
            <button className="btn small" disabled={loading} onClick={preview}>
              {t.PREVIEW}
            </button>
          </div>
        )}
        {body && !result && (
          <>
            <pre>
              {item ? `PUT /tailnet/-/keys/${encodeURIComponent(item.id)}` : "POST /tailnet/-/keys"}
              {"\n"}
              {JSON.stringify(body, null, 2)}
            </pre>
            <button className="btn small" disabled={busy} onClick={() => void apply()}>
              {t.APPLY}
            </button>
            <button className="btn small" disabled={busy} onClick={() => setBody(null)}>
              {t.EDIT}
            </button>
          </>
        )}
        {result && secret && (
          <>
            <p>{t.SECRET}</p>
            <code>{secret}</code>
            <button className="btn small" onClick={() => void desktop.copy(secret)}>
              {t.COPY}
            </button>
          </>
        )}
        {result && previous && (
          <button
            className="btn small"
            onClick={() => {
              setBody(previous);
              setPrevious(body);
              setResult(null);
            }}
          >
            {t.UNDO}
          </button>
        )}
        <button className="btn small" disabled={busy || loading} onClick={close}>
          {result ? t.CLOSE : t.CANCEL}
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
