/** 앱의 알림 구독은 `notifications.argoproj.io/subscribe.<트리거>.<서비스>: <받는 곳>` annotation이다 */
const PREFIX = "notifications.argoproj.io/subscribe.";

export interface Subscription {
  /** annotation 키 전체 */
  key: string;
  trigger: string;
  service: string;
  /** 받는 곳(여럿이면 `;`로 이은 값 그대로) */
  recipients: string;
}

export const subscriptionKey = (trigger: string, service: string) => `${PREFIX}${trigger}.${service}`;

/**
 * 앱 annotation에서 구독을 뽑는다. 트리거 이름에 점이 있을 수 있어, 서버 트리거 목록이 있으면 그중 가장 긴 것을 앞에서 맞추고
 * 없으면 첫 점에서 가른다.
 */
export function subscriptionsOf(annotations: Record<string, string> | null | undefined, triggers: string[] = []): Subscription[] {
  const found: Subscription[] = [];
  for (const [key, recipients] of Object.entries(annotations ?? {})) {
    if (!key.startsWith(PREFIX)) continue;
    const rest = key.slice(PREFIX.length);
    const known = triggers.filter((t) => rest.startsWith(`${t}.`)).sort((a, b) => b.length - a.length)[0];
    const dot = known ? known.length : rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) continue;
    found.push({ key, trigger: rest.slice(0, dot), service: rest.slice(dot + 1), recipients });
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

/** 구독을 더하거나(같은 키면 받는 곳을 바꾼다) 고치는 appPatch의 patch */
export const addSubscription = (trigger: string, service: string, recipients: string) => ({ metadata: { annotations: { [subscriptionKey(trigger, service)]: recipients.trim() } } });

/** 구독을 지우는 appPatch의 patch(병합 패치에서 null은 키 삭제) */
export const removeSubscription = (key: string) => ({ metadata: { annotations: { [key]: null } } });
