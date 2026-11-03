export function widgetUrls(serverUrl: string, namespace: string, label: string) {
  const base = serverUrl.replace(/\/+$/, "");
  const ns = encodeURIComponent(namespace);
  const query = encodeURIComponent(label);
  return {
    badge: `${base}/widgets/workflow-status-badges/${ns}?label=${query}`,
    graph: `${base}/widgets/workflow-graphs/${ns}?label=${query}`,
  };
}

export function argoUiUrl(serverUrl: string, kind: "workflow" | "cron" | "template" | "clusterTemplate", namespace: string | null, name: string) {
  const base = serverUrl.replace(/\/+$/, "");
  const path = { workflow: "workflows", cron: "cron-workflows", template: "workflow-templates", clusterTemplate: "cluster-workflow-templates" }[kind];
  return `${base}/${path}/${namespace === null ? "" : `${encodeURIComponent(namespace)}/`}${encodeURIComponent(name)}`;
}
