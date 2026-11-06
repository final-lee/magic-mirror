import { useEffect, useState } from "react";
import { errorMessage } from "../../api/errors";
import { ARGO_ENVS } from "../argoEnv";
import { ARGO_ENV_TEXT } from "../text";
import type { ArgocdNotify } from "../types";
import { askNotifyPermission, notifyGranted } from "./deliver";
import { DEFAULT_NOTIFY } from "./rules";
import { NOTIFY_DENIED, NOTIFY_ENABLE, NOTIFY_ENVS, NOTIFY_ENVS_ALL, NOTIFY_HELP, NOTIFY_MINUTES, NOTIFY_PERMISSION_FAILED, NOTIFY_SECTION } from "./text";

/** 서버의 macOS 알림 설정: 켜기(처음 켤 때 권한을 한 번 묻는다), 환경 필터, OutOfSync 지속 시간 */
export function NotifySettings({ value, onChange }: { value: ArgocdNotify | undefined; onChange: (next: ArgocdNotify) => void }) {
  const config = value ?? DEFAULT_NOTIFY;
  const [problem, setProblem] = useState<string | null>(null);
  // 켜져 있는데 macOS가 막고 있으면 바로 알 수 있게 한다
  useEffect(() => {
    if (!config.enabled) return;
    notifyGranted().then((granted) => setProblem(granted ? null : NOTIFY_DENIED)).catch(() => setProblem(NOTIFY_PERMISSION_FAILED));
  }, [config.enabled]);

  const toggle = async (enabled: boolean) => {
    if (!enabled) {
      setProblem(null);
      onChange({ ...config, enabled: false });
      return;
    }
    try {
      const permission = await askNotifyPermission();
      setProblem(permission === "granted" ? null : NOTIFY_DENIED);
      onChange({ ...config, enabled: permission === "granted" });
    } catch (e) {
      setProblem(`${NOTIFY_PERMISSION_FAILED}: ${errorMessage(e)}`);
    }
  };
  const toggleEnv = (env: string) => onChange({ ...config, envs: config.envs.includes(env) ? config.envs.filter((e) => e !== env) : [...config.envs, env] });

  return (
    <fieldset className="argo-metrics-form">
      <legend>{NOTIFY_SECTION}</legend>
      <span>{NOTIFY_ENABLE}</span>
      <input type="checkbox" role="switch" aria-label={NOTIFY_ENABLE} checked={config.enabled} onChange={(e) => void toggle(e.target.checked)} />
      <span className="hint">{NOTIFY_HELP}</span>
      {problem && <span className="hint err" role="alert">{problem}</span>}
      <span>{NOTIFY_ENVS}</span>
      <div className="argo-metrics-chips">
        <button className="argo-metrics-chip" aria-pressed={config.envs.length === 0} onClick={() => onChange({ ...config, envs: [] })}>{NOTIFY_ENVS_ALL}</button>
        {ARGO_ENVS.map((env) => <button key={env} className="argo-metrics-chip" aria-pressed={config.envs.includes(env)} onClick={() => toggleEnv(env)}>{ARGO_ENV_TEXT[env]}</button>)}
      </div>
      <span>{NOTIFY_MINUTES}</span>
      <input type="number" min={1} aria-label={NOTIFY_MINUTES} value={config.outOfSyncMinutes} onChange={(e) => onChange({ ...config, outOfSyncMinutes: Math.max(1, Math.floor(Number(e.target.value)) || DEFAULT_NOTIFY.outOfSyncMinutes) })} />
    </fieldset>
  );
}
