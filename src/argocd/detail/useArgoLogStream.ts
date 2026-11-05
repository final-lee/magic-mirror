import { useEffect, useReducer } from "react";
import { LOG_INITIAL, logReduce } from "../../k8s/LogView";
import type { K8sLogMessage } from "../../k8s/types";
import type { AppTarget, ArgoLogOptions } from "../types";
import { readApi } from "./api";

/** ArgoCD 앱 로그 흐름 하나. 옵션이나 nonce가 바뀌면 끊고 처음부터 다시 열고, 사라지면 끊는다. 상태는 EKS 로그와 같은 모양이다. */
export function useArgoLogStream(url: string, target: AppTarget, options: ArgoLogOptions, nonce: number, live: boolean) {
  const [state, dispatch] = useReducer(logReduce, LOG_INITIAL);
  const key = JSON.stringify([url, target, options, nonce, live]);

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!live) return;
    let gone = false;
    let id: number | null = null;
    const onMessage = (message: K8sLogMessage) => {
      if (!gone) dispatch({ type: "message", message });
    };
    readApi
      .logs(url, target, options, onMessage)
      .then((n) => {
        if (gone) void readApi.logsStop(n);
        else id = n;
      })
      .catch((e: unknown) => {
        if (!gone) dispatch({ type: "fail", error: e });
      });
    return () => {
      gone = true;
      if (id !== null) void readApi.logsStop(id);
    };
    // key가 서버·앱·로그 옵션·nonce·live를 모두 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
