import { PodTerminal } from "./PodTerminal";
import { NODE_SHELL_BAR, NODE_SHELL_CLOSE_NOTE, SHELL_CLOSE } from "./text";
import type { K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  node: string;
  /** 변경 틀로 만든 노드 셸 Pod가 있는 네임스페이스와 이름 */
  namespace: string;
  pod: string;
  visible: boolean;
  onClose: () => void;
}

/** 노드 상세의 노드 셸. 닫거나 사라지면 세션이 끊기고 디버그 Pod는 백엔드가 지운다. */
export function NodeShellPane({ target, ssoProfile, node, namespace, pod, visible, onClose }: Props) {
  return (
    <div className="k8s-shell">
      <div className="k8s-shell-bar">
        <span className="mono">{NODE_SHELL_BAR(node)}</span>
        <span className="dim">{NODE_SHELL_CLOSE_NOTE}</span>
        <button className="btn k8s-push" onClick={onClose}>
          {SHELL_CLOSE}
        </button>
      </div>
      <PodTerminal target={target} ssoProfile={ssoProfile} namespace={namespace} pod={pod} container="" mode="node" confirmText={null} visible={visible} />
    </div>
  );
}
