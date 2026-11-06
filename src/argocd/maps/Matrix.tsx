import { useMemo, useState } from "react";
import { ARGO_ENVS, type ArgoEnv } from "../argoEnv";
import { clusterText } from "../argoGroup";
import { ARGO_ENV_TEXT, MAP_TEXT } from "../text";
import type { ArgoAppRow } from "../types";
import { matrix, type Dimension } from "./model";
import "./maps.css";

export function Matrix({ rows, onSelect }: { rows: ArgoAppRow[]; onSelect: (env: ArgoEnv, dim: Dimension, value: string) => void }) {
  const [dim, setDim] = useState<Dimension>("cluster");
  const data = useMemo(() => matrix(rows, dim), [rows, dim]);
  return <div className="argo-map-scroll"><div className="argo-map-controls"><select aria-label={MAP_TEXT.matrixDimension} value={dim} onChange={e => setDim(e.target.value as Dimension)}><option value="cluster">{MAP_TEXT.cluster}</option><option value="project">{MAP_TEXT.project}</option></select></div>
    <table className="argo-map-table"><thead><tr><th>{MAP_TEXT.env}</th>{data.columns.map(c => <th key={c}>{(dim === "cluster" ? clusterText(c) : c) || "—"}</th>)}</tr></thead><tbody>{ARGO_ENVS.map(env => <tr key={env}><th>{ARGO_ENV_TEXT[env]}</th>{data.columns.map(col => { const cell = data.cells.get(JSON.stringify([env, col])); return <td key={col}>{cell ? <button className={`argo-map-cell ${cell.level}`} onClick={() => onSelect(env, dim, col)}><b>{cell.rows.length}</b><small>{MAP_TEXT.tally(cell.tally)}</small></button> : "—"}</td>; })}</tr>)}</tbody></table>
  </div>;
}
