import type { RefObject } from "react";
import { useCommand } from "../../keymap/registry";
import type { K8sKindRef, ObjectRef } from "../types";
import { pressRow, type RowCommand } from "./rowKeys";
import { KEY_ALREADY_ALL, KEY_CLUSTER_SCOPED } from "./text";

interface Props {
  /** 목록과 그 위에 뜨는 상세를 감싼 상자. 키는 이 안에 커서가 있을 때만 온다 */
  pane: RefObject<HTMLElement>;
  /** 상세에 열려 있는 객체(고른 행). 없으면 "먼저 행을 골라요" */
  object: ObjectRef | null;
  /** 지금 보는 목록의 종류 */
  kind: K8sKindRef;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  /** 모든 네임스페이스로 바꾼다. 없으면 0 키는 안내만 한다 */
  onAllNamespaces?: () => void;
  /** 탭이 보일 때만 */
  enabled: boolean;
  /** 하지 못한 이유를 상태 줄에 보인다 */
  onNote: (text: string) => void;
}

/**
 * 목록의 한 글자 키(k9s). 고른 행의 상세 단추를 누르는 것으로 처리해서 종류·권한·상태 규칙과 미리보기 단계를 단추와 똑같이 따른다.
 * 처리하지 못하면 이유를 onNote로 보인다.
 */
export function useRowKeys({ pane, object, kind, namespace, onAllNamespaces, enabled, onNote }: Props) {
  const options = { host: pane, enabled };
  const press = (command: RowCommand) => () => {
    const why = pressRow(command, pane.current, object);
    if (why) onNote(why);
  };
  useCommand("k8s.describe", press("k8s.describe"), options);
  useCommand("k8s.yaml", press("k8s.yaml"), options);
  useCommand("k8s.edit", press("k8s.edit"), options);
  useCommand("k8s.logs", press("k8s.logs"), options);
  useCommand("k8s.shell", press("k8s.shell"), options);
  useCommand("k8s.attach", press("k8s.attach"), options);
  useCommand("k8s.forward", press("k8s.forward"), options);
  useCommand("k8s.restart", press("k8s.restart"), options);
  useCommand("k8s.cordon", press("k8s.cordon"), options);
  useCommand("k8s.uncordon", press("k8s.uncordon"), options);
  useCommand("k8s.delete", press("k8s.delete"), options);
  useCommand(
    "k8s.allNamespaces",
    () => {
      if (!kind.namespaced) onNote(KEY_CLUSTER_SCOPED(kind.kind));
      else if (namespace === null) onNote(KEY_ALREADY_ALL);
      else onAllNamespaces?.();
    },
    options,
  );
}
