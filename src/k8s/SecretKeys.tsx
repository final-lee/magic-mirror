import { useLayoutEffect, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { targetKey } from "./targets";
import { BASE64_NOTE, H_KEY, H_SIZE, H_VALUE, HIDE_VALUE, NO_SECRET_PERMISSION, SEC_SECRET_KEYS, SHOW_VALUE, byteSize } from "./text";
import type { K8sSecretKey, K8sSecretValue, K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  name: string;
  keys: K8sSecretKey[];
  canRead: "yes" | "no" | "unknown";
}

/** Values are read on demand and kept only in this component's state. */
export function SecretKeys({ target, ssoProfile, namespace, name, keys, canRead }: Props) {
  const identity = JSON.stringify([targetKey(target), namespace, name]);
  const [shown, setShown] = useState<Map<string, K8sSecretValue>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, unknown>>(() => new Map());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const generation = useRef(0);

  useLayoutEffect(() => {
    setShown(new Map());
    setErrors(new Map());
    setBusy(new Set());
    return () => { generation.current++; };
  }, [identity]);

  const reveal = async (key: string) => {
    const gen = generation.current;
    setBusy((s) => new Set(s).add(key));
    setErrors((s) => { const next = new Map(s); next.delete(key); return next; });
    try {
      const value = await k8sApi.secretValue(target, namespace, name, key, ssoProfile);
      if (generation.current === gen) setShown((s) => new Map(s).set(key, value));
    } catch (e) {
      if (generation.current === gen) setErrors((s) => new Map(s).set(key, e));
    } finally {
      if (generation.current === gen) setBusy((s) => { const next = new Set(s); next.delete(key); return next; });
    }
  };
  const hide = (key: string) => setShown((s) => { const next = new Map(s); next.delete(key); return next; });

  return (
    <section className="k8s-sect">
      <h4>{SEC_SECRET_KEYS}</h4>
      <table className="k8s-table">
        <thead>
          <tr>
            <th>{H_KEY}</th>
            <th>{H_SIZE}</th>
            <th>{H_VALUE}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(({ key, size }) => {
            const value = shown.get(key);
            const gen = generation.current;
            const retry = () => { if (generation.current === gen) void reveal(key); };
            return (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td>{byteSize(size)}</td>
                <td>
                  {value ? (
                    <div className="k8s-secret">
                      <pre className="mono">{value.text}</pre>
                      {value.encoding === "base64" && <p className="dim">{BASE64_NOTE}</p>}
                      <button className="btn" onClick={() => hide(key)}>{HIDE_VALUE}</button>
                    </div>
                  ) : (
                    <button className="btn" disabled={canRead === "no" || busy.has(key)} title={canRead === "no" ? NO_SECRET_PERMISSION : undefined} onClick={() => void reveal(key)}>
                      {SHOW_VALUE}
                    </button>
                  )}
                  {errors.has(key) && <ErrorState error={errors.get(key)} profile={ssoProfile} compact onRetry={retry} onLoggedIn={retry} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
