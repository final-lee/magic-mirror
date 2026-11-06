import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import { tailscaleApi } from "./api";
import { ApiRequired } from "./ApiRequired";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./dnsText";
import type { Tone } from "./tone";

type Config = Record<string, unknown>;
type Resolver = { address?: string; useWithExitNode?: boolean; [key: string]: unknown };
type Split = Record<string, Resolver[] | null>;
type Snapshot = { config: Config; split: boolean };
type Candidate = Snapshot & { tone: Tone };

function splitPatch(before: Config, after: Config): Record<string, string[] | null> {
  const old = (before.splitDNS ?? {}) as Split;
  const next = (after.splitDNS ?? {}) as Split;
  const patch: Record<string, string[] | null> = {};
  for (const domain of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (JSON.stringify(old[domain]) === JSON.stringify(next[domain])) continue;
    patch[domain] = next[domain]?.map((resolver) => resolver.address ?? "") ?? null;
  }
  return patch;
}
const format = (value: unknown) => JSON.stringify(value, null, 2) ?? "";

export function DnsView() {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.LOADING}</div>;
  if (!tailnet || !connected) return <ApiRequired title={t.TITLE} />;
  return <DnsPanel tailnet={tailnet} />;
}

function DnsPanel({ tailnet }: { tailnet: string }) {
  const query = useQuery({
    queryKey: ["tailscale", "dns", tailnet],
    queryFn: () => tailscaleApi.dns(tailnet),
    retry: false,
  });
  const [previous, setPrevious] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (query.isError) return (
    <div className="awc-body">
      <div className="err" role="alert">{errorMessage(query.error)}</div>
      <button className="btn small tone-refresh" onClick={() => void query.refetch()}>{t.RELOAD}</button>
    </div>
  );
  if (!query.data) return <div className="empty">{t.LOADING}</div>;
  return (
    <DnsEditor
      key={query.dataUpdatedAt}
      tailnet={tailnet}
      config={query.data}
      previous={previous}
      notice={notice}
      reload={() => void query.refetch()}
      saved={(before, warning, split) => {
        setPrevious({ config: before, split });
        setNotice(warning || t.SAVED);
        void query.refetch();
      }}
    />
  );
}

function DnsEditor({ tailnet, config, previous, notice, reload, saved }: {
  tailnet: string;
  config: Config;
  previous: Snapshot | null;
  notice: string | null;
  reload: () => void;
  saved: (before: Config, warning: string | null, split: boolean) => void;
}) {
  const [nameservers, setNameservers] = useState<Resolver[]>(Array.isArray(config.nameservers) ? config.nameservers : []);
  const [search, setSearch] = useState(Array.isArray(config.searchPaths) ? config.searchPaths.join("\n") : "");
  const [searchInput, setSearchInput] = useState("");
  const initialSplit = config.splitDNS && typeof config.splitDNS === "object" && !Array.isArray(config.splitDNS)
    ? config.splitDNS as Record<string, Resolver[] | null> : {};
  const [split, setSplit] = useState(initialSplit);
  const [domain, setDomain] = useState("");
  const [servers, setServers] = useState("");
  const initialPrefs = config.preferences && typeof config.preferences === "object" && !Array.isArray(config.preferences)
    ? config.preferences as Record<string, unknown> : {};
  const magic = initialPrefs.magicDNS === true;
  const override = initialPrefs.overrideLocalDNS === true;
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  return (
    <>
      <div className="awc-bar">
        <h2 className="awc-title">{t.TITLE}</h2>
        <div className="awc-bar-end">
          <button className="btn small tone-refresh" onClick={reload}>{t.RELOAD}</button>
        </div>
      </div>
      <div className="awc-body awc-scroll">
        {notice && <div role="status">{notice}</div>}
        <section>
          <h3>{t.GLOBAL}</h3>
          <p className="dim">{t.GLOBAL_DESCRIPTION}</p>
          {nameservers.length === 0 && <p className="dim">{t.NO_NAMESERVERS}</p>}
          <table className="argowf-table">
            <thead><tr><th>{t.ADDRESS_HEADER}</th><th>{t.EXIT_NODE}</th><th>{t.ACTIONS}</th></tr></thead>
            <tbody>{nameservers.map((server, index) => (
              <tr key={index}>
                <td><input aria-label={t.ADDRESS} value={server.address ?? ""} onChange={(e) => {
                  setNameservers(nameservers.map((item, i) => i === index ? { ...item, address: e.target.value } : item));
                }} /></td>
                <td><input aria-label={t.EXIT_NODE} type="checkbox" checked={server.useWithExitNode === true} onChange={(e) => {
                  setNameservers(nameservers.map((item, i) => i === index ? { ...item, useWithExitNode: e.target.checked } : item));
                }} /></td>
                <td><button className="btn small tone-secondary" onClick={() => setNameservers(nameservers.filter((_, i) => i !== index))}>{t.REMOVE}</button></td>
              </tr>
            ))}</tbody>
          </table>
          <div className="awc-editor-opts">
            <button className="btn small tone-secondary" onClick={() => setNameservers([...nameservers, { address: "" }])}>{t.ADD}</button>
            <button
              className="btn small tone-primary"
              style={{ marginLeft: "auto" }}
              onClick={() => setCandidate({ config: { ...config, nameservers }, split: false, tone: "primary" })}
            >
              {t.PREVIEW_OPEN}
            </button>
          </div>
        </section>
        <section>
          <h3>{t.SEARCH}</h3>
          <p className="dim">{t.SEARCH_DESCRIPTION}</p>
          {!search && <p className="dim">{t.NO_SEARCH_DOMAINS}</p>}
          {search && <table className="argowf-table">
            <thead><tr><th>{t.DOMAIN}</th><th>{t.ACTIONS}</th></tr></thead>
            <tbody>{search.split("\n").filter(Boolean).map((path, index) => (
              <tr key={`${path}-${index}`}><td>{path}</td><td>
                <button className="btn small tone-secondary" onClick={() => setSearch(search.split("\n").filter((_, i) => i !== index).join("\n"))}>{t.REMOVE}</button>
              </td></tr>
            ))}</tbody>
          </table>}
          <div className="awc-editor-opts">
            <label>{t.DOMAIN}<input aria-label={t.SEARCH_INPUT} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} /></label>
            <button className="btn small tone-secondary" disabled={!searchInput.trim()} onClick={() => {
              setSearch([search, searchInput.trim()].filter(Boolean).join("\n"));
              setSearchInput("");
            }}>{t.ADD}</button>
            <button className="btn small tone-primary" style={{ marginLeft: "auto" }} onClick={() => setCandidate({
              config: { ...config, searchPaths: search.split("\n").map((path) => path.trim()).filter(Boolean) }, split: false, tone: "primary",
            })}>{t.PREVIEW_OPEN}</button>
          </div>
        </section>
        <section>
          <h3>{t.SPLIT}</h3>
          <p className="dim">{t.SPLIT_DESCRIPTION}</p>
          {Object.keys(split).length === 0 && <p className="dim">{t.NO_SPLIT_DOMAINS}</p>}
          <table className="argowf-table">
            <thead><tr><th>{t.DOMAIN}</th><th>{t.GLOBAL}</th><th>{t.EXIT_NODE}</th><th>{t.ACTIONS}</th></tr></thead>
            <tbody>{Object.entries(split).flatMap(([name, resolvers]) => {
              const items = resolvers?.length ? resolvers : [null];
              return items.map((resolver, index) => (
                <tr key={`${name}-${index}`}>
                  <td>{name}</td>
                  <td>{resolver && <input aria-label={t.ADDRESS} value={resolver.address ?? ""} onChange={(e) => setSplit({
                    ...split, [name]: (resolvers ?? []).map((item, i) => i === index ? { ...item, address: e.target.value } : item),
                  })} />}</td>
                  <td>{resolver && <input aria-label={t.EXIT_NODE} type="checkbox" checked={resolver.useWithExitNode === true} onChange={(e) => setSplit({
                    ...split, [name]: (resolvers ?? []).map((item, i) => i === index ? { ...item, useWithExitNode: e.target.checked } : item),
                  })} />}</td>
                  <td>
                    {resolver && <button className="btn small tone-secondary" onClick={() => setSplit({
                      ...split, [name]: (resolvers ?? []).filter((_, i) => i !== index),
                    })}>{t.REMOVE}</button>}{" "}
                    <button className="btn small tone-secondary" onClick={() => setSplit({
                      ...split, [name]: [...(resolvers ?? []), { address: "" }],
                    })}>{t.ADD}</button>{" "}
                    <button className="btn small tone-secondary" onClick={() => {
                      const next = { ...split };
                      delete next[name];
                      setSplit(next);
                    }}>{t.DELETE_DOMAIN}</button>
                  </td>
                </tr>
              ));
            })}</tbody>
          </table>
          <div className="awc-editor-opts">
            <label>{t.DOMAIN}<input aria-label={t.DOMAIN} value={domain} onChange={(e) => setDomain(e.target.value)} /></label>
            <label>{t.SERVERS}<input aria-label={t.SERVERS} value={servers} onChange={(e) => setServers(e.target.value)} /></label>
            <button className="btn small tone-secondary" disabled={!domain.trim()} onClick={() => {
              setSplit({ ...split, [domain.trim()]: servers.split(",").map((address) => address.trim()).filter(Boolean).map((address) => ({ address })) });
              setDomain("");
              setServers("");
            }}>{t.ADD}</button>
            <button
              className="btn small tone-primary"
              style={{ marginLeft: "auto" }}
              onClick={() => setCandidate({ config: { ...config, splitDNS: split }, split: true, tone: "primary" })}
            >
              {t.PREVIEW_OPEN}
            </button>
          </div>
        </section>
        <section>
          <h3>{t.MAGIC}</h3>
          <p className="dim">{t.MAGIC_DESCRIPTION}</p>
          {[{ key: "magicDNS", label: t.MAGIC, value: magic }, { key: "overrideLocalDNS", label: t.OVERRIDE, value: override }].map((item) => (
            <div className="awc-editor-opts" key={item.key} title={item.key}>
              <span>{item.label}: {item.value ? t.ON : t.OFF}</span>
              <button className="btn small tone-warn" onClick={() => setCandidate({
                config: { ...config, preferences: { ...initialPrefs, magicDNS: magic, overrideLocalDNS: override, [item.key]: !item.value } }, split: false, tone: "warn",
              })}>{item.value ? t.TURN_OFF : t.TURN_ON}</button>
            </div>
          ))}
        </section>
        <details><summary>{t.RAW}</summary><pre>{format(config)}</pre></details>
        {previous && <button className="btn small tone-caution" onClick={() => setCandidate({ ...previous, tone: "caution" })}>{t.UNDO}</button>}
      </div>
      {candidate && (
        <DnsDialog tailnet={tailnet} before={config} after={candidate.config} split={candidate.split} tone={candidate.tone}
          cancel={() => setCandidate(null)} saved={saved} />
      )}
    </>
  );
}

function DnsDialog({ tailnet, before, after, split, tone, cancel, saved }: {
  tailnet: string; before: Config; after: Config; split: boolean; tone: Tone; cancel: () => void;
  saved: (before: Config, warning: string | null, split: boolean) => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sheetRef, trapTab } = useModal(() => { if (!sending) cancel(); });
  const patch = split ? splitPatch(before, after) : null;
  const apply = async () => {
    setSending(true);
    try {
      const warning = split
        ? await tailscaleApi.dnsSplitSave(tailnet, before, after, patch)
        : await tailscaleApi.dnsSave(tailnet, before, after);
      saved(before, warning, split);
    } catch (e) {
      setError(errorMessage(e));
      setSending(false);
    }
  };
  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !sending) cancel(); }}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-label={t.PREVIEW} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{t.PREVIEW}</h3>
        {split && (
          <>
            <p>{t.SPLIT_CALLS}</p>
            <p><code>PATCH /tailnet/-/dns/split-dns</code> · dns</p>
            <pre>{format(patch)}</pre>
          </>
        )}
        <p><code>POST /tailnet/-/dns/configuration</code> · dns</p>
        <h4>{t.BEFORE}</h4><pre>{format(before)}</pre>
        <h4>{t.AFTER}</h4><pre>{format(after)}</pre>
        {error && <div className="err" role="alert">{error}</div>}
        <div className="foot">
          <button className="btn small tone-ghost" disabled={sending} onClick={cancel}>{t.CANCEL}</button>
          <button className={`btn small tone-${tone}`} disabled={sending} onClick={() => void apply()}>{t.SAVE}</button>
        </div>
      </div>
    </div>
  );
}
