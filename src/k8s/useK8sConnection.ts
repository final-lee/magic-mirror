import { useSettings } from "../api/queries";
import { useK8sContext, useK8sSession } from "./queries";
import { chooseContext, ssoProfileOf } from "./targets";
import type { K8sTarget } from "./types";

/**
 * 대상 클러스터에 붙는 과정(설정 → kubeconfig context 고르기 → 세션). EKS 탭과 탐색기의 클러스터 상세가 같이 쓴다.
 * 같은 대상이면 쿼리 키가 같아 연결도 하나를 나눠 쓴다.
 */
export function useK8sConnection(target: K8sTarget) {
  const { settings, isError: settingsFailed, update } = useSettings();
  const settingsReady = settings !== undefined || settingsFailed;
  const kubeconfig = settings?.kubeconfigPath ?? null;
  // 저장해 둔 context는 ARN을 알아야 찾을 수 있어서, 백엔드에는 늘 null을 넘기고 고르는 일은 여기서 한다.
  const ctx = useK8sContext(target, kubeconfig, null, settingsReady);
  const info = ctx.data;
  const saved = info ? settings?.k8sContexts?.[info.arn] ?? null : null;
  const [chosen, missing] = info
    ? chooseContext(
        info.candidates.map((c) => c.name),
        saved,
      )
    : [null, null];
  const candidate = info?.candidates.find((c) => c.name === chosen) ?? null;
  const session = useK8sSession(target, kubeconfig, settingsReady ? chosen : null, ssoProfileOf(target, candidate, null));
  const ssoProfile = ssoProfileOf(target, candidate, session.data);
  const live = session.isSuccess && !session.isFetching;
  return { settings, update, settingsReady, ctx, info, chosen, missing, candidate, session, ssoProfile, live };
}
