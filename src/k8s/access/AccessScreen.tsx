import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { K8sError } from "../K8sError";
import { can } from "../can";
import { useK8sRules } from "../queries";
import type { K8sTarget } from "../types";
import { IdentitiesTab } from "./IdentitiesTab";
import { MatrixTab } from "./MatrixTab";
import { WhoCanTab } from "./WhoCanTab";
import { WorkloadIdentityTab } from "./WorkloadIdentityTab";
import { accessApi } from "./api";
import { accessKeys, useAccess } from "./queries";
import { ACCESS_LABEL, LOADING, MY_PERMISSIONS, MY_PERMISSIONS_TITLE, RBAC_MISSING, REFRESH, SCOPE_NOTE, SCOPE_NOTE_DETAIL, TABS_LABEL, TAB_IDENTITIES, TAB_MATRIX, TAB_WHO_CAN, TAB_WORKLOAD } from "./text";
import type { Subject } from "./types";

export type AccessTab = "identities" | "matrix" | "whoCan" | "workload";

const TABS: { id: AccessTab; label: string }[] = [
  { id: "identities", label: TAB_IDENTITIES },
  { id: "matrix", label: TAB_MATRIX },
  { id: "whoCan", label: TAB_WHO_CAN },
  { id: "workload", label: TAB_WORKLOAD },
];

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  /** TopBar에서 고른 네임스페이스(모든 네임스페이스면 null) */
  namespace: string | null;
  /** 역할 ARN을 IAM 작업 공간에서 연다 */
  onOpenIam?: (arn: string) => void;
  /** 내 권한(MyRules) 화면으로 간다 */
  onOpenMyRules: () => void;
}

/** 접근: 신원 / 권한 표 / 누가 할 수 있나 / 워크로드 신원. 읽기만 한다. */
export function AccessScreen({ target, context, ssoProfile, live, namespace, onOpenIam, onOpenMyRules }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<AccessTab>("identities");
  const [focus, setFocus] = useState("");
  const access = useAccess(target, context, ssoProfile, live);
  // SubjectAccessReview를 만들 수 있는 신원인지(규칙 목록으로 확인한 것. 불완전하면 unknown이라 단추를 켜 두고 서버 판단에 맡긴다)
  const rules = useK8sRules(target, context, "default", ssoProfile, live && tab === "whoCan");
  const canReview = rules.data ? can(rules.data, { verb: "create", group: "authorization.k8s.io", resource: "subjectaccessreviews" }) : "unknown";
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const view = await accessApi.access(target, true);
      qc.removeQueries({ queryKey: accessKeys.root(target, context) });
      qc.setQueryData(accessKeys.view(target, context), view);
    } catch {
      // 오류는 다음 읽기가 보인다
      void qc.invalidateQueries({ queryKey: accessKeys.root(target, context) });
    } finally {
      setRefreshing(false);
    }
  };
  const openSubject = (s: Subject) => {
    setFocus(s.name);
    setTab("matrix");
  };

  return (
    <div className="acc">
      <div className="acc-head">
        <div role="tablist" aria-label={TABS_LABEL} className="k8s-tabs">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="acc-head-actions k8s-actions">
          <button className="btn small tone-secondary" title={MY_PERMISSIONS_TITLE} onClick={onOpenMyRules}>
            {MY_PERMISSIONS}
          </button>
          <button className="btn small tone-secondary" disabled={refreshing} onClick={() => void refresh()}>
            {REFRESH}
          </button>
        </div>
      </div>
      <p className="acc-note dim" role="note" aria-label={ACCESS_LABEL}>
        {SCOPE_NOTE}. <span>{SCOPE_NOTE_DETAIL}</span>
      </p>
      <div className="acc-body">
        {tab === "workload" ? (
          <WorkloadIdentityTab target={target} context={context} ssoProfile={ssoProfile} live={live} onOpenIam={onOpenIam} />
        ) : access.isError ? (
          <K8sError error={access.error} target={target} ssoProfile={ssoProfile} />
        ) : !access.data ? (
          <div className="empty">{LOADING}</div>
        ) : (
          <>
            {tab !== "identities" && !access.data.rbacAvailable && <p className="err">{RBAC_MISSING}</p>}
            {tab === "identities" && (
              <IdentitiesTab target={target} ssoProfile={ssoProfile} view={access.data} onRetry={() => void refresh()} onOpenIam={onOpenIam} onOpenSubject={openSubject} />
            )}
            {tab === "matrix" && (
              <MatrixTab target={target} context={context} ssoProfile={ssoProfile} live={live} view={access.data} namespace={namespace} initialText={focus} onOpenIam={onOpenIam} />
            )}
            {tab === "whoCan" && (
              <WhoCanTab target={target} context={context} ssoProfile={ssoProfile} namespaces={access.data.namespaces} canReview={canReview} onOpenIam={onOpenIam} initial={{ verb: "get", resource: "secrets", namespace: namespace }} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
