import { Fragment, useState } from "react";
import type { DiffLine, DiffRow } from "./types";
function Line({ line }: { line: DiffLine | null }) {
  if (!line) return <div className="dcell empty-cell" />;
  return <div className="dcell"><span className="ln">{line.no}</span><span className="code">{line.segments.map((s, i) => <span key={i} className={s.emph ? "emph" : undefined}>{s.text}</span>)}</span></div>;
}
export function RowView({ row }: { row: DiffRow }) { return <><Line line={row.left} /><Line line={row.right} /></>; }
export function TextDiffView({ rows }: { rows: DiffRow[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return <div className="diff"><div className="diff-body">{rows.map((row, i) => <Fragment key={i}>{row.kind === "collapsed" ? expanded.has(i) ? row.hiddenRows.map((h,j) => <div className="drow k-equal" key={j}><RowView row={h} /></div>) : <div className="drow k-collapsed"><button className="link" onClick={() => setExpanded((prev) => new Set(prev).add(i))}>… {row.hiddenRows.length}줄 같음</button></div> : <div className={`drow k-${row.kind}`}><RowView row={row} /></div>}</Fragment>)}</div></div>;
}
