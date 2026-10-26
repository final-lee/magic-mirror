import type { ColumnKind } from "../api/types";
import { formatValue, stateColor } from "../lib/format";

export function Cell({ kind, value }: { kind: ColumnKind; value: string | undefined }) {
  const text = formatValue(kind, value);
  if (kind === "state" && text) {
    return (
      <>
        <span className={`dot ${stateColor(text)}`} />
        {text}
      </>
    );
  }
  if (kind === "mono") return <span className="mono">{text}</span>;
  return <>{text}</>;
}
