import { useEffect, useMemo, useState } from "react";
import { groupColumns, policyColumns, type AssignmentTab, type DraftItem } from "./assignments";
import { AssignmentGrid } from "./AssignmentGrid";
import { KIND_LABEL } from "./labels";
import { MatchSheet } from "./MatchSheet";
import { PolicyPicker } from "./PolicyPicker";
import type { IamRoute } from "./route";
import type { IamChange, IamOverview, PrincipalKind, PrincipalSummary } from "./types";
import type { useAssignmentDraft } from "./useAssignmentDraft";

type Draft = ReturnType<typeof useAssignmentDraft>;

interface Props {
  profile: string;
  overview: IamOverview;
  /** 장바구니. IAM 탭이 들고 있어서 이 화면을 떠났다 돌아와도 남는다 */
  draft: Draft;
  /** 열 추가로 더한 정책의 ARN. 장바구니처럼 IAM 탭이 프로필마다 들고 있어서 이 화면을 떠났다 돌아와도 남는다 */
  extra: string[];
  onAddColumn: (arn: string) => void;
  tab: AssignmentTab;
  onTab: (tab: AssignmentTab) => void;
  onOpen: (route: IamRoute) => void;
  /** [미리보기]: 담긴 변경을 담긴 순서대로 넘긴다 */
  onPreview: (changes: IamChange[]) => void;
  /** 툴바 필터. 행 이름에 적용한다 */
  filter: string;
}

const TABS: { id: AssignmentTab; label: string }[] = [
  { id: "policies", label: "정책" },
  { id: "members", label: "그룹 구성원" },
];
const KINDS: PrincipalKind[] = ["user", "group", "role"];

const byName = (a: PrincipalSummary, b: PrincipalSummary) => a.name.localeCompare(b.name, "ko", { sensitivity: "base" });

/** 탭에 나올 수 있는 주체를 보여 줄 순서대로: 정책 탭은 사용자·그룹·역할, 그룹 구성원 탭은 사용자 */
function principalsOf(ov: IamOverview, tab: AssignmentTab): PrincipalSummary[] {
  const sorted = (list: PrincipalSummary[]) => [...list].sort(byName);
  return tab === "policies" ? [...sorted(ov.users), ...sorted(ov.groups), ...sorted(ov.roles)] : sorted(ov.users);
}

/** 장바구니 요약: 변경 N개 · 첫 변경 (외 N-1개) */
const summaryOf = (items: DraftItem[]) => (items.length === 1 ? `변경 1개 · ${items[0].label}` : `변경 ${items.length}개 · ${items[0].label} 외 ${items.length - 1}개`);

/**
 * 할당 화면: 정책 탭과 그룹 구성원 탭의 표, 그 아래 장바구니 막대.
 * 파일 이름이 Assignments.tsx가 아닌 이유: assignments.ts(순수 로직)와 대소문자만 다르면, 대소문자를 가리지 않는
 * 파일 시스템(macOS)에서 "./Assignments"가 그 파일로 풀려 버린다.
 */
export function Assignments({ profile, overview, draft, extra, onAddColumn, tab, onTab, onOpen, onPreview, filter }: Props) {
  const [kinds, setKinds] = useState<Record<PrincipalKind, boolean>>({ user: true, group: true, role: true });
  const [adding, setAdding] = useState(false);
  const [matching, setMatching] = useState<PrincipalSummary | null>(null);
  const [expanded, setExpanded] = useState(false);

  const pool = useMemo(() => principalsOf(overview, tab), [overview, tab]);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return pool.filter((p) => (tab === "members" || kinds[p.kind]) && (!f || p.name.toLowerCase().includes(f)));
  }, [pool, tab, kinds, filter]);

  // 장바구니에 붙이기가 담긴 정책은 열로 더한 적이 없어도 표에 보인다(개요를 다시 읽어 그 정책을 가진 주체가 없어져도 담긴 변경이 안 보이면 안 된다)
  const queued = useMemo(() => draft.items.flatMap((d) => (d.change.op === "attachPolicy" ? [d.change.policyArn] : [])), [draft.items]);
  const columns = useMemo(() => (tab === "policies" ? policyColumns(overview, [...extra, ...queued]) : groupColumns(overview)), [overview, tab, extra, queued]);
  const shown = useMemo(() => columns.map((c) => c.id), [columns]);

  // 장바구니가 비면 목록은 접힌 채로 돌아온다
  useEffect(() => {
    if (draft.items.length === 0) setExpanded(false);
  }, [draft.items.length]);

  return (
    <section className="center iam-asg">
      <div className="iam-tabs" role="tablist" aria-label="할당 종류">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} className={`iam-tab${t.id === tab ? " on" : ""}`} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "policies" && (
        <div className="asg-bar">
          <div className="asg-chips" role="group" aria-label="종류">
            {KINDS.map((kind) => (
              <label key={kind} className={`asg-chip${kinds[kind] ? " on" : ""}`}>
                <input type="checkbox" checked={kinds[kind]} onChange={() => setKinds((k) => ({ ...k, [kind]: !k[kind] }))} />
                {KIND_LABEL[kind]}
              </label>
            ))}
          </div>
          <button className="btn small" onClick={() => setAdding(true)}>
            열 추가
          </button>
        </div>
      )}
      {draft.notices.map((text, i) => (
        <div key={`${i}-${text}`} className="notice asg-notice" role="status">
          <span>{text}</span>
          <button className="icon" aria-label="안내 닫기" onClick={() => draft.dismissNotice(i)}>
            ✕
          </button>
        </div>
      ))}
      <AssignmentGrid overview={overview} tab={tab} rows={rows} columns={columns} draft={draft} grouped={tab === "policies"} onOpen={onOpen} onMatch={setMatching} />
      {draft.items.length > 0 && (
        <div className="asg-tray">
          {expanded && (
            <ul className="asg-tray-list" aria-label="담긴 변경">
              {draft.items.map((d) => (
                <li key={d.key}>
                  <span>{d.label}</span>
                  <button className="icon" aria-label={`${d.label} 취소`} onClick={() => draft.remove(d.key)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="asg-tray-bar">
            <button className="asg-tray-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              <span>{summaryOf(draft.items)}</span>
            </button>
            <button className="btn small" onClick={draft.clear}>
              모두 취소
            </button>
            <button className="btn small primary" onClick={() => onPreview(draft.items.map((d) => d.change))}>
              미리보기
            </button>
          </div>
        </div>
      )}
      {adding && (
        <PolicyPicker
          profile={profile}
          title="열 추가"
          attachedArns={shown}
          disabledReason="이미 열에 있어요"
          onClose={() => setAdding(false)}
          onPick={(policy) => {
            onAddColumn(policy.arn);
            setAdding(false);
          }}
        />
      )}
      {matching && (
        <MatchSheet
          overview={overview}
          tab={tab}
          target={matching}
          candidates={pool}
          onClose={() => setMatching(null)}
          onApply={(add, remove) => {
            draft.match(tab, matching, add, remove);
            setMatching(null);
          }}
        />
      )}
    </section>
  );
}
