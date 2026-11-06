import { KvError } from "../KvError";
import { flowNodeId } from "./flowModel";
import { FlowGraph } from "./FlowGraph";
import { useKvBullFlow } from "../queries";
import * as t from "../text";
import type { KvTarget } from "../types";

interface Props {
  target: KvTarget;
  prefix: string;
  queue: string;
  id: string;
  onClose: () => void;
  /** 노드를 누르면 그 작업을 연다(큰 화면은 닫힌다) */
  onOpen: (queue: string, id: string) => void;
}

/** 작업 흐름을 큐 상세의 화면 전체에 크게 보인다. 작업 상세 오버레이의 [크게 보기]가 연다. */
export function FlowFull({ target, prefix, queue, id, onClose, onOpen }: Props) {
  const q = useKvBullFlow(target, prefix, queue, id, true);
  return (
    <div className="kv-flow-big" role="dialog" aria-label={`${t.FLOW_GRAPH} ${flowNodeId({ queue, id })}`}>
      <div className="kv-flow-big-head">
        <h3 className="mono">{`${t.FLOW_GRAPH} · ${flowNodeId({ queue, id })}`}</h3>
        <button type="button" className="btn small tone-ghost" onClick={onClose}>
          {t.FLOW_CLOSE}
        </button>
      </div>
      {q.data ? (
        <FlowGraph flow={q.data} big onOpen={(nq, nid) => onOpen(nq, nid)} />
      ) : q.isError ? (
        <KvError error={q.error} target={target} />
      ) : (
        <div className="empty">{t.LOADING}</div>
      )}
    </div>
  );
}
