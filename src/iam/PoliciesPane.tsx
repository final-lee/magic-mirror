import { Fragment, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { BadgeList } from "./Badges";
import { prettyJson } from "./format";
import { PolicyEditor } from "./PolicyEditor";
import { SCOPE_LABEL } from "./PolicyList";
import { PolicyPicker } from "./PolicyPicker";
import { changeBlockReason } from "./protect";
import { usePolicy } from "./queries";
import { policyRoute, principalRoute, type IamRoute } from "./route";
import type { AttachedPolicy, IamChange, IamOverview, PrincipalSummary } from "./types";
import type { StartOptions } from "./useIamChange";

interface Props {
  profile: string;
  /** 정책을 붙이고 떼는 대상 */
  summary: PrincipalSummary;
  policies: AttachedPolicy[];
  /** 상속한 그룹 이름을 그룹 상세로 연결하는 데 쓴다 */
  overview: IamOverview;
  onOpen: (route: IamRoute) => void;
  /** 변경을 변경 흐름(미리보기 → 확인 → 적용)에 넘긴다. onApplied는 적용에 성공하면 불린다 */
  onFix: (change: IamChange, opts?: StartOptions) => void;
}

const POLICY_SECTIONS: { id: string; label: string; match: (p: AttachedPolicy) => boolean }[] = [
  { id: "direct", label: "직접 연결", match: (p) => p.kind === "managed" && !p.via },
  { id: "inherited", label: "그룹에서 상속", match: (p) => !!p.via },
  { id: "inline", label: "인라인", match: (p) => p.kind === "inline" && !p.via },
  { id: "boundary", label: "권한 경계", match: (p) => p.kind === "boundary" },
];

function policyType(p: AttachedPolicy): string {
  if (p.kind === "inline") return "인라인";
  if (p.kind === "boundary") return "권한 경계";
  return p.scope ? SCOPE_LABEL[p.scope] : "관리형";
}

type Editor = { mode: "new" } | { mode: "edit"; policy: AttachedPolicy } | null;

/**
 * 정책 탭: 직접 / 그룹 상속 / 인라인 / 권한 경계 목록과 변경 버튼.
 * 직접 붙은 관리형은 [떼기], 인라인은 [편집] [삭제], 그룹에서 상속한 정책은 그 그룹에서 떼라는 안내만 있고,
 * 권한 경계는 바꾸지 않는다. 서비스 연결·Identity Center 역할은 버튼이 꺼진다(백엔드도 막는다).
 */
export function PoliciesPane({ profile, summary, policies, overview, onOpen, onFix }: Props) {
  const [picking, setPicking] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const blocked = changeBlockReason(summary);
  const closeEditor = () => setEditor(null);
  const ownInline = policies.filter((p) => p.kind === "inline" && !p.via);

  if (editor?.mode === "new") {
    return (
      <PolicyEditor
        profile={profile}
        mode="new"
        title="인라인 정책 추가"
        existingNames={ownInline.map((p) => p.name)}
        onCancel={closeEditor}
        onSubmit={(name, document) => onFix({ op: "putInlinePolicy", target: summary.arn, name, document }, { onApplied: closeEditor })}
      />
    );
  }
  if (editor?.mode === "edit") {
    return <InlineEditor profile={profile} summary={summary} policy={editor.policy} onFix={onFix} onClose={closeEditor} />;
  }

  // 한 정책은 처음 맞는 구역에만 나온다
  const taken = new Set<AttachedPolicy>();
  const sections = POLICY_SECTIONS.map((sec) => {
    const rows = policies.filter((p) => !taken.has(p) && sec.match(p));
    rows.forEach((p) => taken.add(p));
    return { ...sec, rows };
  }).filter((sec) => sec.rows.length > 0);

  return (
    <>
      <div className="pol-bar">
        <button className="btn small" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setPicking(true)}>
          정책 붙이기
        </button>
        <button className="btn small" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setEditor({ mode: "new" })}>
          인라인 정책 추가
        </button>
        {blocked && (
          <span className="dim pol-why">
            <span aria-hidden="true">ⓘ</span> {blocked}
          </span>
        )}
      </div>
      {policies.length === 0 ? (
        <div className="empty small">붙은 정책이 없어요</div>
      ) : (
        <table className="iam-policies" aria-label="붙은 정책">
          <tbody>
            {sections.map((sec) => (
              <Fragment key={sec.id}>
                <tr className="sec">
                  <th colSpan={5}>
                    {sec.label} <span className="dim">{sec.rows.length}</span>
                  </th>
                </tr>
                {sec.rows.map((p) => {
                  const group = p.via ? overview.groups.find((g) => g.name === p.via) : undefined;
                  return (
                    <tr key={`${p.id}|${p.via ?? ""}`}>
                      <td>
                        <button className="link" onClick={() => onOpen(policyRoute(p.id))}>
                          {p.name}
                        </button>
                      </td>
                      <td>
                        <span className="iam-chip">{policyType(p)}</span>
                      </td>
                      <td>
                        {p.via && (
                          <span className="dim">
                            그룹{" "}
                            {group ? (
                              <button className="link" onClick={() => onOpen(principalRoute("group", group.arn))}>
                                {p.via}
                              </button>
                            ) : (
                              p.via
                            )}
                            에서 상속
                          </span>
                        )}
                      </td>
                      <td>
                        {/* 종류 칸이 이미 알려 주는 배지는 되풀이하지 않는다 */}
                        <BadgeList badges={p.badges} hide={["awsManaged", "boundary"]} />
                      </td>
                      <td className="pol-act">
                        <RowActions
                          p={p}
                          blocked={blocked}
                          onEdit={() => setEditor({ mode: "edit", policy: p })}
                          onChange={(change) => onFix(change)}
                          target={summary.arn}
                        />
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {picking && (
        <PolicyPicker
          profile={profile}
          targetName={summary.name}
          attachedArns={policies.filter((p) => p.kind === "managed" && !p.via).map((p) => p.id)}
          onClose={() => setPicking(false)}
          onPick={(policy) => {
            setPicking(false);
            onFix({ op: "attachPolicy", target: summary.arn, policyArn: policy.arn });
          }}
        />
      )}
    </>
  );
}

function RowActions({ p, target, blocked, onEdit, onChange }: { p: AttachedPolicy; target: string; blocked: string | null; onEdit: () => void; onChange: (c: IamChange) => void }) {
  const off = { disabled: !!blocked, title: blocked ?? undefined };
  if (p.via) {
    // 상속한 정책은 이 주체에서 떼거나 지울 수 없다. 그 그룹에서 해야 한다.
    return (
      <span className="dim">
        그룹 {p.via}에서 {p.kind === "inline" ? "지워야" : "떼야"} 해요
      </span>
    );
  }
  if (p.kind === "inline") {
    return (
      <>
        <button className="btn small" aria-label={`${p.name} 편집`} {...off} onClick={onEdit}>
          편집
        </button>
        <button className="btn small danger" aria-label={`${p.name} 삭제`} {...off} onClick={() => onChange({ op: "deleteInlinePolicy", target, name: p.name })}>
          삭제
        </button>
      </>
    );
  }
  // detachable은 백엔드가 "주체에 직접 붙은 관리형 정책"일 때만 true로 준다. 권한 경계는 바꾸지 않는다.
  if (p.kind === "managed" && p.detachable) {
    return (
      <button className="btn small" aria-label={`${p.name} 떼기`} {...off} onClick={() => onChange({ op: "detachPolicy", target, policyArn: p.id })}>
        떼기
      </button>
    );
  }
  return null;
}

/** 인라인 정책 편집: 문서를 읽어 온 뒤에 편집기를 연다. */
function InlineEditor({ profile, summary, policy, onFix, onClose }: { profile: string; summary: PrincipalSummary; policy: AttachedPolicy; onFix: Props["onFix"]; onClose: () => void }) {
  const q = usePolicy(profile, policy.id);
  if (!q.data) {
    return (
      <div className="pe-wait">
        {q.isError ? <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty small">불러오는 중…</div>}
        <div className="pe-actions">
          <button className="btn plain" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    );
  }
  return (
    <PolicyEditor
      profile={profile}
      mode="edit"
      name={policy.name}
      title={`인라인 정책 편집 · ${policy.name}`}
      document={prettyJson(q.data.document)}
      onCancel={onClose}
      onSubmit={(name, document) => onFix({ op: "putInlinePolicy", target: summary.arn, name, document }, { onApplied: onClose })}
    />
  );
}
