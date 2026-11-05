import { useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { useArgoCan } from "../can";
import { ChangeSheet } from "../change/ChangeSheet";
import { CHANGE_DENIED } from "../change/text";
import type { ArgoChange, ArgoTarget } from "../change/types";
import { useTokenGuard } from "../detail/useTokenGuard";
import { LOADING } from "../text";
import type { AppTarget, ArgoApp, ContainerRef, ResRef } from "../types";
import { ActionForm } from "./ActionForm";
import { DeleteForm } from "./DeleteForm";
import { PatchForm } from "./PatchForm";
import { useResourceActions } from "./queries";
import { ShellSection } from "./ShellSection";
import { ACT_CHECKING, ACT_DISABLED, ACT_NONE, ACT_RUN, ACT_TITLE, DEL_OPEN, EDIT_TITLE, PATCH_OPEN, actRunLabel } from "./text";
import type { ResourceAction } from "./types";

interface Props {
  url: string;
  app: ArgoApp;
  /** 쓰기 요청의 대상(환경 포함). 권한도 이 앱 기준으로 묻는다 */
  target: ArgoTarget;
  /** 앱의 resourceVersion(액션 목록을 다시 읽는 기준) */
  version: string | null;
  res: ResRef;
  /** 로그·터미널을 고를 컨테이너(Pod일 때) */
  containers: ContainerRef[];
  onTokenError: (message: string) => void;
}

type Form = { kind: "action"; action: ResourceAction } | { kind: "patch" } | { kind: "delete" };

/** 서버가 정한 권한 값을 버튼 상태로: 확인이 끝나 true일 때만 켠다. false면 이유를 툴팁에 */
const gate = (allowed: boolean | undefined) => ({ disabled: allowed !== true, title: allowed === false ? CHANGE_DENIED : undefined });

/** 리소스에서 하는 쓰기: 서버가 준 액션 실행, 패치, 삭제, Pod 터미널 넘기기. 쓰기는 모두 변경 시트(미리 보기 → 확인)를 거친다. */
export function ActionsTab({ url, app, target, version, res, containers, onTokenError }: Props) {
  const read: AppTarget = { namespace: target.namespace, name: target.name, project: target.project };
  const actions = useResourceActions(url, read, res, version);
  const base = useArgoCan(url, target, ["update", "delete"]);
  const actionKeys = (actions.data ?? []).map((a) => `action/${res.group}/${res.kind}/${a.name}`);
  const actionCan = useArgoCan(url, actions.data ? target : null, actionKeys);
  useTokenGuard([actions.error, base.error, actionCan.error], onTokenError);
  const [form, setForm] = useState<Form | null>(null);
  const [change, setChange] = useState<ArgoChange | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const preview = (next: ArgoChange) => {
    setForm(null);
    setNote(null);
    setChange(next);
  };

  return (
    <div className="argo-ops">
      {note && (
        <p className="ok argo-note" role="status">
          {note}
        </p>
      )}
      <section aria-label={ACT_TITLE}>
        <h4>{ACT_TITLE}</h4>
        {actions.isError ? (
          <ErrorState error={actions.error} profile="" compact onRetry={() => void actions.refetch()} />
        ) : !actions.data ? (
          <div className="empty">{LOADING}</div>
        ) : actions.data.length === 0 ? (
          <p className="dim">{ACT_NONE}</p>
        ) : (
          <ul className="argo-actions">
            {actions.data.map((a, i) => {
              const allowed = gate(actionCan.data?.[i]);
              return (
                <li key={a.name}>
                  <span>{a.displayName ?? a.name}</span>
                  <button
                    className="btn small tone-secondary"
                    aria-label={actRunLabel(a.displayName ?? a.name)}
                    disabled={a.disabled || allowed.disabled}
                    title={a.disabled ? ACT_DISABLED : (allowed.title ?? (actionCan.data ? undefined : ACT_CHECKING))}
                    onClick={() => (a.params.length > 0 ? setForm({ kind: "action", action: a }) : preview({ kind: "resourceAction", res, action: a.name, params: [] }))}
                  >
                    {ACT_RUN}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-label={EDIT_TITLE}>
        <h4>{EDIT_TITLE}</h4>
        <div className="k8s-list-bar">
          <button className="btn small tone-secondary" {...gate(base.data?.[0])} onClick={() => setForm({ kind: "patch" })}>
            {PATCH_OPEN}
          </button>
          <button className="btn small tone-danger" {...gate(base.data?.[1])} onClick={() => setForm({ kind: "delete" })}>
            {DEL_OPEN}
          </button>
        </div>
      </section>
      {res.group === "" && res.kind === "Pod" && res.namespace && <ShellSection url={url} destination={app.destination} res={{ ...res, namespace: res.namespace }} containers={containers} />}
      {form?.kind === "action" && (
        <ActionForm action={form.action} onCancel={() => setForm(null)} onPreview={(params) => preview({ kind: "resourceAction", res, action: form.action.name, params })} />
      )}
      {form?.kind === "patch" && <PatchForm res={res} onCancel={() => setForm(null)} onPreview={({ patch, patchType }) => preview({ kind: "resourcePatch", res, patch, patchType })} />}
      {form?.kind === "delete" && <DeleteForm res={res} onCancel={() => setForm(null)} onPreview={({ force, orphan }) => preview({ kind: "resourceDelete", res, force, orphan })} />}
      {change && (
        <ChangeSheet
          url={url}
          target={target}
          change={change}
          onClose={() => setChange(null)}
          onDone={(message) => {
            setChange(null);
            setNote(message);
          }}
        />
      )}
    </div>
  );
}
