import type { PgChange, PgCoverage, PgDatabaseView, PgRoleSummary, PgSchemaCell } from "../../src/pg/types";
import { attributes, BADGES, dbAspects, membership, role, sampleBatchPreview, sampleCellDetail, sampleChangeLog, sampleDatabaseView, sampleDropPlan, sampleFindings, sampleOverview, samplePresetSuggestion, samplePreview, sampleSessions, sampleTargetInfo, sampleWhoCan, schemaAspects } from "../../src/pg/fixtures";

const arn = "arn:aws:rds:ap-northeast-2:123456789012:cluster:orders-db";
const target = sampleTargetInfo({ arn, identifier: "orders-db", endpoint: "orders-db.cluster-c9akciq32.ap-northeast-2.rds.amazonaws.com" });
const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const extraNames = ["analytics_reader", "billing_api", "billing_read", "data_pipeline", "etl_service", "grafana", "inventory_api", "migration_bot", "orders_api", "reporting", "support_readonly"];
const base = sampleOverview();
const roles: PgRoleSummary[] = [...base.roles.map((r) => r.name === "bob" ? { ...r, attributes: { ...r.attributes, validUntil: new Date(Date.now() + 8 * 86400_000).toISOString() } } : r), ...extraNames.map((name, i) => role(name, {
  attributes: attributes({ login: !name.endsWith("_read"), connectionLimit: i % 3 === 0 ? 20 : -1 }),
  memberOf: [membership(i % 3 === 0 ? "app_write" : "app_read"), ...(i % 4 === 0 ? [membership("rds_iam")] : [])],
  badges: i % 4 === 0 ? [BADGES.iamAuth] : [], sessionCount: i % 3, comment: `Production ${name.replaceAll("_", " ")} access`,
}))].sort((a, b) => a.name.localeCompare(b.name));
const overview = () => sampleOverview({ target, roles: roles.map((r) => ({ ...r, memberCount: roles.filter((member) => member.memberOf.some((m) => m.group === r.name)).length })), fetchedAt: now() });
const schemas = ["public", "orders", "billing", "analytics"];
function database(name: string): PgDatabaseView {
  const original = sampleDatabaseView();
  const cells: PgSchemaCell[] = roles.flatMap((r, ri) => schemas.map((schema, si) => {
    const owner = r.name === "app_owner";
    const active = owner || (ri + si) % 4 !== 0;
    const read: PgCoverage = !active ? "none" : owner || (ri + si) % 3 === 0 ? "all" : "some";
    const write: PgCoverage = owner ? "all" : active && (ri + si) % 3 === 1 ? "some" : "none";
    const aspects = schemaAspects({ usage: active, create: owner, read, write });
    return { role: r.name, schema, ...aspects, inheritedOnly: active && !owner && ri % 2 === 0, unusable: null, direct: owner || ri % 2 === 0 ? schemaAspects() : aspects, owned: owner ? aspects : schemaAspects() };
  }));
  return { ...original, database: name, fetchedAt: now(), schemas: schemas.map((s, i) => ({ name: s, owner: "app_owner", tableCount: [8, 24, 12, 16][i] })), cells,
    dbPrivileges: roles.map((r) => ({ role: r.name, connect: true, create: r.name === "app_owner", temp: true, direct: dbAspects({ connect: true, temp: true }), owned: r.name === "app_owner" ? dbAspects({ connect: true, create: true, temp: true }) : dbAspects() })),
    defaultPrivileges: original.defaultPrivileges.map((d) => ({ ...d, schema: d.schema === "app" ? "orders" : d.schema })) };
}
const sessions = () => sampleSessions().map((s, i) => ({ ...s, backendStart: ago(30 + i * 5), queryStart: ago(i + 1) }));
const resource = (id: string, engine: string, cluster = true) => {
  const endpoint = `${id}.${cluster ? "cluster-" : ""}c9akciq32.ap-northeast-2.rds.amazonaws.com`;
  const values = { id, name: id, engine, status: "available", endpoint, class: "db.r6g.large", cluster: "orders-db" };
  return { id, name: id, arn: `arn:aws:rds:ap-northeast-2:123456789012:${cluster ? "cluster" : "db"}:${id}`, values, tags: { Team: "platform", Env: "prod" }, fields: [{ label: "Engine version", value: engine === "aurora-postgresql" ? "16.4" : "8.0.mysql_aurora.3.06.0" }], raw: JSON.stringify(values, null, 2), consoleUrl: null };
};
export const pgSettings: Record<string, unknown> = { pgLogins: { [arn]: "iam_admin" } };
export const pgResources: Record<string, unknown[]> = { "rds/db-clusters": [resource("orders-db", "aurora-postgresql"), resource("legacy-commerce", "aurora-mysql")], "rds/db-instances": [resource("orders-db-1", "aurora-postgresql", false), resource("orders-db-2", "aurora-postgresql", false)] };

function preview(change: PgChange) {
  if (change.kind === "grant") {
    const item = change.items[0];
    const schema = "schema" in item.target ? item.target.schema : item.target.name;
    const privileges = item.privileges.join(", ");
    const sql = `GRANT ${privileges} ON ALL TABLES IN SCHEMA "${schema}" TO "${change.grantee}"`;
    return samplePreview({ change, database: change.database, summary: `권한 주기: ${change.grantee} · ${schema} 스키마의 모든 테이블 ${privileges}`, sql: [sql], impacts: [{ role: change.grantee, gained: [{ database: change.database, schema, objectKind: "table", privilege: privileges, count: 16, sample: [`${schema}.daily_sales`, `${schema}.order_metrics`, `${schema}.revenue_summary`] }], lost: [] }], warnings: [{ level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요. 기본 권한도 확인하세요.", add: [] }] });
  }
  return samplePreview({ change });
}
export function pgMock(cmd: string, a: Record<string, any>): unknown {
  switch (cmd) {
    case "pg_target": return target;
    case "pg_open": case "pg_overview": return overview();
    case "pg_database": return database(a.database);
    case "pg_cell": { const detail = sampleCellDetail(); return { ...detail, role: a.role, schema: a.schema, objects: detail.objects.map((o) => ({ ...o, object: { ...o.object, schema: a.schema } })) }; }
    case "pg_role": { const summary = roles.find((r) => r.name === a.role) ?? roles[0]; return { summary, settings: [{ database: null, setting: "search_path=orders, public", allRoles: false }, { database: "orders", setting: "statement_timeout=30s", allRoles: false }], members: roles.flatMap((r) => r.memberOf.filter((m) => m.group === summary.name).map((m) => ({ role: r.name, inherit: m.inherit, set: m.set, admin: m.admin }))), databases: overview().databases.filter((d) => d.allowConn).map((d) => ({ database: d.name, loaded: true, truncated: false, cells: database(d.name).cells.filter((c) => c.role === summary.name && c.usage), owned: [], ownedOmitted: 0 })), sessions: sessions().filter((s) => s.role === summary.name), setRoleOnly: [] }; }
    case "pg_sessions": return sessions();
    case "pg_findings": { const findings = sampleFindings({ fetchedAt: now(), skipped: [] }); return { ...findings, groups: findings.groups.map((g) => ({ ...g, items: g.items.map((item) => ({ ...item, detail: item.role === "bob" ? `bob은 ${new Date(Date.now() + 8 * 86400_000).toISOString().slice(0, 10)}에 만료돼요` : item.detail.replaceAll("app.touch_order", "orders.touch_order"), object: item.object?.schema === "app" ? { ...item.object, schema: "orders" } : item.object })) })) }; }
    case "pg_objects": return sampleCellDetail().objects.map((o) => ({ ...o.object, schema: "orders" }));
    case "pg_who_can": return sampleWhoCan({ object: a.object, privilege: a.privilege });
    case "pg_preview": return preview(a.change);
    case "pg_preview_batch": { const items = (a.changes as PgChange[]).map(preview); return sampleBatchPreview({ database: a.database, items: items.map((p) => ({ change: p.change, summary: p.summary, sql: p.sql, warnings: p.warnings })), sql: items.flatMap((p) => p.sql), impacts: items.flatMap((p) => p.impacts), roles: [], warnings: [] }); }
    case "pg_preset": return samplePresetSuggestion({ blockedCreators: [] });
    case "pg_change_log": return sampleChangeLog().map((e) => ({ ...e, targetArn: arn, at: ago(45) }));
    case "pg_drop_plan": return sampleDropPlan();
    case "pg_close": return null;
    default: return undefined;
  }
}
