import { useState } from "react";
import { useArgoCan } from "../can";
import { ChangeSheet } from "../change/ChangeSheet";
import type { ArgoChange, ArgoTarget } from "../change/types";
import type { ArgoApp } from "../types";
import { DeletePane } from "./DeletePane";
import { NotificationsPane } from "./NotificationsPane";
import { SpecFormPane } from "./SpecFormPane";
import { YamlEditPane } from "./YamlEditPane";
import type { Obj } from "./specForm";
import { MANAGE_DENIED, MANAGE_VIEW_DELETE, MANAGE_VIEW_FORM, MANAGE_VIEW_LABEL, MANAGE_VIEW_NOTIFY, MANAGE_VIEW_YAML } from "./text";

type View = "form" | "yaml" | "notify" | "delete";

const VIEWS: [View, string][] = [
  ["form", MANAGE_VIEW_FORM],
  ["yaml", MANAGE_VIEW_YAML],
  ["notify", MANAGE_VIEW_NOTIFY],
  ["delete", MANAGE_VIEW_DELETE],
];

interface Props {
  url: string;
  app: ArgoApp;
  /** 쓰기 대상(네임스페이스·이름·프로젝트·환경) */
  target: ArgoTarget;
  /** 변경이 적용됐을 때(결과 메시지) */
  onDone: (message: string) => void;
  /** 앱을 지웠을 때: 상세를 닫는다 */
  onDeleted: () => void;
}

interface RawApp {
  metadata?: { annotations?: Record<string, string>; resourceVersion?: string };
  spec?: Obj;
}

/** 앱 관리 탭: 설정 바꾸기(폼)·YAML 편집·알림 구독·앱 삭제. 모든 쓰기는 변경 미리 보기(ChangeSheet)를 거친다 */
export function ManageTab({ url, app, target, onDone, onDeleted }: Props) {
  const [view, setView] = useState<View>("form");
  const [change, setChange] = useState<ArgoChange | null>(null);
  const can = useArgoCan(url, target, ["update", "delete"]);
  const raw = app.raw as RawApp;
  const spec = raw.spec ?? {};
  const [revision, setRevision] = useState(0);
  const cannotUpdate = can.data?.[0] === false;
  const cannotDelete = can.data?.[1] === false;
  const update = { disabled: cannotUpdate, disabledReason: MANAGE_DENIED };

  return (
    <div className="mg">
      <div role="tablist" className="mg-views" aria-label={MANAGE_VIEW_LABEL}>
        {VIEWS.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>
      <div hidden={view !== "form"}>
        <SpecFormPane key={revision} spec={spec} onPreview={(patch) => setChange({ kind: "appPatch", patch })} {...update} />
      </div>
      <div hidden={view !== "yaml"}>
        <YamlEditPane key={revision} spec={spec} onPreview={(yaml) => setChange({ kind: "appSpec", yaml })} {...update} />
      </div>
      <div hidden={view !== "notify"}>
        <NotificationsPane url={url} annotations={raw.metadata?.annotations} onPatch={(patch) => setChange({ kind: "appPatch", patch })} {...update} />
      </div>
      <div hidden={view !== "delete"}>
        <DeletePane onPreview={setChange} disabled={cannotDelete} disabledReason={MANAGE_DENIED} />
      </div>
      {change && (
        <ChangeSheet
          url={url}
          target={target}
          change={change}
          onClose={() => setChange(null)}
          onDone={(message) => {
            const deleted = change.kind === "appDelete";
            if (!deleted) setRevision((value) => value + 1);
            setChange(null);
            onDone(message);
            if (deleted) onDeleted();
          }}
        />
      )}
    </div>
  );
}
