import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { devicesApi, tailscaleApi } from "./api";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import { formatAgo, formatDateTime, formatDay } from "../iam/format";
import { ApiRequired } from "./ApiRequired";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./usersText";

type Row = Record<string, unknown>;
type Operation = { action: string; rows: Row[]; value: unknown };

export function UsersView() {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.LOADING}</div>;
  if (!tailnet || !connected) return <ApiRequired title={t.TITLE} />;
  return <UsersPanel tailnet={tailnet} />;
}

function UsersPanel({ tailnet }: { tailnet: string }) {
  const users = useQuery({ queryKey: ["tailscale", "users", tailnet], queryFn: () => tailscaleApi.users(tailnet), retry: false });
  const invites = useQuery({ queryKey: ["tailscale", "user-invites", tailnet], queryFn: () => tailscaleApi.userInvites(tailnet), retry: false });
  const changes = useQuery({ queryKey: ["tailscale", "changes", tailnet], queryFn: () => devicesApi.changes(tailnet), retry: false });
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [role, setRole] = useState("member");
  const [email, setEmail] = useState("");
  const [op, setOp] = useState<Operation | null>(null);
  const rows = users.data?.users ?? [];
  const chosen = rows.filter((row) => selected.includes(String(row.id)));
  return <>
    <div className="awc-bar">
      <h2 className="awc-title">{t.TITLE}</h2>
      <span className="awc-stat">{rows.length}</span>
      <input className="k8s-filter" placeholder={t.SEARCH} value={search} onChange={(e) => setSearch(e.target.value)} />
    </div>
    <div className="argowf-filters">
      {["all", "active", "idle", "suspended", "needs-approval", "over-billing-limit"].map((value) => (
        <button key={value} className="btn small" title={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{t.STATUS[value]}</button>
      ))}
      <select aria-label={t.ROLE} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
        <option value="all">{t.ALL_ROLES}</option>
        {t.ROLES.map((value) => <option key={value} value={value}>{t.ROLE_NAMES[value]}</option>)}
      </select>
    </div>
    {users.isError && <div className="err" role="alert">{errorMessage(users.error)}</div>}
    {selected.length > 0 && (
      <div className="argowf-batch">
        <span>{selected.length}</span>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {t.ROLES.map((v) => <option key={v} value={v}>{t.ROLE_NAMES[v]}</option>)}
        </select>
        {["role", "approve", "suspend", "restore", "delete"].map((action) => (
          <button className="btn small" key={action} onClick={() => setOp({ action, rows: chosen, value: role })}>
            {t.ACTIONS[action]}
          </button>
        ))}
      </div>
    )}
    <div className="awc-scroll">
      <table className="argowf-table">
        <thead><tr><th></th>{t.COLUMNS.map((label) => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {rows.filter((row) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase())
            && (status === "all" || row.status === status) && (roleFilter === "all" || row.role === roleFilter))
            .map((row) => (
              <tr key={String(row.id)}>
                <td>
                  <input type="checkbox" checked={selected.includes(String(row.id))} onChange={(e) => setSelected(e.target.checked
                    ? [...selected, String(row.id)] : selected.filter((id) => id !== String(row.id)))} />
                </td>
                <td>{String(row.loginName ?? "-")}</td>
                <td title={String(row.role ?? "")}>{t.ROLE_NAMES[String(row.role)] ?? String(row.role ?? "-")}</td>
                <td title={String(row.status ?? "")}>
                  <span className={row.status === "active" ? "ok" : "dim"}>●</span>{" "}
                  {t.STATUS[String(row.status)] ?? String(row.status ?? "-")}
                </td>
                <td title={row.lastSeen ? `${formatDateTime(String(row.lastSeen))} (${String(row.lastSeen)})` : ""}>
                  {formatAgo(row.lastSeen as string) || "-"}
                </td>
                <td>{String(row.deviceCount ?? "-")}</td>
                <td title={String(row.created ?? "")}>{formatDay(row.created as string) || "-"}</td>
              </tr>
            ))}
        </tbody>
      </table>
    <section style={{ padding: "14px 16px" }}>
      <h3>{t.INVITES}</h3>
      {invites.isError && <div className="err" role="alert">{errorMessage(invites.error)}</div>}
      <p className="dim">{t.INVITE_DESCRIPTION}</p>
      <div className="awc-editor-opts">
        <label>{t.EMAIL} <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" /></label>
        <label>{t.ROLE} <select value={role} onChange={(e) => setRole(e.target.value)}>
          {t.ROLES.filter((v) => v !== "owner").map((v) => <option key={v} value={v}>{t.ROLE_NAMES[v]}</option>)}
        </select></label>
        <button className="btn small" disabled={!email || role === "owner"}
          onClick={() => setOp({ action: "createInvite", rows: [{}], value: { email, role } })}>{t.CREATE}</button>
      </div>
      {!invites.isLoading && !invites.isError && !invites.data?.length && <p className="dim">{t.NO_INVITES}</p>}
      {(invites.data ?? []).map((row) => (
        <p key={String(row.id)}>
          {String(row.email ?? "-")} · <span title={String(row.role ?? "")}>{t.ROLE_NAMES[String(row.role)] ?? String(row.role ?? "-")}</span>{" "}
          {(["resendInvite", "deleteInvite"] as const).map((action) => (
            <button key={action} className="btn small" onClick={() => setOp({ action, rows: [row], value: null })}>
              {t.ACTIONS[action]}
            </button>
          ))}
        </p>
      ))}
    </section>
    <section style={{ padding: "14px 16px" }}>
      <h3>{t.CHANGE_LOG}</h3>
      {changes.data?.filter((change) => ["user:role", "user:suspend", "user:restore"].includes(change.action)).map((change) => {
        const user = rows.find((row) => row.id === change.target.name);
        const before = change.before && typeof change.before === "object" ? change.before as Row : null;
        if (!user || !before) return null;
        const action = change.action === "user:role" ? "role" : change.action === "user:suspend" ? "restore" : "suspend";
        const matches = change.action === "user:role" ? user.role === change.after
          : change.action === "user:suspend" ? user.status === "suspended" : user.status !== "suspended";
        return (
          <p key={change.id}>
            <span title={change.at}>{formatDateTime(change.at)}</span>
            {" · "}
            {String(before.loginName ?? change.target.name)}
            {" · "}
            <span title={change.action}>{t.ACTIONS[change.action.split(":")[1]] ?? change.action}</span>{" "}
            <button className="btn small" disabled={!matches}
              onClick={() => setOp({ action, rows: [user], value: before.role })}>{t.UNDO}</button>
          </p>
        );
      })}
    </section>
    </div>
    {op && <UserDialog tailnet={tailnet} op={op} cancel={() => setOp(null)} done={() => {
      setOp(null);
      setSelected([]);
      void users.refetch();
      void invites.refetch();
      void changes.refetch();
    }} />}
  </>;
}

function UserDialog({ tailnet, op, cancel, done }: { tailnet: string; op: Operation; cancel: () => void; done: () => void }) {
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const { sheetRef, trapTab } = useModal(() => { if (!sending) cancel(); });
  const risky = op.action === "delete" || op.action === "deleteInvite" || (op.action === "role" && op.value === "owner");
  const expected = op.rows.map((r) => String(op.action === "deleteInvite" ? r.id ?? "" : r.loginName ?? "")).join(", ");
  const apply = async () => {
    setSending(true);
    const output: string[] = [];
    for (const row of op.rows) {
      try {
        const result = await tailscaleApi.userApply({
          tailnet, action: op.action, id: String(row.id ?? ""), value: op.value, before: row,
          typed: risky ? String(op.action === "deleteInvite" ? row.id ?? "" : row.loginName ?? "") : "",
        });
        output.push(`${String(row.loginName ?? row.email ?? "")}: ${JSON.stringify(result)}`);
      } catch (e) {
        output.push(`${String(row.loginName ?? row.email ?? "")}: ${errorMessage(e)}`);
      }
    }
    setResults(output); setSending(false);
  };
  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !sending) done(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={t.PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{t.ACTIONS[op.action]}</h3>
        {op.rows.map((row, i) => {
          const call = op.action === "createInvite" ? "POST /tailnet/-/user-invites"
            : op.action.endsWith("Invite")
              ? `${op.action === "deleteInvite" ? "DELETE" : "POST"} /user-invites/${String(row.id)}${op.action === "resendInvite" ? "/resend" : ""}`
              : `POST /users/${String(row.id)}/${op.action}`;
          return <pre key={i}>{call} {JSON.stringify(op.value)}</pre>;
        })}
        {risky && <label>{expected}<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
        {results.length > 0 && <><h4>{t.RESULT}</h4>{results.map((result, i) => <p key={i}>{result}</p>)}</>}
        <div className="foot">
          <button className="btn small" disabled={sending} onClick={results.length ? done : cancel}>{t.CANCEL}</button>
          <button className="btn small" disabled={sending || results.length > 0 || (risky && typed !== expected)}
            onClick={() => void apply()}>{t.APPLY}</button>
        </div>
      </div>
    </div>
  );
}
