import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import type { DetailContext } from "../TableDetail";
import { dynamoApi } from "../api";
import { changeApi } from "../change/api";
import { useDynamoChange, type DynamoChangeFlow } from "../change/ChangeFlow";
import { analyze } from "../design/design";
import { tableStoreKey, useItems } from "../items/store";
import { opsApi } from "./api";
import * as t from "./text";

type SectionProps = DetailContext & { flow: DynamoChangeFlow };

export function Operations(props: DetailContext) {
  const { profile, region, table } = props;
  const flow = useDynamoChange({ profile, region, table: table.name });
  const [restoreTarget, setRestoreTarget] = useState("");

  return <section className="ddb-ops">
    <h3>{t.SETTINGS}</h3>
    {flow.error && <p className="err">{flow.error}</p>}
    <Settings {...props} flow={flow} />
    <Backups {...props} flow={flow} restoreTarget={restoreTarget} setRestoreTarget={setRestoreTarget} />
    <Restore {...props} flow={flow} restoreTarget={restoreTarget} setRestoreTarget={setRestoreTarget} />
    <Exports {...props} flow={flow} />
    {flow.dialog}
  </section>;
}

function Settings({ profile, region, table, flow }: SectionProps) {
  const [attribute, setAttribute] = useState(table.ttl?.attribute ?? "");
  const [days, setDays] = useState(table.pitr?.days ?? 35);
  const [viewType, setViewType] = useState(table.stream?.viewType ?? "NEW_AND_OLD_IMAGES");
  const [tableClass, setTableClass] = useState(table.class);
  const [mode, setMode] = useState(table.billing.mode);
  const [read, setRead] = useState(table.billing.read ?? 5);
  const [write, setWrite] = useState(table.billing.write ?? 5);
  const [indexes, setIndexes] = useState(() => table.indexes
    .filter(index => index.kind === "gsi")
    .map(index => ({ name: index.name, read: index.read ?? 5, write: index.write ?? 5 })));
  const items = useItems(tableStoreKey(profile, region, table.name)).items;
  const busy = flow.loading;

  function changeTtl() {
    const warnings = analyze({ ...table, ttl: { status: "ENABLED", attribute } }, items)
      .diagnostics.filter(item => item.id === "ttlMillis" || item.id === "ttlNotNumber")
      .map(item => `${item.count}개: ${item.detail}`);
    void flow.begin({ kind: "ttl", enabled: table.ttl?.status !== "ENABLED", attribute }, warnings);
  }

  return <>
    <div className="ddb-ops-row">
      <strong>{t.TTL}</strong><span>{table.ttl?.status ?? "?"}</span>
      <label>{t.ATTR}<input value={attribute} onChange={event => setAttribute(event.target.value)} /></label>
      <button className="btn small tone-warn" disabled={busy || !table.ttl || !attribute} onClick={changeTtl}>{table.ttl?.status === "ENABLED" ? t.DISABLE : t.ENABLE}</button>
    </div>
    <div className="ddb-ops-row">
      <strong>{t.PITR}</strong><span>{table.pitr?.status ?? "?"}</span>
      <label>{t.DAYS}<input type="number" min={1} max={35} value={days} onChange={event => setDays(Number(event.target.value))} /></label>
      <button className="btn small tone-warn" disabled={busy || !table.pitr} onClick={() => void flow.begin({ kind: "pitr", enabled: table.pitr?.status !== "ENABLED", days })}>{table.pitr?.status === "ENABLED" ? t.DISABLE : t.ENABLE}</button>
      <button className="btn small tone-warn" disabled={busy || table.pitr?.status !== "ENABLED"} onClick={() => void flow.begin({ kind: "pitr", enabled: true, days })}>{t.CHANGE}</button>
    </div>
    <div className="ddb-ops-row">
      <strong>{t.PROTECTION}</strong><span>{table.deletionProtection ? "켜짐" : "꺼짐"}</span>
      <button className="btn small tone-warn" disabled={busy} onClick={() => void flow.begin({ kind: "deletionProtection", enabled: !table.deletionProtection })}>{table.deletionProtection ? t.DISABLE : t.ENABLE}</button>
    </div>
    <div className="ddb-ops-row">
      <strong>{t.STREAM}</strong><span>{table.stream?.viewType ?? "꺼짐"}</span>
      <select aria-label={t.STREAM} value={viewType} onChange={event => setViewType(event.target.value)}>
        {["KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"].map(view => <option key={view}>{view}</option>)}
      </select>
      <button className="btn small tone-warn" disabled={busy} onClick={() => void flow.begin({ kind: "stream", enabled: !table.stream, viewType: table.stream ? null : viewType })}>{table.stream ? t.DISABLE : t.ENABLE}</button>
    </div>
    <div className="ddb-ops-row">
      <strong>{t.CLASS}</strong>
      <select aria-label={t.CLASS} value={tableClass} onChange={event => setTableClass(event.target.value)}><option>STANDARD</option><option>STANDARD_INFREQUENT_ACCESS</option></select>
      <button className="btn small tone-warn" disabled={busy || table.class === tableClass} onClick={() => void flow.begin({ kind: "tableClass", class: tableClass })}>{t.CHANGE}</button>
    </div>
    <div className="ddb-ops-row">
      <strong>{t.BILLING}</strong>
      <select aria-label={t.BILLING} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="onDemand">{t.ON_DEMAND}</option><option value="provisioned">{t.PROVISIONED}</option></select>
      {mode === "provisioned" && <>
        <label>{t.RCU}<input type="number" min={1} value={read} onChange={event => setRead(Number(event.target.value))} /></label>
        <label>{t.WCU}<input type="number" min={1} value={write} onChange={event => setWrite(Number(event.target.value))} /></label>
        {indexes.map((index, position) => <span key={index.name}>{index.name}
          <label>RCU <input type="number" min={1} value={index.read} onChange={event => setIndexes(current => current.map((item, i) => i === position ? { ...item, read: Number(event.target.value) } : item))} /></label>
          <label>WCU <input type="number" min={1} value={index.write} onChange={event => setIndexes(current => current.map((item, i) => i === position ? { ...item, write: Number(event.target.value) } : item))} /></label>
        </span>)}
      </>}
      <button className="btn small tone-warn" disabled={busy} onClick={() => void flow.begin({ kind: "billing", mode, read: mode === "provisioned" ? read : null, write: mode === "provisioned" ? write : null, indexes: mode === "provisioned" ? indexes : [] })}>{t.CHANGE}</button>
    </div>
    <div className="ddb-ops-row">
      <strong>{t.INSIGHTS}</strong><span>{table.contributorInsights ?? "?"}</span>
      <button className="btn small tone-warn" disabled={busy || !table.contributorInsights} onClick={() => void flow.begin({ kind: "contributorInsights", enabled: table.contributorInsights !== "ENABLED" })}>{table.contributorInsights === "ENABLED" ? t.DISABLE : t.ENABLE}</button>
    </div>
  </>;
}

type RestoreTargetProps = { restoreTarget: string; setRestoreTarget: (value: string) => void };

function Backups({ profile, region, table, active, flow, restoreTarget, setRestoreTarget }: SectionProps & RestoreTargetProps) {
  const [backupName, setBackupName] = useState("");
  const target = { profile, region, table: table.name };
  const backups = useQuery({
    queryKey: ["dynamo", profile, region, table.name, "backups"],
    queryFn: () => opsApi.backups(target),
    refetchInterval: query => active && query.state.data?.some(backup => backup.status === "CREATING") ? 10000 : false,
  });
  return <>
    <h3>{t.BACKUPS}</h3>
    <div className="ddb-ops-row">
      <label>{t.BACKUP_NAME}<input value={backupName} onChange={event => setBackupName(event.target.value)} /></label>
      <button className="btn small tone-create" disabled={flow.loading || !backupName} onClick={() => void flow.begin({ kind: "createBackup", name: backupName })}>{t.CREATE_BACKUP}</button>
      <button className="btn small tone-refresh" onClick={() => void backups.refetch()}>{t.READ_AGAIN}</button>
    </div>
    {backups.isError && <p className="err">{errorMessage(backups.error)}</p>}
    {backups.data?.length === 0 && <p className="dim">{t.NO_BACKUPS}</p>}
    {backups.data?.map(backup => <div className="ddb-ops-row" key={backup.arn}>
      <strong>{backup.name}</strong><span>{backup.status} {backup.createdAt}</span>
      <label>{t.TARGET}<input value={restoreTarget} onChange={event => setRestoreTarget(event.target.value)} /></label>
      <button className="btn small tone-primary" disabled={flow.loading || !restoreTarget || backup.status !== "AVAILABLE"} onClick={() => void flow.begin({ kind: "restoreBackup", arn: backup.arn, target: restoreTarget })}>{t.RESTORE}</button>
      <button className="btn small tone-danger" disabled={flow.loading} onClick={() => void flow.begin({ kind: "deleteBackup", arn: backup.arn })}>{t.DELETE}</button>
    </div>)}
  </>;
}

function Restore({ profile, region, table, active, flow, restoreTarget, setRestoreTarget }: SectionProps & RestoreTargetProps) {
  const [restoreTime, setRestoreTime] = useState("");
  const target = { profile, region, table: table.name };
  const changes = useQuery({ queryKey: ["dynamo", profile, region, table.name, "changes"], queryFn: () => changeApi.changes(target) });
  return <>
    <h3>{t.RESTORE_PITR}</h3>
    <div className="ddb-ops-row">
      <label>{t.TARGET}<input value={restoreTarget} onChange={event => setRestoreTarget(event.target.value)} /></label>
      <label>{t.TIME}<input value={restoreTime} onChange={event => setRestoreTime(event.target.value)} /></label>
      <button className="btn small tone-primary" disabled={flow.loading || !restoreTarget} onClick={() => void flow.begin({ kind: "restorePitr", target: restoreTarget, time: restoreTime || null })}>{t.RESTORE}</button>
    </div>
    {changes.data?.filter(row => row.ok && row.restoredTable).map(row => <RestoreStatus key={row.id} profile={profile} region={region} name={row.restoredTable!} active={active} />)}
  </>;
}

function Exports({ profile, region, table, active, flow }: SectionProps) {
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [format, setFormat] = useState("DYNAMODB_JSON");
  const [exportTime, setExportTime] = useState("");
  const target = { profile, region, table: table.name };
  const exports = useQuery({
    queryKey: ["dynamo", profile, region, table.name, "exports"],
    queryFn: () => opsApi.exports(target, table.arn),
    refetchInterval: query => active && query.state.data?.some(item => item.status === "IN_PROGRESS") ? 10000 : false,
  });
  const buckets = useQuery({ queryKey: ["dynamo", profile, region, "buckets"], queryFn: () => opsApi.buckets(target) });
  return <>
    <h3>{t.EXPORT}</h3>
    <div className="ddb-ops-row">
      <label>{t.BUCKET}<select value={bucket} onChange={event => setBucket(event.target.value)}><option value="">—</option>{buckets.data?.map(name => <option key={name}>{name}</option>)}</select></label>
      <label>{t.PREFIX}<input value={prefix} onChange={event => setPrefix(event.target.value)} /></label>
      <select aria-label="형식" value={format} onChange={event => setFormat(event.target.value)}><option>DYNAMODB_JSON</option><option>ION</option></select>
      <label>{t.TIME}<input value={exportTime} onChange={event => setExportTime(event.target.value)} /></label>
      <button className="btn small tone-primary" disabled={flow.loading || !bucket} onClick={() => void flow.begin({ kind: "exportS3", bucket, prefix, format, time: exportTime || null })}>{t.EXPORT}…</button>
    </div>
    {buckets.isError && <p className="err">{errorMessage(buckets.error)}</p>}
    <h3>{t.EXPORTS}</h3>
    {exports.isError && <p className="err">{errorMessage(exports.error)}</p>}
    {exports.data?.length === 0 && <p className="dim">{t.EMPTY_EXPORTS}</p>}
    {exports.data?.map(item => <div className="ddb-ops-row" key={item.arn}>
      <span>{item.status} {item.createdAt} {item.size != null && `${item.size} B`}</span>
      <code>s3://{item.bucket}/{item.prefix}</code>{item.error && <span className="err">{item.error}</span>}
    </div>)}
  </>;
}

function RestoreStatus({ profile, region, name, active }: { profile: string; region: string; name: string; active: boolean }) {
  const query = useQuery({
    queryKey: ["dynamo", profile, region, "restore", name],
    queryFn: () => dynamoApi.table(profile, region, name),
    enabled: active,
    retry: false,
    refetchInterval: query => active && query.state.data && query.state.data.status !== "ACTIVE" ? 10000 : false,
  });
  return <div className="ddb-ops-row"><strong>{name}</strong><span>{query.data?.status ?? (query.isError ? errorMessage(query.error) : t.RESTORE_LOADING)}</span></div>;
}
