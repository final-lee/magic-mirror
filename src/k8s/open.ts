/** 다른 탭(ArgoCD 등)이 EKS 탭에 부탁하는 일. 같은 요청을 다시 해도 새 요청이도록 nonce가 바뀐다. */
export type K8sOpen = { kind: "shell"; namespace: string; pod: string; container: string | null; nonce: number };
