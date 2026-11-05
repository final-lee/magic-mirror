import { useContext, useState } from "react";
import { errorMessage } from "../../api/errors";
import type { ArgoDestination, ContainerRef, ResRef } from "../types";
import { eksTarget, matchContext } from "./kubeContext";
import { useKubeContexts, useServerKubeContext } from "./queries";
import { ArgoShellContext } from "./ShellHost";
import { SHELL_CONTAINER, SHELL_LOADING, SHELL_OPEN, SHELL_PICK, SHELL_SAVE, SHELL_TITLE, SHELL_VIA, SHELL_WHICH } from "./text";
import type { KubeContext } from "./types";

interface Props {
  url: string;
  destination: ArgoDestination;
  /** 열 Pod(namespace가 있는 Pod) */
  res: ResRef & { namespace: string };
  containers: ContainerRef[];
}

/**
 * Pod에서 터미널 열기: 대상 클러스터에 맞는 kube context를 찾아 EKS 탭으로 넘긴다(ArgoCD exec는 쓰지 않는다).
 * 맞는 context를 못 찾으면 이유를 보이고, in-cluster면 서버 설정에 context를 저장하게 한다.
 */
export function ShellSection({ url, destination, res, containers }: Props) {
  const host = useContext(ArgoShellContext);
  const contexts = useKubeContexts();
  const saved = useServerKubeContext(url);
  const shells = containers.filter((c) => !c.init);
  const [container, setContainer] = useState<string | null>(null);
  const [pickedName, setPickedName] = useState("");
  if (!host) return null;

  const chosenContainer = shells.find((c) => c.name === container)?.name ?? shells[0]?.name ?? null;
  const match = contexts.data ? matchContext(destination, contexts.data, saved.kubeContext) : null;
  const picker = (list: KubeContext[], label: string, action?: { label: string; onClick: (name: string) => void }) => (
    <div className="k8s-list-bar">
      <label>
        {label}
        <select value={pickedName} onChange={(e) => setPickedName(e.target.value)}>
          <option value="">{SHELL_PICK}</option>
          {list.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {action && (
        <button className="btn small tone-secondary" disabled={pickedName === "" || !saved.canSet} onClick={() => action.onClick(pickedName)}>
          {action.label}
        </button>
      )}
    </div>
  );

  let body;
  if (contexts.isError) {
    body = <p className="err">{errorMessage(contexts.error)}</p>;
  } else if (!match) {
    body = <p className="dim">{SHELL_LOADING}</p>;
  } else {
    // 여러 context가 맞으면 하나를 고르게 하고, 하나로 정해지면 그 context가 EKS 탭으로 열릴 수 있는지 본다
    const chosen = match.status === "found" ? match.context : match.status === "ambiguous" ? match.candidates.find((c) => c.name === pickedName) ?? null : null;
    const target = chosen ? eksTarget(chosen, host.profile) : null;
    body = (
      <>
        {match.status === "none" && <p className="dim">{match.reason}</p>}
        {match.status === "ambiguous" && picker(match.candidates, SHELL_WHICH)}
        {match.status === "none" && match.inCluster && contexts.data && picker(contexts.data, SHELL_WHICH, { label: SHELL_SAVE, onClick: (name) => saved.set(name) })}
        {chosen && <p className="dim">{SHELL_VIA(chosen.name)}</p>}
        {target?.status === "blocked" && <p className="dim">{target.reason}</p>}
        <div className="k8s-list-bar">
          {shells.length > 0 && (
            <label>
              {SHELL_CONTAINER}
              <select value={chosenContainer ?? ""} onChange={(e) => setContainer(e.target.value)}>
                {shells.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="btn small tone-primary"
            disabled={target?.status !== "ready"}
            onClick={() => target?.status === "ready" && host.open(target.target, { namespace: res.namespace, pod: res.name, container: chosenContainer })}
          >
            {SHELL_OPEN}
          </button>
        </div>
      </>
    );
  }
  return (
    <section aria-label={SHELL_TITLE}>
      <h4>{SHELL_TITLE}</h4>
      {body}
    </section>
  );
}
