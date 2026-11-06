import { useQuery } from "@tanstack/react-query";
import { argoKeys } from "./queries";
import { changeApi } from "./change/api";
import type { ArgoTarget } from "./change/types";
export function useArgoCan(url: string, target: ArgoTarget | null, actions: string[]) {
  const object = target ? `${target.project}/${target.name}` : "";
  return useQuery({ queryKey: [...argoKeys.server(url), "can", object, actions], enabled: !!target, queryFn: () => changeApi.can(url, actions.map((action) => ({ resource: "applications", action, object }))), staleTime: 60_000, retry: false });
}
export function useArgoSettings(url: string) {
  return useQuery({ queryKey: [...argoKeys.server(url), "settings"], queryFn: () => changeApi.settings(url), staleTime: 60_000, retry: false });
}
