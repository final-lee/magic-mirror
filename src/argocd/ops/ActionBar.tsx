import { useMemo, useState, type ReactNode } from "react";
import { useArgoCan } from "../can";
import { FormSheet } from "../change/FormSheet";
import { CHANGE_DENIED } from "../change/text";
import type { ArgoChange, ArgoTarget } from "../change/types";
import { SyncForm } from "../change/SyncForm";
import { useAppHistory } from "../detail/queries";
import { DeletePane } from "../manage/DeletePane";
import { ARGO_HARD_REFRESH, ARGO_REFRESH, ARGO_SYNC, ARGO_SYNC_RUNNING } from "../text";
import type { ArgoApp } from "../types";
import { BatchForm } from "./BatchForm";
import { RollbackForm } from "./RollbackForm";
import { useAppActions } from "./queries";
import {
  APP_DELETE, AUTO_SYNC_OFF, AUTO_SYNC_ON, BAR_DANGER, BAR_DEPLOY, BAR_LABEL, BAR_SYNC, BAR_WORKLOADS, ROLLBACK_NO_PREVIOUS, ROLLBACK_PREVIOUS, ROLLBACK_RUNNING, TERMINATE, actionLabel, batchButton,
} from "./text";
import type { AppActionGroup } from "./types";
import { actionTone } from "./tone";

interface Props {
  url: string;
  app: ArgoApp;
  /** 쓰기 요청의 대상(환경 포함). 권한도 이 앱 기준으로 묻는다 */
  target: ArgoTarget;
  /** 앱의 resourceVersion(바뀌면 이력·액션·diff를 다시 읽는다) */
  version: string | null;
  /** 새로고침 요청 중(버튼을 잠근다) */
  pending: boolean;
  now?: number;
  /** 새로고침은 미리 보기 없이 바로 보낸다 */
  onRefresh: (hard: boolean) => void;
  /** 나머지 쓰기는 변경 시트(미리 보기 → 확인)로 넘긴다 */
  onChange: (change: ArgoChange) => void;
}

type Form = { kind: "sync" } | { kind: "rollback" } | { kind: "batch"; group: AppActionGroup } | { kind: "delete" };

/** 한 줄에 묶어 보이는 버튼 모음 */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="argo-bar-group">
      <span className="dim argo-bar-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * 앱 상세 맨 위의 작업 줄: 어느 탭에서나 보인다. 동기화(Sync·Refresh·작업 중단), 배포(이전 버전 롤백·자동 동기화),
 * 워크로드(앱의 리소스에서 서버가 허용하는 액션을 종류별로 묶어 한 번에), 위험(앱 삭제). 권한이 없으면 끄고 이유를 툴팁에 둔다.
 */
export function ActionBar({ url, app, target, version, pending, now, onRefresh, onChange }: Props) {
  const read = useMemo(() => ({ namespace: target.namespace, name: target.name, project: target.project }), [target]);
  const actions = useAppActions(url, read, version);
  const groups = actions.data ?? [];
  const history = useAppHistory(url, app.namespace, app.name, version, true);
  // 리소스 액션 권한(`action/<group>/<kind>/<action>`)은 can-i 경로에 담을 수 없어 admin에게도 "no"가 나온다.
  // ArgoCD 웹 UI처럼 미리 묻지 않고, 서버가 액션 목록에서 준 실행 가능 여부와 적용 때의 서버 검사에 맡긴다.
  const can = useArgoCan(url, target, ["get", "sync", "update", "delete"]);
  const [form, setForm] = useState<Form | null>(null);

  const allowed = (i: number) => can.data?.[i] === true;
  const denied = (i: number) => (can.data?.[i] === false ? CHANGE_DENIED : undefined);
  const running = app.operationInProgress;
  const auto = app.syncPolicy.automated;
  // 최신이 먼저가 아닐 수도 있어 id로 정렬해 바로 앞 배포를 고른다
  const entries = [...(history.data ?? [])].sort((a, b) => b.id - a.id);
  const [latest, previous] = entries;
  const rollbackReason = running ? ROLLBACK_RUNNING : (denied(1) ?? (previous ? undefined : ROLLBACK_NO_PREVIOUS));
  const send = (change: ArgoChange) => {
    setForm(null);
    onChange(change);
  };

  return (
    <div className="argo-bar-actions" role="toolbar" aria-label={BAR_LABEL}>
      <Group label={BAR_SYNC}>
        <button className="btn small tone-primary" disabled={pending || running || !allowed(1)} title={running ? ARGO_SYNC_RUNNING : denied(1)} onClick={() => setForm({ kind: "sync" })}>
          {ARGO_SYNC}
        </button>
        <button className="btn small tone-refresh" disabled={pending || !allowed(0)} title={denied(0)} onClick={() => onRefresh(false)}>
          {ARGO_REFRESH}
        </button>
        <button className="btn small tone-refresh" disabled={pending || !allowed(0)} title={denied(0)} onClick={() => onRefresh(true)}>
          {ARGO_HARD_REFRESH}
        </button>
        {running && (
          <button className="btn small tone-caution" disabled={pending || !allowed(1)} title={denied(1)} onClick={() => onChange({ kind: "terminate" })}>
            {TERMINATE}
          </button>
        )}
      </Group>
      <Group label={BAR_DEPLOY}>
        <button
          className="btn small tone-warn"
          disabled={!allowed(2)}
          title={denied(2)}
          onClick={() => onChange({ kind: "appPatch", patch: { spec: { syncPolicy: { automated: auto ? null : { prune: false, selfHeal: false } } } } })}
        >
          {auto ? AUTO_SYNC_OFF : AUTO_SYNC_ON}
        </button>
        <button className="btn small tone-caution" disabled={!!rollbackReason || !allowed(1)} title={rollbackReason} onClick={() => setForm({ kind: "rollback" })}>
          {ROLLBACK_PREVIOUS}
        </button>
      </Group>
      {groups.length > 0 && (
        <Group label={BAR_WORKLOADS}>
          {groups.map((g, i) => {
            const eligible = g.resources.length - g.disabledCount;
            const label = actionLabel(g.action, g.displayName);
            return (
              <button
                key={`${g.group}/${g.kind}/${g.action}`}
                className={`btn small ${actionTone(g.action)}`}
                disabled={eligible === 0}
                title={eligible === 0 ? `${g.kind}: 지금은 실행할 수 있는 리소스가 없어요` : undefined}
                onClick={() => setForm({ kind: "batch", group: g })}
              >
                {batchButton(label, g.kind, g.resources.length)}
              </button>
            );
          })}
        </Group>
      )}
      <Group label={BAR_DANGER}>
        <button className="btn small tone-danger" disabled={!allowed(3)} title={denied(3)} onClick={() => setForm({ kind: "delete" })}>
          {APP_DELETE}
        </button>
      </Group>

      {form?.kind === "sync" && <SyncForm url={url} app={app} version={version} onCancel={() => setForm(null)} onPreview={send} />}
      {form?.kind === "rollback" && latest && previous && (
        <RollbackForm url={url} namespace={app.namespace} name={app.name} entry={previous} current={latest} autoSync={auto} now={now} onCancel={() => setForm(null)} onPreview={send} />
      )}
      {form?.kind === "batch" && <BatchForm group={form.group} onCancel={() => setForm(null)} onPreview={send} />}
      {form?.kind === "delete" && (
        <FormSheet label={APP_DELETE} onCancel={() => setForm(null)}>
          <DeletePane onPreview={send} />
        </FormSheet>
      )}
    </div>
  );
}
