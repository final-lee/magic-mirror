import { useMemo, useState } from "react";
import type { ListFindState } from "../../components/ListFind";
import { LogPane } from "../../k8s/LogView";
import { LogsShell } from "../../k8s/PodLogs";
import type { K8sLogOptions } from "../../k8s/types";
import type { AppTarget, ArgoLogOptions, ContainerRef, ResRef } from "../types";
import { logsKind } from "./helpers";
import { useArgoLogStream } from "./useArgoLogStream";

interface ViewProps {
  url: string;
  target: AppTarget;
  res: ResRef;
  live: boolean;
  view: { options: K8sLogOptions; pretty: boolean; showTime: boolean; wrap: boolean; find: ListFindState };
}

function ArgoLogView({ url, target, res, live, view }: ViewProps) {
  const [nonce, setNonce] = useState(0);
  const isPod = logsKind(res) === "pod";
  const { container, follow, previous, tailLines, sinceSeconds } = view.options;
  const options = useMemo<ArgoLogOptions>(
    () => ({
      podName: isPod ? res.name : null,
      container,
      kind: isPod ? null : res.kind,
      group: isPod ? null : res.group,
      resourceName: isPod ? null : res.name,
      namespace: res.namespace ?? "",
      follow,
      previous,
      tailLines,
      sinceSeconds,
    }),
    [isPod, res.name, res.kind, res.group, res.namespace, container, follow, previous, tailLines, sinceSeconds],
  );
  const state = useArgoLogStream(url, target, options, nonce, live);
  return (
    <LogPane
      state={state}
      ssoProfile=""
      name={res.name}
      workload={isPod ? "" : res.name}
      options={view.options}
      nonce={nonce}
      onRestart={() => setNonce((n) => n + 1)}
      pretty={view.pretty}
      showTime={view.showTime}
      wrap={view.wrap}
      find={view.find}
    />
  );
}

/**
 * Pod 또는 워크로드의 로그 탭. EKS 로그 탭의 막대(컨테이너·이전·따라가기·기간·줄 수)와 보기(검색·레벨·저장)를 그대로 쓰되,
 * 흐름은 ArgoCD 서버의 앱 로그에서 받는다. 서버는 컨테이너를 꼭 지정해야 하므로 "모든 컨테이너" 선택은 없다.
 */
export function ResourceLogs({ url, target, res, containers, live }: { url: string; target: AppTarget; res: ResRef; containers: ContainerRef[]; live: boolean }) {
  const first = containers.find((c) => !c.init)?.name ?? containers[0]?.name ?? null;
  return (
    <LogsShell containers={containers} initialContainer={first} allContainers={false}>
      {(view) => <ArgoLogView url={url} target={target} res={res} live={live} view={view} />}
    </LogsShell>
  );
}
