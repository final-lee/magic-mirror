import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { useModal } from "../iam/useModal";
import { useHistoryKeys } from "../lib/useHistoryKeys";
import { useRouteHistory } from "../lib/useRouteHistory";
import * as t from "./accessText";
import { Messaging } from "./Messaging";
import { refreshSnsAccount, useSnsAccountOverview } from "./queries";
import type { SnsRoute } from "./route";
import { FindingsList } from "./SnsFindings";
import type { SnsTopicRef } from "./targets";
import type { SnsAccountOverview, SnsAccountTopicRow, SnsLevel } from "./types";

interface Props {
  profile: string;
  region: string;
  active?: boolean;
  onOpenTopic: (ref: SnsTopicRef, route?: SnsRoute) => void;
}
type View = "overview" | "checks" | "cleanup" | "messaging";
const views: { id: View; label: string; icon: string }[] = [
  { id: "overview", label: "개요", icon: "📊" }, { id: "checks", label: "점검", icon: "🛡️" },
  { id: "cleanup", label: "정리할 구독", icon: "🧹" }, { id: "messaging", label: "SMS·푸시", icon: "💬" },
];
const sameView = (a: View, b: View) => a === b;
const levels: SnsLevel[] = ["high", "medium", "low", "info"];

export function AccountTab({ profile, region, active = true, onOpenTopic }: Props) {
  const qc = useQueryClient();
  const q = useSnsAccountOverview(profile, region);
  const { settings, update } = useSettings();
  const disabled = settings?.snsChecks?.disabled ?? [];
  const ov = q.data;
  const history = useRouteHistory<View>("overview", sameView);
  const root = useRef<HTMLDivElement>(null);
  useHistoryKeys(root, active, history.back, history.forward);
  const [showChecks, setShowChecks] = useState(false);
  const reread = () => void refreshSnsAccount(qc, profile, region);
  const open = (arn: string, name: string, route?: SnsRoute) => onOpenTopic({ profile, region, topicArn: arn, topicName: name }, route);
  const toggle = (id: string, on: boolean) => update({ snsChecks: { disabled: on ? disabled.filter((d) => d !== id) : [...new Set([...disabled, id])] } });
  const shown = ov ? t.enabledOnly(ov.findings, disabled) : [];
  return <div className="sns-tab" aria-label={t.ACCOUNT_LABEL} ref={root}>
    <div className="sns-top" role="group" aria-label={t.ACCOUNT_LABEL}>
      <b className="sns-ident-name">{t.ACCOUNT_TITLE}</b><span className="dim">{ov ? t.ACCOUNT_HEAD(ov.account, ov.region) : region}</span>
      <span className="sns-top-end"><button className="btn small tone-refresh" onClick={reread} disabled={q.isFetching} title={q.isFetching ? "읽고 있어요" : undefined}>{q.isFetching ? t.READING : t.REREAD}</button></span>
    </div>
    <div className="sns-main">
      {!ov ? (q.isError ? <ErrorState error={q.error} profile={profile} onRetry={reread} /> : <div className="empty">{t.ACCOUNT_LOADING}</div>) : <>
        <nav className="iam-nav sns-nav" aria-label="SNS 계정 메뉴">{views.map((v) => {
          const count = v.id === "checks" ? shown.length : v.id === "cleanup" ? ov.orphans.length + ov.pending.length : 0;
          return <button key={v.id} className={`iam-nav-item${history.route === v.id ? " on" : ""}`} aria-current={history.route === v.id ? "page" : undefined} onClick={() => history.navigate(v.id)}><span className="iam-nav-ico" aria-hidden="true">{v.icon}</span><span className="iam-nav-label">{v.label}</span>{(v.id === "checks" || v.id === "cleanup") && <span className={`iam-nav-n${v.id === "checks" && count > 0 ? " alert" : ""}`}>{count}</span>}</button>;
        })}</nav>
        <div className="iam-body"><div className="iam-bar">
          <button className="icon" aria-label="뒤로" disabled={!history.canBack} onClick={history.back}>‹</button><button className="icon" aria-label="앞으로" disabled={!history.canForward} onClick={history.forward}>›</button>
          <nav className="iam-crumb" aria-label="현재 위치"><b>{views.find((v) => v.id === history.route)?.label}</b></nav>
          {history.route === "checks" && <button className="btn small tone-secondary sns-account-action" onClick={() => setShowChecks(true)}>점검 항목…</button>}
        </div><div className="iam-main"><section className="center sns-pane sns-account-pane" aria-label={views.find((v) => v.id === history.route)?.label}>
          {history.route === "overview" && <Overview ov={ov} shown={shown} onOpen={open} />}
          {history.route === "checks" && <><div className="sec-summary"><div className="sec-cards">{levels.map((level) => <div className={`sec-card sev-${level}`} key={level}><span className="sec-card-n">{shown.filter((f) => f.level === level).length}</span><span className="sec-card-l">{t.LEVEL_LABEL[level]}</span></div>)}</div></div>{disabled.length > 0 && <p className="sns-note dim">점검 항목 {disabled.length}개가 꺼져 있어요</p>}<FindingsList findings={shown} checks={ov.checks} onOpenTopic={(f) => open(f.topicArn, f.topicName, { view: "policy" })} /></>}
          {history.route === "cleanup" && <Cleanup ov={ov} onOpen={open} />}
          {history.route === "messaging" && <Messaging profile={profile} region={region} />}
        </section></div></div>
        {showChecks && <ChecksSheet ov={ov} disabled={disabled} ready={settings !== undefined} onToggle={toggle} onClose={() => setShowChecks(false)} />}
      </>}
    </div>
  </div>;
}

function Card({ title, value, sub }: { title: string; value: ReactNode; sub?: ReactNode }) {
  return <div className="kv-card" role="group" aria-label={title}><h4>{title}</h4><div className="kv-card-value">{value}</div>{sub && <div className="kv-card-sub dim">{sub}</div>}</div>;
}

type SortKey = "name" | "fifo" | "delivered" | "published" | "failed" | "filteredOut" | "subscriptions" | "findings";
function Overview({ ov, shown, onOpen }: { ov: SnsAccountOverview; shown: SnsAccountOverview["findings"]; onOpen: (arn: string, name: string, route?: SnsRoute) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: "failed", ascending: false });
  const perTopic = (arn: string) => shown.filter((f) => f.topicArn === arn).sort(t.byLevel);
  const sum = (key: "published" | "delivered" | "failed" | "filteredOut" | "subscriptions" | "pending") => ov.topics.reduce((n, row) => n + row[key], 0);
  const metric = (n: number) => ov.metricsAvailable ? t.count(n) : "–";
  const value = (row: SnsAccountTopicRow, key: SortKey) => key === "findings" ? perTopic(row.arn).length : row[key];
  const rows = [...ov.topics].sort((a, b) => { const x = value(a, sort.key); const y = value(b, sort.key); return (typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y)) * (sort.ascending ? 1 : -1); });
  const cols: [SortKey, string][] = [["name", "주제"], ["fifo", "종류"], ["delivered", "24시간 배달"], ["published", "발행"], ["failed", "실패"], ["filteredOut", "걸러짐"], ["subscriptions", "구독"], ["findings", "점검"]];
  return <>
    {ov.errors.length > 0 && <p className="sns-note dim" role="status">{t.PARTIAL(ov.errors.length)}: {[...new Set(ov.errors.map(errorMessage))].join(" · ")}</p>}
    {ov.truncated && <p className="sns-note dim">{t.TRUNCATED}</p>}
    <div className="kv-cards">
      <Card title="주제" value={t.count(ov.topics.length)} sub={`FIFO ${t.count(ov.topics.filter((r) => r.fifo).length)}`} />
      <Card title="지난 24시간 발행" value={metric(sum("published"))} /><Card title="배달" value={metric(sum("delivered"))} />
      <Card title="실패" value={<span className={sum("failed") > 0 && ov.metricsAvailable ? "sns-error" : undefined}>{metric(sum("failed"))}</span>} />
      <Card title="걸러짐" value={metric(sum("filteredOut"))} /><Card title="구독" value={t.count(sum("subscriptions"))} sub={`대기 ${t.count(sum("pending"))}`} />
      <Card title="점검 높음" value={t.count(shown.filter((f) => f.level === "high").length)} />
    </div>
    <h4 className="kv-section">{t.SECTION_TOPICS}</h4><p className="sns-note dim">{t.WINDOW_NOTE} 막대와 숫자는 배달 / 실패 / 걸러짐 순서예요.</p>
    {!ov.metricsAvailable && <p className="sns-note sns-error">{t.METRICS_UNAVAILABLE}</p>}
    {rows.length === 0 ? <p className="empty small">{t.TOPICS_EMPTY}</p> : <div className="sns-account-table"><table className="sns-table" aria-label={t.SECTION_TOPICS}><thead><tr>{cols.map(([key, label]) => <th key={key} scope="col" aria-sort={sort.key === key ? (sort.ascending ? "ascending" : "descending") : "none"}><button className="link" onClick={() => setSort({ key, ascending: sort.key === key ? !sort.ascending : true })}>{label}{sort.key === key ? (sort.ascending ? " ▲" : " ▼") : ""}</button></th>)}</tr></thead>
      <tbody>{rows.map((row) => { const found = perTopic(row.arn); const total = row.delivered + row.failed + row.filteredOut; return <tr key={row.arn} className="sns-row" onClick={() => onOpen(row.arn, row.name)}>
        <td><button className="link mono sns-endpoint" onClick={(e) => { e.stopPropagation(); onOpen(row.arn, row.name); }}>{row.name}</button>{row.error && <div className="sns-error sns-note">{errorMessage(row.error)}</div>}</td><td>{row.fifo ? "FIFO" : "표준"}</td>
        <td><div className="sns-delivery">{ov.metricsAvailable && <span className="sns-delivery-bar" aria-hidden="true">{([row.delivered, row.failed, row.filteredOut] as number[]).map((n, i) => <span key={i} className={["delivered", "failed", "filtered"][i]} style={{ width: `${total ? n / total * 100 : 0}%` }} />)}</span>}<span className="mono">{metric(row.delivered)} / {metric(row.failed)} / {metric(row.filteredOut)}</span></div></td>
        <td>{metric(row.published)}</td><td className={ov.metricsAvailable && row.failed > 0 ? "sns-error" : undefined}>{metric(row.failed)}</td><td>{metric(row.filteredOut)}</td><td>{row.error ? "–" : t.count(row.subscriptions)}</td>
        <td>{found.length ? <button className="link" onClick={(e) => { e.stopPropagation(); onOpen(row.arn, row.name, { view: "policy" }); }}><span className={`sns-level ${found[0].level}`}>{t.LEVEL_LABEL[found[0].level]}</span> {found.length}</button> : <span className="dim">0</span>}</td>
      </tr>; })}</tbody></table></div>}
    <p className="sns-note dim">{ov.metrics.length ? ov.metrics.map((m) => `${m.name}: ${t.count(m.value)} (${m.stat})`).join(" · ") : t.ACCOUNT_METRICS_EMPTY}</p>
  </>;
}

function Cleanup({ ov, onOpen }: { ov: SnsAccountOverview; onOpen: (arn: string, name: string) => void }) {
  const names = new Map(ov.topics.map((r) => [r.arn, r.name]));
  const topic = (arn: string, name: string) => names.has(arn) ? <button className="link mono" onClick={() => onOpen(arn, name)}>{name}</button> : <span className="mono">{name}</span>;
  return <>{([true, false] as const).map((orphan) => <section className="sns-section" key={String(orphan)} aria-label={orphan ? t.SECTION_ORPHANS : t.SECTION_PENDING}>
    <h4 className="sns-heading">{orphan ? t.SECTION_ORPHANS : t.SECTION_PENDING}</h4><p className="sns-note dim">{orphan ? t.ORPHANS_NOTE : t.PENDING_NOTE}</p>
    {(orphan ? ov.orphans : ov.pending).length === 0 ? <p className="empty small">{orphan ? t.ORPHANS_EMPTY : t.PENDING_EMPTY}</p> : <table className="sns-table" aria-label={orphan ? t.SECTION_ORPHANS : t.SECTION_PENDING}><thead><tr>{["주제", "프로토콜", "엔드포인트", ...(orphan ? ["이유"] : [])].map((c) => <th className="nosort" scope="col" key={c}>{c}</th>)}</tr></thead><tbody>
      {orphan ? ov.orphans.map((o, i) => <tr key={`${o.topicArn}-${o.endpoint}-${i}`}><td>{topic(o.topicArn, names.get(o.topicArn) ?? o.topicArn.split(":").pop() ?? o.topicArn)}</td><td>{o.protocol}</td><td className="mono">{o.endpoint}</td><td>{t.ORPHAN_REASON[o.reason]}</td></tr>) : ov.pending.map((p, i) => <tr key={`${p.topicArn}-${p.endpoint}-${i}`}><td>{topic(p.topicArn, p.topicName)}</td><td>{p.protocol}</td><td className="mono">{p.endpoint}</td></tr>)}
    </tbody></table>}</section>)}</>;
}

function ChecksSheet({ ov, disabled, ready, onToggle, onClose }: { ov: SnsAccountOverview; disabled: string[]; ready: boolean; onToggle: (id: string, on: boolean) => void; onClose: () => void }) {
  const { sheetRef, trapTab } = useModal(onClose);
  return <div className="modal"><div className="sheet wide" role="dialog" aria-modal="true" aria-label="점검 항목" ref={sheetRef} onKeyDown={trapTab}><h3>점검 항목</h3><p className="sns-note dim">{t.CHECKS_NOTE}</p><section className="sec-checks" aria-label="점검 항목"><div className="sec-checks-col">{ov.checks.map((c) => { const on = !disabled.includes(c.id); return <label key={c.id} className={`sec-check${on ? "" : " off"}`}><input type="checkbox" checked={on} disabled={!ready} aria-label={t.CHECK_TOGGLE(c.title)} onChange={(e) => onToggle(c.id, e.target.checked)} /><span className="sec-check-title">{c.title}</span><span className={`sns-level ${c.level}`}>{t.LEVEL_LABEL[c.level]}</span><span className="k8s-chip">{t.CHECK_COUNT(ov.findings.filter((f) => f.check === c.id).length)}</span></label>; })}</div></section><div className="foot"><button className="btn plain tone-ghost" onClick={onClose}>닫기</button></div></div></div>;
}
