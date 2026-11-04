import { useQuery } from "@tanstack/react-query";
import type { AppError } from "../../api/types";
import { kindKey, targetKey } from "../targets";
import type { K8sTarget, ObjectRef } from "../types";
import { xrayApi } from "./api";
import type { K8sXray } from "./types";

/** 대상별 관계 트리는 ["k8s", targetKey, "xray", ...] 아래에 둔다(연결을 지우거나 새로 고치면 같이 비워진다) */
export const xrayKeys = {
  tree: (t: K8sTarget, context: string | null, ref: ObjectRef, resourceVersion: string | null) =>
    ["k8s", targetKey(t), "xray", context, kindKey(ref.kind), ref.namespace, ref.name, resourceVersion] as const,
};

/**
 * 관계 트리. 객체의 resourceVersion을 키에 넣어, 객체가 바뀌면 다시 읽는다.
 * 목록 밖의 객체(resourceVersion이 null)는 30초 동안만 그대로 쓴다.
 */
export function useK8sXray(target: K8sTarget, context: string | null, ref: ObjectRef, resourceVersion: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sXray, AppError>({
    queryKey: xrayKeys.tree(target, context, ref, resourceVersion),
    queryFn: () => xrayApi.get(target, ref.kind, ref.namespace, ref.name, ssoProfile),
    enabled: enabled && context !== null,
    staleTime: resourceVersion === null ? 30_000 : Infinity,
    retry: false,
  });
}
