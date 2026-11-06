import { useMemo, useState } from "react";
import { useNotificationCatalog } from "./queries";
import { addSubscription, removeSubscription, subscriptionsOf, type Subscription } from "./notifications";
import {
  MANAGE_NOTIFY_ADD, MANAGE_NOTIFY_EDIT, MANAGE_NOTIFY_HINT, MANAGE_NOTIFY_NONE, MANAGE_NOTIFY_RECIPIENTS, MANAGE_NOTIFY_SERVICE, MANAGE_NOTIFY_TITLE, MANAGE_NOTIFY_TRIGGER,
  MANAGE_NOTIFY_UNAVAILABLE, MANAGE_REMOVE,
} from "./text";

interface Props {
  url: string;
  /** 앱의 metadata.annotations */
  annotations: Record<string, string> | undefined;
  /** 구독을 더하거나 지우는 appPatch의 patch로 미리 보기를 연다 */
  onPatch: (patch: unknown) => void;
  disabled?: boolean;
  disabledReason?: string;
}

/** 앱의 알림 구독(annotation)을 보고 더하고 지운다. 서버의 트리거·서비스 이름은 입력 후보로 보인다 */
export function NotificationsPane({ url, annotations, onPatch, disabled, disabledReason }: Props) {
  const catalog = useNotificationCatalog(url);
  const triggers = catalog.data?.triggers;
  const subscriptions = useMemo(() => subscriptionsOf(annotations, triggers), [annotations, triggers]);
  const [trigger, setTrigger] = useState("");
  const [service, setService] = useState("");
  const [recipients, setRecipients] = useState("");
  const [editing, setEditing] = useState(false);
  const complete = trigger.trim() !== "" && service.trim() !== "" && recipients.trim() !== "" && !trigger.includes(" ") && !service.includes(" ");

  const edit = (s: Subscription) => {
    setTrigger(s.trigger);
    setService(s.service);
    setRecipients(s.recipients);
    setEditing(true);
  };

  return (
    <div className="mg-form">
      <section className="k8s-sect" aria-label={MANAGE_NOTIFY_TITLE}>
        <h4>{MANAGE_NOTIFY_TITLE}</h4>
        <p className="dim">{MANAGE_NOTIFY_HINT}</p>
        {catalog.isError && <p className="dim">{MANAGE_NOTIFY_UNAVAILABLE}</p>}
        {subscriptions.length === 0 ? (
          <p className="dim">{MANAGE_NOTIFY_NONE}</p>
        ) : (
          <table className="k8s-table">
            <thead>
              <tr>
                <th>{MANAGE_NOTIFY_TRIGGER}</th>
                <th>{MANAGE_NOTIFY_SERVICE}</th>
                <th>{MANAGE_NOTIFY_RECIPIENTS}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.key}>
                  <td className="mono">{s.trigger}</td>
                  <td className="mono">{s.service}</td>
                  <td className="mono k8s-wrap">{s.recipients}</td>
                  <td className="mg-acts">
                    <button className="btn small tone-secondary" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => edit(s)}>
                      {MANAGE_NOTIFY_EDIT}
                    </button>
                    <button className="btn small tone-danger" disabled={disabled} title={disabled ? disabledReason : undefined} aria-label={`${s.trigger} ${s.service} ${MANAGE_REMOVE}`} onClick={() => onPatch(removeSubscription(s.key))}>
                      {MANAGE_REMOVE}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mg-row">
          <input aria-label={MANAGE_NOTIFY_TRIGGER} placeholder={MANAGE_NOTIFY_TRIGGER} list="mg-triggers" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
          <input aria-label={MANAGE_NOTIFY_SERVICE} placeholder={MANAGE_NOTIFY_SERVICE} list="mg-services" value={service} onChange={(e) => setService(e.target.value)} />
          <input aria-label={MANAGE_NOTIFY_RECIPIENTS} placeholder={MANAGE_NOTIFY_RECIPIENTS} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
          <button
            className="btn small tone-primary"
            disabled={disabled || !complete}
            title={disabled ? disabledReason : undefined}
            onClick={() => {
              onPatch(addSubscription(trigger.trim(), service.trim(), recipients));
              setEditing(false);
            }}
          >
            {editing ? MANAGE_NOTIFY_EDIT : MANAGE_NOTIFY_ADD}
          </button>
        </div>
        <datalist id="mg-triggers">{catalog.data?.triggers.map((t) => <option key={t} value={t} />)}</datalist>
        <datalist id="mg-services">{catalog.data?.services.map((s) => <option key={s} value={s} />)}</datalist>
      </section>
    </div>
  );
}
