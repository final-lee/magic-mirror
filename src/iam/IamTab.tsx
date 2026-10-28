import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { useHistoryKeys } from "../lib/useHistoryKeys";
import { Assignments } from "./AssignmentsScreen";
import { BatchPreviewDialog } from "./BatchPreviewDialog";
import { ChangeLog } from "./ChangeLog";
import { ChangePreviewDialog } from "./ChangePreviewDialog";
import { Findings } from "./Findings";
import { IamNav, type NavCounts } from "./IamNav";
import { PolicyDetail } from "./PolicyDetail";
import { PolicyList } from "./PolicyList";
import { PrincipalDetail } from "./PrincipalDetail";
import { PrincipalList } from "./PrincipalList";
import { refreshIam, useIamOverview } from "./queries";
import { policyNameFromId, policyRoute, principalRoute, routeForFocus, VIEW_LABEL, type IamRoute, type IamView } from "./route";
import type { IamOverview, PrincipalKind } from "./types";
import { useAddedColumns } from "./useAddedColumns";
import { useAssignmentDraft } from "./useAssignmentDraft";
import type { ApplyNotice } from "./useApplyFlow";
import { useIamBatch } from "./useIamBatch";
import { useIamChange } from "./useIamChange";
import { useIamHistory } from "./useIamHistory";
import { WhoCan } from "./WhoCan";

interface Props {
  profile: string;
  /** 이 탭이 보이는 탭일 때만 ⌘[ ⌘]와 마우스 뒤로/앞으로 버튼에 반응한다 */
  active: boolean;
  /** 툴바 필터. 목록 화면에 적용된다 */
  filter: string;
  /** 리소스 목록에서 넘어온 대상(사용자·역할·정책 ARN). nonce가 바뀔 때마다 그곳으로 이동한다 */
  focus: string | null;
  nonce: number;
}

// 처음 열면 보안 점검 화면
const HOME: IamRoute = { view: "findings" };

const KIND_OF_VIEW: Partial<Record<IamView, PrincipalKind>> = { users: "user", groups: "group", roles: "role" };

function listOf(ov: IamOverview, kind: PrincipalKind) {
  return kind === "user" ? ov.users : kind === "group" ? ov.groups : ov.roles;
}

/** 상세 화면의 이름(이동 경로에 쓴다). 스냅숏에 없으면 ID에서 뽑는다. */
function detailName(ov: IamOverview, route: IamRoute): string {
  const id = route.id ?? "";
  const kind = KIND_OF_VIEW[route.view];
  if (kind) return listOf(ov, kind).find((p) => p.arn === id)?.name ?? id.slice(id.lastIndexOf("/") + 1);
  return ov.policies.find((p) => p.id === id)?.name ?? policyNameFromId(id);
}

function listCount(ov: IamOverview, view: IamView): number | null {
  const kind = KIND_OF_VIEW[view];
  if (kind) return listOf(ov, kind).length;
  return view === "policies" ? ov.policies.length : null;
}

/** 적용을 마친 뒤의 안내 한 줄. 함께 알릴 일(notes)이 있으면 사용자가 닫을 때까지 남는다 */
function DoneNotice({ notice, onDismiss }: { notice: ApplyNotice; onDismiss: () => void }) {
  return (
    <div className="iam-done" role="status">
      <span aria-hidden="true">✓</span> <span>{notice.summary}</span> <span className="dim">반영까지 몇 초 걸릴 수 있어요</span>
      <button className="icon" aria-label="알림 닫기" onClick={onDismiss}>
        ✕
      </button>
      {/* 바꾸기는 했지만 하지 못한 일(변경 기록 저장 등). 이 안내는 닫을 때까지 남는다 */}
      {notice.notes.length > 0 && (
        <ul className="iam-done-notes" aria-label="함께 알릴 일">
          {/* 같은 안내가 여러 번 올 수 있고(되돌림 표시를 못 한 기록마다 같은 문구) 목록은 순서가 바뀌지 않아서, 글이 아니라 순서를 키로 쓴다 */}
          {notice.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IamTab({ profile, active, filter, focus, nonce }: Props) {
  const qc = useQueryClient();
  const overview = useIamOverview(profile);
  const ov = overview.data;
  const { route, canBack, canForward, navigate, replace, back, forward } = useIamHistory(HOME);
  // 모든 IAM 변경(버튼, 빠른 조치, 되돌리기)이 지나는 하나뿐인 길: 미리보기 → 확인 → 적용
  const change = useIamChange(profile);
  // 장바구니의 변경 여러 개와 변경 기록의 묶음 되돌리기가 지나는 길. 하나짜리 변경과 섞지 않는다.
  const batch = useIamBatch(profile);
  // 할당 표의 장바구니. 이 탭이 들고 있어서 IAM 안의 다른 화면을 보고 돌아와도 남고, 프로필을 바꾸면 비워진다.
  // 개요가 아직 없는 동안에도 부르므로 아래 early return보다 앞에 둔다.
  const draft = useAssignmentDraft(profile, ov);
  // 열 추가로 더한 정책도 같다: 이 탭이 프로필마다 들고 있어서, 머리를 눌러 상세를 보고 뒤로 와도 열이 남는다.
  const added = useAddedColumns(profile);
  // 목록마다 마지막으로 고른 행. 상세를 보고 돌아와도 그대로 남는다.
  const [selected, setSelected] = useState<Partial<Record<IamView, string>>>({});

  // 대상이 지정돼 열렸으면(nonce가 새로 바뀜) 그 사용자·역할·정책으로 이동한다. 지정이 없으면 보던 자리를 지킨다.
  const appliedNonce = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!ov || appliedNonce.current === nonce) return;
    appliedNonce.current = nonce;
    const target = focus ? routeForFocus(ov, focus) : null;
    if (target) navigate(target);
  }, [ov, focus, nonce, navigate]);

  // ⌘[ / ⌘]와 마우스 뒤로/앞으로 버튼: 보이는 탭에서만, 확인 창이 떠 있거나 글자를 입력하는 중이면 건드리지 않는다.
  useHistoryKeys(active, back, forward);

  if (!ov) {
    return (
      <div className="iam">
        {overview.isError ? (
          <ErrorState error={overview.error} profile={profile} onRetry={() => void overview.refetch()} />
        ) : (
          <div className="empty">IAM 정보를 불러오는 중이에요. 계정 규모에 따라 몇 초 걸릴 수 있어요</div>
        )}
      </div>
    );
  }

  const counts: NavCounts = {
    findings: ov.findingCount,
    users: ov.users.length,
    groups: ov.groups.length,
    roles: ov.roles.length,
    policies: ov.policies.length,
    assignments: draft.items.length || undefined,
  };
  const select = (view: IamView, id: string) => setSelected((s) => ({ ...s, [view]: id }));
  // 행을 열면 그 행을 골라 둔다. 돌아왔을 때 어디서 왔는지 보이도록.
  const openRoute = (view: IamView, id: string, to: IamRoute) => {
    select(view, id);
    navigate(to);
  };
  // 상세 화면이 보던 하위 탭과 열어 둔 칸을 현재 기록 항목에 남긴다. 뒤로 돌아오면 되살린다.
  const remember = (state: Partial<IamRoute>) => replace((r) => ({ ...r, ...state }));

  const kind = KIND_OF_VIEW[route.view];
  const total = route.id ? null : listCount(ov, route.view);
  const fetchedAt = new Date(ov.fetchedAt);

  let body;
  if (kind && route.id) {
    body = (
      <PrincipalDetail
        key={route.id}
        profile={profile}
        arn={route.id}
        overview={ov}
        onOpen={navigate}
        initialTab={route.tab}
        initialCell={route.cell ?? null}
        onViewState={remember}
        onFix={change.start}
      />
    );
  } else if (kind) {
    body = (
      <section className="center">
        <PrincipalList
          key={kind}
          kind={kind}
          items={listOf(ov, kind)}
          filter={filter}
          selectedId={selected[route.view] ?? null}
          onSelect={(arn) => select(route.view, arn)}
          onOpen={(arn) => openRoute(route.view, arn, principalRoute(kind, arn))}
        />
      </section>
    );
  } else if (route.view === "policies" && route.id) {
    body = (
      <PolicyDetail key={route.id} profile={profile} policyId={route.id} onOpen={navigate} initialTab={route.tab} onViewState={remember} onFix={change.start} />
    );
  } else if (route.view === "policies") {
    body = (
      <section className="center">
        <PolicyList
          items={ov.policies}
          filter={filter}
          selectedId={selected.policies ?? null}
          onSelect={(id) => select("policies", id)}
          onOpen={(id) => openRoute("policies", id, policyRoute(id))}
        />
      </section>
    );
  } else if (route.view === "assignments") {
    // key: 프로필이 바뀌면 종류 칩 같은 화면 안의 상태도 새로 시작한다
    body = (
      <Assignments
        key={profile}
        profile={profile}
        overview={ov}
        draft={draft}
        extra={added.arns}
        onAddColumn={added.add}
        tab={route.tab === "members" ? "members" : "policies"}
        onTab={(tab) => remember({ tab })}
        onOpen={navigate}
        onPreview={(changes) => batch.start(changes, { onApplied: draft.removeApplied })}
        filter={filter}
      />
    );
  } else if (route.view === "findings") {
    body = <Findings profile={profile} overview={ov} onOpen={navigate} onFix={change.start} initialKind={route.tab} onViewState={remember} />;
  } else if (route.view === "whoCan") {
    body = <WhoCan profile={profile} overview={ov} onOpen={navigate} initial={route.search} onViewState={remember} />;
  } else {
    body = <ChangeLog profile={profile} accountId={ov.accountId} onStart={change.start} onStartBatch={batch.start} />;
  }

  return (
    <div className="iam">
      <IamNav view={route.view} counts={counts} onSelect={(view) => navigate({ view })} />
      <div className="iam-body">
        <div className="iam-bar">
          <button className="icon" aria-label="뒤로" title="뒤로 (⌘[)" disabled={!canBack} onClick={back}>
            ‹
          </button>
          <button className="icon" aria-label="앞으로" title="앞으로 (⌘])" disabled={!canForward} onClick={forward}>
            ›
          </button>
          <nav className="iam-crumb" aria-label="현재 위치">
            {route.id ? (
              <>
                <button className="link crumb-link" onClick={() => navigate({ view: route.view })}>
                  {VIEW_LABEL[route.view]}
                </button>
                <span aria-hidden="true">›</span>
                <b>{detailName(ov, route)}</b>
              </>
            ) : (
              <b>{VIEW_LABEL[route.view]}</b>
            )}
          </nav>
          {total !== null && <span className="dim">{total}개</span>}
          <span className="iam-bar-end">
            {!Number.isNaN(fetchedAt.getTime()) && <span className="dim">조회 {fetchedAt.toLocaleTimeString("ko-KR")}</span>}
            <button className="btn small" onClick={() => void refreshIam(qc, profile)} disabled={overview.isFetching}>
              {overview.isFetching ? "불러오는 중…" : "새로고침"}
            </button>
          </span>
        </div>
        <div className="iam-note">
          <span aria-hidden="true">ⓘ</span> 조직 SCP와 리소스 기반 정책은 반영하지 않아요
        </div>
        {ov.warnings.length > 0 && (
          <ul className="iam-warn" aria-label="경고">
            {ov.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {overview.isError && <ErrorState compact error={overview.error} profile={profile} onRetry={() => void overview.refetch()} />}
        {change.notices.map((notice) => (
          <DoneNotice key={`change-${notice.id}`} notice={notice} onDismiss={() => change.dismissNotice(notice.id)} />
        ))}
        {batch.notices.map((notice) => (
          <DoneNotice key={`batch-${notice.id}`} notice={notice} onDismiss={() => batch.dismissNotice(notice.id)} />
        ))}
        <div className="iam-main">{body}</div>
      </div>
      {change.pending && <ChangePreviewDialog pending={change.pending} onApply={change.apply} onRetry={change.retryPreview} onCancel={change.cancel} />}
      {batch.pending && <BatchPreviewDialog pending={batch.pending} onApply={batch.apply} onRetry={batch.retryPreview} onCancel={batch.cancel} onStart={batch.start} />}
    </div>
  );
}
