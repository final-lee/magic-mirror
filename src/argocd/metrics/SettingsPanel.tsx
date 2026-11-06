import { useEffect, useState } from "react";
import { NotifySettings } from "../notify/NotifySettings";
import { useKubeContexts, useServerKubeContext } from "../ops/queries";
import { useServerSettings } from "./serverSettings";
import { METRICS_TEXT as T } from "./text";

/** 이 서버의 지표 설정: ArgoCD가 있는 kube context·네임스페이스(컨트롤러 지표), macOS 알림 */
export function SettingsPanel({ url }: { url: string }) {
  const { server, patch } = useServerSettings(url);
  const context = useServerKubeContext(url);
  const contexts = useKubeContexts();
  const [namespace, setNamespace] = useState(server?.argocdNamespace ?? "");
  useEffect(() => setNamespace(server?.argocdNamespace ?? ""), [server?.argocdNamespace]);
  return (
    <div className="argo-metrics-scroll">
      <div className="argo-metrics-note">{T.settingsSaved}</div>
      <div className="argo-metrics-form">
        <label htmlFor="argo-metrics-context">{T.settingsContext}</label>
        <select id="argo-metrics-context" value={context.kubeContext ?? ""} disabled={!context.canSet} onChange={(e) => context.set(e.target.value || null)}>
          <option value="">{T.settingsContextNone}</option>
          {(contexts.data ?? []).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          {context.kubeContext && !(contexts.data ?? []).some((c) => c.name === context.kubeContext) && <option value={context.kubeContext}>{context.kubeContext}</option>}
        </select>
        <span className="hint">{T.settingsContextHelp}</span>
        <label htmlFor="argo-metrics-namespace">{T.settingsNamespace}</label>
        <input id="argo-metrics-namespace" placeholder={T.ctlNamespaceHint} value={namespace} onChange={(e) => setNamespace(e.target.value)} onBlur={() => patch({ argocdNamespace: namespace.trim() || undefined })} />
        <span className="hint">{T.settingsNamespaceHelp}</span>
      </div>
      <NotifySettings value={server?.notify} onChange={(notify) => patch({ notify })} />
    </div>
  );
}
