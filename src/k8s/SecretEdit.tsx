import { useLayoutEffect, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { targetKey } from "./targets";
import * as t from "./text";
import type { K8sSecretKey, K8sSecretValue, K8sTarget } from "./types";
import { MASK, type YamlObject } from "./yamlDocs";

export interface SecretEdits {
  /** 기존 키의 새 값(utf-8 글). 없는 키는 건드리지 않는다 */
  values: Record<string, string>;
  /** 새로 더하는 키 */
  extra: { key: string; value: string }[];
}

export const NO_SECRET_EDITS: SecretEdits = { values: {}, extra: [] };

/**
 * 편집한 YAML 객체에 Secret 값을 더한다. 고치지 않은 키는 가린 값(••••)으로 보내고 백엔드가 현재 값으로 되돌려 놓는다.
 * 고치거나 더한 값은 stringData로 보낸다(서버가 data로 바꿔 저장한다).
 */
export function withSecretValues(object: YamlObject, keys: K8sSecretKey[], edits: SecretEdits): YamlObject {
  const { data: _data, stringData: _stringData, ...rest } = object;
  const data: Record<string, string> = {};
  const stringData: Record<string, string> = {};
  for (const { key } of keys) {
    if (key in edits.values) stringData[key] = edits.values[key];
    else data[key] = MASK;
  }
  for (const { key, value } of edits.extra) stringData[key] = value;
  return {
    ...rest,
    ...(Object.keys(data).length > 0 ? { data } : {}),
    ...(Object.keys(stringData).length > 0 ? { stringData } : {}),
  };
}

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  name: string;
  keys: K8sSecretKey[];
  canRead: "yes" | "no" | "unknown";
  edits: SecretEdits;
  onEdits: (edits: SecretEdits) => void;
}

/** Secret 키별 편집. 값은 '값 보기'를 눌렀을 때만 읽어 이 컴포넌트 상태에 두고, 쿼리 캐시에는 넣지 않는다. */
export function SecretEdit({ target, ssoProfile, namespace, name, keys, canRead, edits, onEdits }: Props) {
  const identity = JSON.stringify([targetKey(target), namespace, name]);
  const [shown, setShown] = useState<Map<string, K8sSecretValue>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, unknown>>(() => new Map());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const generation = useRef(0);

  useLayoutEffect(() => {
    setShown(new Map());
    setErrors(new Map());
    setBusy(new Set());
    return () => {
      generation.current++;
    };
  }, [identity]);

  const reveal = async (key: string) => {
    const gen = generation.current;
    setBusy((s) => new Set(s).add(key));
    setErrors((s) => {
      const next = new Map(s);
      next.delete(key);
      return next;
    });
    try {
      const value = await k8sApi.secretValue(target, namespace, name, key, ssoProfile);
      if (generation.current === gen) setShown((s) => new Map(s).set(key, value));
    } catch (e) {
      if (generation.current === gen) setErrors((s) => new Map(s).set(key, e));
    } finally {
      if (generation.current === gen) {
        setBusy((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    }
  };
  const setValue = (key: string, text: string) => {
    const original = shown.get(key);
    if (original?.encoding === "utf8" && original.text === text) keep(key);
    else onEdits({ ...edits, values: { ...edits.values, [key]: text } });
  };
  const keep = (key: string) => {
    const { [key]: _removed, ...values } = edits.values;
    onEdits({ ...edits, values });
  };
  const known = new Set([...keys.map((k) => k.key), ...edits.extra.map((e) => e.key)]);
  const addable = newKey.trim() !== "" && !known.has(newKey.trim());
  const add = () => {
    onEdits({ ...edits, extra: [...edits.extra, { key: newKey.trim(), value: newValue }] });
    setNewKey("");
    setNewValue("");
  };

  return (
    <section className="k8s-sect">
      <h4>{t.SEC_SECRET_KEYS}</h4>
      <table className="k8s-table">
        <thead>
          <tr>
            <th>{t.H_KEY}</th>
            <th>{t.H_SIZE}</th>
            <th>{t.H_VALUE}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(({ key, size }) => {
            const value = shown.get(key);
            const editing = key in edits.values;
            const editable = editing || value?.encoding === "utf8";
            const gen = generation.current;
            const retry = () => {
              if (generation.current === gen) void reveal(key);
            };
            return (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td>{t.byteSize(size)}</td>
                <td>
                  {editable && (
                    <textarea
                      className="mono k8s-secret-input"
                      aria-label={t.SECRET_VALUE_LABEL(key)}
                      value={edits.values[key] ?? value?.text ?? ""}
                      onChange={(e) => setValue(key, e.target.value)}
                    />
                  )}
                  {!editable && value && (
                    <div className="k8s-secret">
                      <pre className="mono">{value.text}</pre>
                      <p className="dim">{t.SECRET_BINARY_NOTE}</p>
                    </div>
                  )}
                  {!value && !editing && (
                    <button className="btn tone-secondary" disabled={canRead === "no" || busy.has(key)} title={canRead === "no" ? t.NO_SECRET_PERMISSION : undefined} onClick={() => void reveal(key)}>
                      {t.SHOW_VALUE}
                    </button>
                  )}{" "}
                  {!editing && (
                    <button className="btn tone-secondary" onClick={() => onEdits({ ...edits, values: { ...edits.values, [key]: "" } })}>
                      {t.SECRET_NEW_VALUE}
                    </button>
                  )}
                  {editing && (
                    <button className="btn tone-ghost" onClick={() => keep(key)}>
                      {t.SECRET_KEEP}
                    </button>
                  )}
                  {errors.has(key) && <ErrorState error={errors.get(key)} profile={ssoProfile} compact onRetry={retry} onLoggedIn={retry} />}
                </td>
              </tr>
            );
          })}
          {edits.extra.map(({ key }) => (
            <tr key={`new:${key}`}>
              <td className="mono">{key}</td>
              <td />
              <td>
                <button className="btn tone-ghost" onClick={() => onEdits({ ...edits, extra: edits.extra.filter((e) => e.key !== key) })}>
                  {t.CHANGE_CANCEL}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="k8s-actions">
        <input aria-label={t.SECRET_NEW_KEY_NAME} placeholder={t.SECRET_NEW_KEY_NAME} value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <input aria-label={t.SECRET_NEW_KEY_VALUE} placeholder={t.SECRET_NEW_KEY_VALUE} value={newValue} onChange={(e) => setNewValue(e.target.value)} />
        <button className="btn tone-secondary" disabled={!addable} onClick={add}>
          {t.SECRET_ADD}
        </button>
      </div>
    </section>
  );
}
