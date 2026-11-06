import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useResources } from "../api/queries";
import { fuzzyKeep } from "../lib/fuzzy";
import { useModal } from "../iam/useModal";
import { DeviceChange } from "./DeviceChange";
import { DeviceExtras } from "./DeviceExtras";
import * as extraText from "./deviceExtraText";
import { DeviceMap } from "./DeviceMap";
import { peerFor } from "./deviceMapLayout";
import { devicesApi } from "./api";
import { isExitRoute } from "./coverage";
import type { Change, Device, Preview } from "./devicesApi";
import * as text from "./devicesText";
import { useDeviceView } from "./TabContext";
import * as t from "./text";
import type { TsNode, TsPeer } from "./types";

function matches(device: Device, filter: string, peers: TsPeer[]) {
  const peer = peerFor(device, peers);
  return (
    filter === "all" ||
    (filter === "online" && !!peer?.online) ||
    (filter === "router" && (device.advertisedRoutes ?? []).some((route) => !isExitRoute(route))) ||
    (filter === "exit" && (device.advertisedRoutes ?? []).some(isExitRoute)) ||
    !!device.findings?.includes(filter)
  );
}

function FilterChips({
  devices,
  peers,
  filter,
  setFilter,
}: {
  devices: Device[];
  peers: TsPeer[];
  filter: string;
  setFilter: (value: string) => void;
}) {
  const chips = [
    ["all", text.ALL],
    ["online", text.ONLINE],
    ["router", text.ROUTER],
    ["exit", text.EXIT_NODE],
    ...Object.entries(text.FINDINGS),
  ];
  return (
    <div className="argowf-filters">
      {chips.map(([id, label]) => (
        <button key={id} className="btn small" aria-pressed={filter === id} onClick={() => setFilter(id)}>
          {label} {devices.filter((device) => matches(device, id, peers)).length}
        </button>
      ))}
    </div>
  );
}

function DeviceTable({
  devices,
  peers,
  selected,
  setSelected,
}: {
  devices: Device[];
  peers: TsPeer[];
  selected: string[];
  setSelected: (value: string[]) => void;
}) {
  return (
    <div className="argowf-table-wrap">
      <table className="argowf-table">
        <thead>
          <tr>
            <th>{text.SELECT}</th>
            <th>{text.NAME}</th>
            <th>{text.OS}</th>
            <th>{text.ADDRESS}</th>
            <th>{text.STATUS}</th>
            <th>{text.CONNECTION}</th>
            <th>{text.TAGS}</th>
            <th>{text.OWNER}</th>
            <th>{text.FINDING}</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const peer = peerFor(device, peers);
            return (
              <tr key={device.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={text.selectDevice(device.name)}
                    checked={selected.includes(device.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? [...selected, device.id] : selected.filter((id) => id !== device.id),
                      )
                    }
                  />
                </td>
                <td>
                  <strong>{device.hostname || device.name}</strong>
                  <div className="dim">{device.name}</div>
                </td>
                <td>{device.os || text.NONE}</td>
                <td>{(device.addresses ?? []).join(", ")}</td>
                <td>
                  {peer ? (
                    <span className={`argowf-phase ${peer.online ? "Succeeded" : ""}`}>
                      ● {peer.online ? text.ONLINE : text.OFFLINE}
                    </span>
                  ) : (
                    text.NONE
                  )}
                </td>
                <td>{peer?.online ? (peer.curAddr ? text.DIRECT : text.relay(peer.relay)) : text.NONE}</td>
                <td>{device.tags?.join(", ") || text.NONE}</td>
                <td>{device.user || text.NONE}</td>
                <td>
                  {device.findings?.length
                    ? device.findings.map((finding) => (
                        <span className="sec-chip sev-medium" key={finding}>
                          {text.FINDINGS[finding] || finding}
                        </span>
                      ))
                    : text.NONE}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BulkActionBar({
  selected,
  action,
  setAction,
  value,
  setValue,
  busy,
  preview,
  clear,
}: {
  selected: string[];
  action: string;
  setAction: (value: string) => void;
  value: string;
  setValue: (value: string) => void;
  busy: boolean;
  preview: () => void;
  clear: () => void;
}) {
  return (
    <div className="argowf-batch" role="toolbar" aria-label={text.ACTION}>
      <span>{text.selectedCount(selected.length)}</span>
      <select aria-label={text.ACTION} value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="authorize">{text.AUTHORIZE}</option>
        <option value="tags">{text.SET_TAGS}</option>
        <option value="expire">{text.EXPIRE_KEY}</option>
        <option value="keyExpiryOff">{text.EXPIRY_OFF}</option>
        <option value="keyExpiryOn">{text.EXPIRY_ON}</option>
        <option value="name">{text.RENAME}</option>
        <option value="ip">{text.SET_IP}</option>
        <option value="delete">{text.DELETE}</option>
      </select>
      {(action === "tags" || action === "name" || action === "ip") && (
        <input
          aria-label={action === "tags" ? text.TAGS_INPUT : action === "ip" ? text.IP_INPUT : text.NEW_NAME}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <button
        className="btn primary small"
        disabled={
          busy || !selected.length || (["name", "ip"].includes(action) && (selected.length !== 1 || !value.trim()))
        }
        onClick={preview}
      >
        {text.PREVIEW}
      </button>
      <button className="btn plain small" onClick={clear}>
        {text.CLEAR_SELECTION}
      </button>
    </div>
  );
}

function shareCommands(value: unknown): string[][] | null {
  if (!value || typeof value !== "object" || !("commands" in value) || !Array.isArray(value.commands)) return null;
  return value.commands.every(
    (command: unknown) => Array.isArray(command) && command.every((arg: unknown) => typeof arg === "string"),
  )
    ? value.commands
    : null;
}

function shareReason(value: unknown): string | null {
  return value && typeof value === "object" && "reason" in value && typeof value.reason === "string"
    ? value.reason
    : null;
}

function undoCall(action: string, id: string | undefined, before: unknown, after: unknown): string {
  if (action === "shareConfig" || action === "serviceConfig") {
    const commands = (shareCommands(before) ?? [])
      .map((args) => ["tailscale", ...args].map((value) => `'${value.replace(/'/g, "'\\''")}'`).join(" "))
      .join("\n");
    const input =
      action === "serviceConfig" && before && typeof before === "object" && "config" in before
        ? `\n${text.STANDARD_INPUT}:\n${JSON.stringify(before.config, null, 2)}`
        : "";
    return commands + input;
  }
  if (action === "localPreference") {
    const prior = before as { key: string; value: string | boolean };
    const flag = `--${prior.key}=${String(prior.value)}`.replace(/'/g, "'\\''");
    return `tailscale set '${flag}'`;
  }
  if (action === "lockTrustedKey") {
    const prior = before as { key: string; trusted: boolean };
    const key = prior.key.replace(/'/g, "'\\''");
    return `tailscale lock ${prior.trusted ? "add" : "remove"} '${key}'`;
  }
  if (action === "policy") return `POST /tailnet/-/acl\n${String(before)}`;
  if (action === "attributes") {
    const snapshots = before as Record<
      string,
      { attributes?: Record<string, unknown>; expiries?: Record<string, string> }
    >;
    const payload = after as { nodes: Record<string, Record<string, unknown>> };
    const restored = Object.fromEntries(
      Object.entries(payload.nodes).map(([deviceId, attrs]) => [
        deviceId,
        Object.fromEntries(
          Object.keys(attrs).map((key) => {
            const value = snapshots[deviceId]?.attributes?.[key];
            const expiry = snapshots[deviceId]?.expiries?.[key];
            return [key, value === undefined ? null : { value, ...(expiry ? { expiry } : {}) }];
          }),
        ),
      ]),
    );
    return `PATCH /tailnet/-/device-attributes\n${JSON.stringify({ nodes: restored })}`;
  }
  const suffix = action === "keyExpiry" ? "key" : action;
  const key = action === "keyExpiry" ? "keyExpiryDisabled" : action === "ip" ? "ipv4" : action;
  return `POST /device/${encodeURIComponent(id ?? "")}/${suffix}\n${JSON.stringify({ [key]: before })}`;
}

function ChangeLog({
  changes,
  error,
  busy,
  undoId,
  setUndoId,
  undo,
}: {
  changes: Change[] | undefined;
  error: unknown;
  busy: boolean;
  undoId: string | null;
  setUndoId: (id: string | null) => void;
  undo: (id: string) => void;
}) {
  const closeUndo = () => {
    if (!busy) setUndoId(null);
  };
  const { sheetRef, trapTab } = useModal(closeUndo);
  return (
    <div className="awc-panel">
      <h3>{text.CHANGE_LOG}</h3>
      {error != null && (
        <p className="err" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <div className="argowf-table-wrap">
        <table className="argowf-table">
          <thead>
            <tr>
              <th>{text.TIME}</th>
              <th>{text.TARGET}</th>
              <th>{text.CHANGE}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {changes?.map((change) => (
              <tr key={change.id}>
                <td>{change.at}</td>
                <td>{change.target.name || text.POLICY}</td>
                <td>{change.summary}</td>
                <td>
                  {!change.undone &&
                    !change.undoOf &&
                    ([
                      "tags",
                      "name",
                      "ip",
                      "keyExpiry",
                      "policy",
                      "attributes",
                      "localPreference",
                      "lockTrustedKey",
                    ].includes(change.action) ||
                      (["shareConfig", "serviceConfig"].includes(change.action) &&
                        shareCommands(change.before) !== null)) && (
                      <button className="btn small" disabled={busy} onClick={() => setUndoId(change.id)}>
                        {text.UNDO}
                      </button>
                    )}
                  {["shareConfig", "serviceConfig"].includes(change.action) && shareReason(change.before) && (
                    <span>{shareReason(change.before)}</span>
                  )}
                  {change.undone && text.UNDONE}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {changes
        ?.filter((change) => change.id === undoId)
        .map((change) => (
          <div
            className="modal"
            key={change.id}
            onClick={(e) => {
              if (e.target === e.currentTarget) closeUndo();
            }}
          >
            <div
              className="sheet"
              role="dialog"
              aria-modal="true"
              aria-label={text.UNDO_CONFIRM}
              ref={sheetRef}
              onKeyDown={trapTab}
            >
              <h3>{text.UNDO_CONFIRM}</h3>
              <p>{text.undoDescription(change.target.name)}</p>
              <pre>{undoCall(change.action, change.target.deviceId, change.before, change.after)}</pre>
              <div className="foot">
                <button className="btn" disabled={busy} onClick={closeUndo}>
                  {text.CANCEL}
                </button>
                <button className="btn primary" disabled={busy} onClick={() => undo(change.id)}>
                  {text.APPLY_UNDO}
                </button>
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

export function ApiPeersView({
  node,
  tailnet,
  profile = null,
  region = "us-east-1",
}: {
  node: TsNode;
  tailnet: string;
  profile?: string | null;
  region?: string;
}) {
  const qc = useQueryClient();
  const devices = useQuery({
    queryKey: ["tailscale", "devices", tailnet],
    queryFn: () => devicesApi.list(tailnet),
    retry: false,
  });
  const changes = useQuery({
    queryKey: ["tailscale", "changes", tailnet],
    queryFn: () => devicesApi.changes(tailnet),
    retry: false,
  });
  const vpcs = useResources(profile, region, { id: "vpc", name: "VPC", global: false, types: [] }, "vpcs", false);
  const [view, setView] = useDeviceView();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [action, setAction] = useState("authorize");
  const [value, setValue] = useState("");
  const [plan, setPlan] = useState<Preview | null>(null);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [extras, setExtras] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tailscale", "devices", tailnet] });
    void qc.invalidateQueries({ queryKey: ["tailscale", "changes", tailnet] });
  };
  const searched = fuzzyKeep(devices.data ?? [], query, (d) => [
    d.name,
    d.hostname ?? "",
    d.os ?? "",
    ...(d.addresses ?? []),
    ...(d.tags ?? []),
    d.user ?? "",
  ]);

  async function preview() {
    setBusy(true);
    setError("");
    const v =
      action === "tags"
        ? value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : action === "name" || action === "ip"
          ? value
          : action === "keyExpiryOff"
            ? true
            : action === "keyExpiryOn"
              ? false
              : null;
    try {
      setPlan(await devicesApi.preview(tailnet, selected, action.startsWith("keyExpiry") ? "keyExpiry" : action, v));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo(id: string) {
    setBusy(true);
    setError("");
    try {
      await devicesApi.undo(tailnet, id);
      setUndoId(null);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">{t.TAB_PEERS}</h2>
        <span className="awc-stat">
          {text.ALL} <b>{devices.data?.length ?? 0}</b>
        </span>
        <span className="awc-stat">
          {text.ONLINE} <b>{(devices.data ?? []).filter((d) => peerFor(d, node.peers)?.online).length}</b>
        </span>
        <span className="awc-stat">
          {t.FINDING_DEVICES} <b>{(devices.data ?? []).filter((d) => d.findings?.length).length}</b>
        </span>
        <input
          className="k8s-filter"
          aria-label={text.SEARCH}
          placeholder={text.SEARCH}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="awc-bar-end">
          <button className="btn small" aria-pressed={view === "table"} onClick={() => setView("table")}>
            {text.MAP_TABLE}
          </button>
          <button className="btn small" aria-pressed={view === "map"} onClick={() => setView("map")}>
            {text.MAP}
          </button>
          <button className="btn small" aria-expanded={logOpen} onClick={() => setLogOpen(!logOpen)}>
            {text.CHANGE_LOG}
          </button>
          <button className="btn small" onClick={refresh}>
            {t.REFRESH}
          </button>
        </div>
      </div>
      {devices.isLoading && <div className="awc-filters">{text.DEVICES_LOADING}</div>}
      {devices.error && (
        <p className="err awc-note" role="alert">
          {errorMessage(devices.error)}
        </p>
      )}
      <FilterChips devices={searched} peers={node.peers} filter={filter} setFilter={setFilter} />
      {selected.length > 0 && (
        <BulkActionBar
          selected={selected}
          action={action}
          setAction={setAction}
          value={value}
          setValue={setValue}
          busy={busy}
          preview={() => void preview()}
          clear={() => setSelected([])}
        />
      )}
      {selected.length > 0 && (
        <button className="btn small" onClick={() => setExtras(!extras)}>
          {extraText.OPEN}
        </button>
      )}
      {extras && selected.length > 0 && (
        <DeviceExtras key={selected.join(",")} tailnet={tailnet} ids={selected} close={() => setExtras(false)} />
      )}
      {error && (
        <p className="err awc-note" role="alert">
          {error}
        </p>
      )}
      {view === "table" ? (
        <DeviceTable
          devices={searched.filter((d) => matches(d, filter, node.peers))}
          peers={node.peers}
          selected={selected}
          setSelected={setSelected}
        />
      ) : (
        <DeviceMap
          devices={searched.filter((d) => matches(d, filter, node.peers))}
          peers={node.peers}
          self={node.cli ? node.self : null}
          vpcs={vpcs.data?.items}
          onShowTable={(name) => {
            setQuery(name);
            setFilter("all");
            setView("table");
          }}
        />
      )}
      {plan && (
        <DeviceChange
          tailnet={tailnet}
          preview={plan}
          onClose={() => setPlan(null)}
          onDone={() => {
            setSelected([]);
            refresh();
          }}
        />
      )}
      {logOpen && (
        <ChangeLog
          changes={changes.data}
          error={changes.error}
          busy={busy}
          undoId={undoId}
          setUndoId={setUndoId}
          undo={(id) => void undo(id)}
        />
      )}
    </div>
  );
}
