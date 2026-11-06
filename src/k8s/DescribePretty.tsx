import { createContext, useContext, type ReactNode } from "react";
import { StatusBadge } from "./columns";
import type { DescribeNode } from "./describeParse";
import { statusTone } from "./status";

/** 끝난 Pod(Succeeded)인가: 그렇다면 컨테이너 `Ready: False`는 정상이라 배지로 겁주지 않는다 */
const Finished = createContext(false);

type Field = Extract<DescribeNode, { t: "field" }>;

const has = (table: Record<string, true>, key: string) => Object.prototype.hasOwnProperty.call(table, key);
const EMPTY: Record<string, true> = { "<none>": true, "<unset>": true, "": true };
/** 한 낱말 값이면 상태 배지로 보이는 키 */
const BADGE_KEYS: Record<string, true> = { Status: true, State: true, Ready: true, Phase: true, Reason: true };
/** `키=값`을 칩으로 보이는 키(Selector는 쉼표로 나뉜다) */
const CHIP_KEYS: Record<string, true> = { Labels: true, Selector: true, "Node-Selectors": true, "Node-Selector": true };
/** 이름 붙은 항목의 모음: 그 아래 항목(컨테이너·볼륨 이름)은 깊이와 상관없이 카드로 */
const COLLECTIONS: Record<string, true> = { Containers: true, "Init Containers": true, "Ephemeral Containers": true, Volumes: true };
const simple = (n: DescribeNode): n is Field => n.t === "field" && n.children.length === 0;

function Value({ field }: { field: Field }) {
  const { key, value } = field;
  const first = value[0] ?? "";
  const finished = useContext(Finished);
  if (value.length <= 1 && has(EMPTY, first)) return <span className="dim">{first}</span>;
  if (has(CHIP_KEYS, key)) {
    const items = value.flatMap((line) => line.split(",")).map((s) => s.trim()).filter(Boolean);
    return <span className="desc-chips">{items.map((item, i) => <span key={i} className="desc-chip">{item}</span>)}</span>;
  }
  if (key === "Annotations") {
    return (
      <span className="desc-lines">
        {value.map((line, i) => {
          const at = line.indexOf(": ");
          return at < 0 ? <span key={i}>{line}</span> : <span key={i}><span className="dim">{line.slice(0, at)}</span> {line.slice(at + 2)}</span>;
        })}
      </span>
    );
  }
  if (has(BADGE_KEYS, key) && value.length === 1 && !first.includes(" ") && !(finished && key === "Ready")) return <StatusBadge text={first} />;
  if (key === "Restart Count" && Number(first) > 0) return <span className="k8s-restarts">{first}</span>;
  if (value.length > 1) return <span className="desc-lines">{value.map((line, i) => <span key={i}>{line}</span>)}</span>;
  return <>{first}</>;
}

function Table({ node, events }: { node: Extract<DescribeNode, { t: "table" }>; events: boolean }) {
  const typeAt = node.headers.indexOf("Type");
  return (
    <div className="desc-table-wrap">
      <table className="k8s-table desc-table">
        <thead>
          <tr>{node.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {node.rows.map((row, r) => (
            <tr key={r} className={events && typeAt >= 0 && row[typeAt] === "Warning" ? "desc-warning" : undefined}>
              {row.map((c, i) => <td key={i}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 같은 자리의 노드를 차례로: 이어진 단순 필드는 한 표(키·값 격자)로 묶는다 */
function Nodes({ nodes, depth, section }: { nodes: DescribeNode[]; depth: number; section: string }) {
  const out: ReactNode[] = [];
  let run: Field[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const kv = (
      <dl key={`kv${out.length}`} className="desc-kv">
        {run.map((f, i) => (
          <div key={i} className="k8s-kv">
            <dt>{f.key}</dt>
            <dd><Value field={f} /></dd>
          </div>
        ))}
      </dl>
    );
    // 맨 위에서 구역 뒤에 오는 필드(Controlled By, QoS Class …)는 앞 구역에 붙어 보이지 않게 선을 긋는다
    out.push(depth === 0 && out.length > 0 ? <section key={`kv${out.length}`} className="desc-sect">{kv}</section> : kv);
    run = [];
  };
  nodes.forEach((n, i) => {
    if (simple(n)) {
      run.push(n);
      return;
    }
    flush();
    if (n.t === "text") out.push(<div key={i} className="desc-text">{n.text}</div>);
    else if (n.t === "table") out.push(<Table key={i} node={n} events={section === "Events"} />);
    else out.push(<Group key={i} field={n} depth={depth} card={has(COLLECTIONS, section)} />);
  });
  flush();
  return <>{out}</>;
}

/** 자식이 있는 필드: 맨 위는 제목 달린 구역, 모음 안의 항목(컨테이너·볼륨 이름)은 카드, 그 밖은 들여 쓴 묶음 */
function Group({ field, depth, card }: { field: Field; depth: number; card: boolean }) {
  const value = field.value.length > 0 && <span className="desc-sub"><Value field={field} /></span>;
  const body = <Nodes nodes={field.children} depth={depth + 1} section={field.key} />;
  if (depth === 0) {
    return (
      <section className="desc-sect">
        <h4>{field.key}{value}</h4>
        {body}
      </section>
    );
  }
  if (card) {
    return (
      <div className="desc-card">
        <div className="desc-card-title">{field.key}{value}</div>
        {body}
      </div>
    );
  }
  return (
    <div className="desc-nested">
      <div className="desc-nested-title">{field.key}{value}</div>
      {body}
    </div>
  );
}

/** kubectl describe를 읽기 쉽게: 키·값 격자, 구역 제목, 컨테이너·볼륨 카드, 표, 레이블 칩, 상태 배지 */
export function DescribePretty({ nodes }: { nodes: DescribeNode[] }) {
  const status = nodes.find((n): n is Field => n.t === "field" && n.key === "Status")?.value[0];
  return (
    <Finished.Provider value={status !== undefined && statusTone(status) === "done"}>
      <div className="desc">
        <Nodes nodes={nodes} depth={0} section="" />
      </div>
    </Finished.Provider>
  );
}
