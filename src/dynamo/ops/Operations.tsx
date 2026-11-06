import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import type { DetailContext } from "../TableDetail";
import { dynamoApi } from "../api";
import { changeApi } from "../change/api";
import { useDynamoChange } from "../change/ChangeFlow";
import { analyze } from "../design/design";
import { tableStoreKey, useItems } from "../items/store";
import { opsApi } from "./api";
import * as t from "./text";

export function Operations({ profile, region, table, active }: DetailContext) {
  const target = { profile, region, table: table.name };
  const flow = useDynamoChange(target);
  const [attribute, setAttribute] = useState(table.ttl?.attribute ?? "");
  const items = useItems(tableStoreKey(profile, region, table.name)).items;
  const [days, setDays] = useState(table.pitr?.days ?? 35);
  const [viewType, setViewType] = useState(table.stream?.viewType ?? "NEW_AND_OLD_IMAGES");
  const [tableClass, setTableClass] = useState(table.class);
  const [mode, setMode] = useState(table.billing.mode);
  const [read, setRead] = useState(table.billing.read ?? 5);
  const [write, setWrite] = useState(table.billing.write ?? 5);
  const [indexes, setIndexes] = useState(() => table.indexes.filter(i => i.kind === "gsi").map(i => ({ name:i.name, read:i.read ?? 5, write:i.write ?? 5 })));
  const [backupName, setBackupName] = useState("");
  const [restoreTarget, setRestoreTarget] = useState("");
  const [restoreTime, setRestoreTime] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [format, setFormat] = useState("DYNAMODB_JSON");
  const [exportTime, setExportTime] = useState("");
  const backups = useQuery({ queryKey:["dynamo", profile, region, table.name, "backups"], queryFn:() => opsApi.backups(target), refetchInterval:q => active && q.state.data?.some(b => b.status === "CREATING") ? 10000 : false });
  const exports = useQuery({ queryKey:["dynamo", profile, region, table.name, "exports"], queryFn:() => opsApi.exports(target, table.arn), refetchInterval:q => active && q.state.data?.some(e => e.status === "IN_PROGRESS") ? 10000 : false });
  const buckets = useQuery({ queryKey:["dynamo", profile, region, "buckets"], queryFn:() => opsApi.buckets(target) });
  const changes = useQuery({ queryKey:["dynamo", profile, region, table.name, "changes"], queryFn:() => changeApi.changes(target) });
  const busy = flow.loading;
  return <section className="ddb-ops">
    <h3>{t.SETTINGS}</h3>{flow.error && <p className="err">{flow.error}</p>}
    <div className="ddb-ops-row"><strong>{t.TTL}</strong><span>{table.ttl?.status ?? "?"}</span><label>{t.ATTR}<input value={attribute} onChange={e => setAttribute(e.target.value)} /></label><button className="btn small tone-warn" disabled={busy || !table.ttl || !attribute} onClick={() => { const warnings = analyze({ ...table, ttl:{ status:"ENABLED", attribute } }, items).diagnostics.filter(d => d.id === "ttlMillis" || d.id === "ttlNotNumber").map(d => `${d.count}개: ${d.detail}`); void flow.begin({ kind:"ttl", enabled:table.ttl?.status !== "ENABLED", attribute }, warnings); }}>{table.ttl?.status === "ENABLED" ? t.DISABLE : t.ENABLE}</button></div>
    <div className="ddb-ops-row"><strong>{t.PITR}</strong><span>{table.pitr?.status ?? "?"}</span><label>{t.DAYS}<input type="number" min={1} max={35} value={days} onChange={e => setDays(Number(e.target.value))} /></label><button className="btn small tone-warn" disabled={busy || !table.pitr} onClick={() => void flow.begin({ kind:"pitr", enabled:table.pitr?.status !== "ENABLED", days })}>{table.pitr?.status === "ENABLED" ? t.DISABLE : t.ENABLE}</button><button className="btn small tone-warn" disabled={busy || table.pitr?.status !== "ENABLED"} onClick={() => void flow.begin({ kind:"pitr", enabled:true, days })}>{t.CHANGE}</button></div>
    <div className="ddb-ops-row"><strong>{t.PROTECTION}</strong><span>{table.deletionProtection ? "켜짐" : "꺼짐"}</span><button className="btn small tone-warn" disabled={busy} onClick={() => void flow.begin({ kind:"deletionProtection", enabled:!table.deletionProtection })}>{table.deletionProtection ? t.DISABLE : t.ENABLE}</button></div>
    <div className="ddb-ops-row"><strong>{t.STREAM}</strong><span>{table.stream?.viewType ?? "꺼짐"}</span><select aria-label={t.STREAM} value={viewType} onChange={e => setViewType(e.target.value)}>{["KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"].map(v => <option key={v}>{v}</option>)}</select><button className="btn small tone-warn" disabled={busy} onClick={() => void flow.begin({ kind:"stream", enabled:!table.stream, viewType:table.stream ? null : viewType })}>{table.stream ? t.DISABLE : t.ENABLE}</button></div>
    <div className="ddb-ops-row"><strong>{t.CLASS}</strong><select aria-label={t.CLASS} value={tableClass} onChange={e => setTableClass(e.target.value)}><option>STANDARD</option><option>STANDARD_INFREQUENT_ACCESS</option></select><button className="btn small tone-warn" disabled={busy || table.class === tableClass} onClick={() => void flow.begin({ kind:"tableClass", class:tableClass })}>{t.CHANGE}</button></div>
    <div className="ddb-ops-row"><strong>{t.BILLING}</strong><select aria-label={t.BILLING} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="onDemand">{t.ON_DEMAND}</option><option value="provisioned">{t.PROVISIONED}</option></select>{mode === "provisioned" && <><label>{t.RCU}<input type="number" min={1} value={read} onChange={e => setRead(Number(e.target.value))} /></label><label>{t.WCU}<input type="number" min={1} value={write} onChange={e => setWrite(Number(e.target.value))} /></label>{indexes.map((index, n) => <span key={index.name}>{index.name} <label>RCU <input type="number" min={1} value={index.read} onChange={e => setIndexes(xs => xs.map((x, i) => i === n ? { ...x, read:Number(e.target.value) } : x))} /></label> <label>WCU <input type="number" min={1} value={index.write} onChange={e => setIndexes(xs => xs.map((x, i) => i === n ? { ...x, write:Number(e.target.value) } : x))} /></label></span>)}</>}<button className="btn small tone-warn" disabled={busy} onClick={() => void flow.begin({ kind:"billing", mode, read:mode === "provisioned" ? read : null, write:mode === "provisioned" ? write : null, indexes:mode === "provisioned" ? indexes : [] })}>{t.CHANGE}</button></div>
    <div className="ddb-ops-row"><strong>{t.INSIGHTS}</strong><span>{table.contributorInsights ?? "?"}</span><button className="btn small tone-warn" disabled={busy || !table.contributorInsights} onClick={() => void flow.begin({ kind:"contributorInsights", enabled:table.contributorInsights !== "ENABLED" })}>{table.contributorInsights === "ENABLED" ? t.DISABLE : t.ENABLE}</button></div>
    <h3>{t.BACKUPS}</h3><div className="ddb-ops-row"><label>{t.BACKUP_NAME}<input value={backupName} onChange={e => setBackupName(e.target.value)} /></label><button className="btn small tone-create" disabled={busy || !backupName} onClick={() => void flow.begin({ kind:"createBackup", name:backupName })}>{t.CREATE_BACKUP}</button><button className="btn small tone-refresh" onClick={() => void backups.refetch()}>{t.READ_AGAIN}</button></div>
    {backups.isError && <p className="err">{errorMessage(backups.error)}</p>}{backups.data?.length === 0 && <p className="dim">{t.NO_BACKUPS}</p>}
    {backups.data?.map(b => <div className="ddb-ops-row" key={b.arn}><strong>{b.name}</strong><span>{b.status} {b.createdAt}</span><label>{t.TARGET}<input value={restoreTarget} onChange={e => setRestoreTarget(e.target.value)} /></label><button className="btn small tone-primary" disabled={busy || !restoreTarget || b.status !== "AVAILABLE"} onClick={() => void flow.begin({ kind:"restoreBackup", arn:b.arn, target:restoreTarget })}>{t.RESTORE}</button><button className="btn small tone-danger" disabled={busy} onClick={() => void flow.begin({ kind:"deleteBackup", arn:b.arn })}>{t.DELETE}</button></div>)}
    <h3>{t.RESTORE_PITR}</h3><div className="ddb-ops-row"><label>{t.TARGET}<input value={restoreTarget} onChange={e => setRestoreTarget(e.target.value)} /></label><label>{t.TIME}<input value={restoreTime} onChange={e => setRestoreTime(e.target.value)} /></label><button className="btn small tone-primary" disabled={busy || !restoreTarget} onClick={() => void flow.begin({ kind:"restorePitr", target:restoreTarget, time:restoreTime || null })}>{t.RESTORE}</button></div>
    {changes.data?.filter(row => row.ok && row.restoredTable).map(row => <RestoreStatus key={row.id} profile={profile} region={region} name={row.restoredTable!} active={active} />)}
    <h3>{t.EXPORT}</h3><div className="ddb-ops-row"><label>{t.BUCKET}<select value={bucket} onChange={e => setBucket(e.target.value)}><option value="">—</option>{buckets.data?.map(b => <option key={b}>{b}</option>)}</select></label><label>{t.PREFIX}<input value={prefix} onChange={e => setPrefix(e.target.value)} /></label><select aria-label="형식" value={format} onChange={e => setFormat(e.target.value)}><option>DYNAMODB_JSON</option><option>ION</option></select><label>{t.TIME}<input value={exportTime} onChange={e => setExportTime(e.target.value)} /></label><button className="btn small tone-primary" disabled={busy || !bucket} onClick={() => void flow.begin({ kind:"exportS3", bucket, prefix, format, time:exportTime || null })}>{t.EXPORT}…</button></div>
    {buckets.isError && <p className="err">{errorMessage(buckets.error)}</p>}
    <h3>{t.EXPORTS}</h3>{exports.isError && <p className="err">{errorMessage(exports.error)}</p>}{exports.data?.length === 0 && <p className="dim">{t.EMPTY_EXPORTS}</p>}{exports.data?.map(e => <div className="ddb-ops-row" key={e.arn}><span>{e.status} {e.createdAt} {e.size != null && `${e.size} B`}</span><code>s3://{e.bucket}/{e.prefix}</code>{e.error && <span className="err">{e.error}</span>}</div>)}
    {flow.dialog}
  </section>;
}

function RestoreStatus({ profile, region, name, active }: { profile:string; region:string; name:string; active:boolean }) {
  const q = useQuery({ queryKey:["dynamo", profile, region, "restore", name], queryFn:() => dynamoApi.table(profile, region, name), enabled:active, retry:false, refetchInterval:q => active && q.state.data && q.state.data.status !== "ACTIVE" ? 10000 : false });
  return <div className="ddb-ops-row"><strong>{name}</strong><span>{q.data?.status ?? (q.isError ? errorMessage(q.error) : t.RESTORE_LOADING)}</span></div>;
}
