import type { ColumnKind } from "../api/types";
import { formatValue, stateColor } from "../lib/format";
import { Highlight } from "./Highlight";

/** tokens를 주면 글로 된 칸(text, mono, state)에서 퍼지 필터가 맞은 글자를 칠한다 */
export function Cell({ kind, value, tokens = [] }: { kind: ColumnKind; value: string | undefined; tokens?: readonly string[] }) {
  const text = formatValue(kind, value);
  if (kind === "state" && text) {
    return (
      <>
        <span className={`dot ${stateColor(text)}`} />
        <Highlight text={text} tokens={tokens} />
      </>
    );
  }
  if (kind === "mono")
    return (
      <span className="mono">
        <Highlight text={text} tokens={tokens} />
      </span>
    );
  if (kind === "text") return <Highlight text={text} tokens={tokens} />;
  return <>{text}</>;
}
