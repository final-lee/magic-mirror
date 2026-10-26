import { useQuery } from "@tanstack/react-query";
import { explorerApi } from "./api";

export function useLocalHome() {
  return useQuery({ queryKey: ["localHome"], queryFn: explorerApi.localHome, staleTime: Infinity });
}

export function useLocalList(path: string | null) {
  return useQuery({
    queryKey: ["local", path],
    queryFn: () => explorerApi.localList(path!),
    enabled: !!path,
    staleTime: Infinity,
    retry: false,
  });
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}
