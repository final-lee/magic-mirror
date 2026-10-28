import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSettings } from "../api/queries";
import type { ApplyNotice } from "../iam/useApplyFlow";
import { useHistoryKeys } from "../lib/useHistoryKeys";
import { useRouteHistory } from "../lib/useRouteHistory";
import { ChangeLog } from "./ChangeLog";
import { DefaultPrivileges } from "./DefaultPrivileges";
import { Findings } from "./Findings";
import { LoginPrompt } from "./LoginPrompt";
import { PgBatchDialog } from "./PgBatchDialog";
import { PgChangeDialog } from "./PgChangeDialog";
import { PgError } from "./PgError";
import { PgNav } from "./PgNav";
import { PrivilegeGrid } from "./PrivilegeGrid";
import { refreshPg, refreshPgData, usePgFindings, usePgOverview, usePgTarget } from "./queries";
import { DEFAULT_KINDS } from "./RoleKinds";
import { RoleDetail } from "./RoleDetail";
import { RoleList } from "./RoleList";
import { PG_VIEW_LABEL, roleRoute, samePgRoute, type PgRoute, type SchemaFocus } from "./route";
import { Sessions } from "./Sessions";
import type { PgOverview, PgTarget, PgTargetInfo, PgTargetKind } from "./types";
import { usePgBatch } from "./usePgBatch";
import { usePgChange } from "./usePgChange";
import { WhoCan } from "./WhoCan";

interface Props {
  target: PgTarget;
  title: string;
  /** 이 탭이 보이는 탭일 때만 ⌘[ ⌘]와 마우스 뒤로/앞으로 버튼에 반응한다 */
  active: boolean;
  /** 툴바 필터. 이 탭이 활성일 때만 값이 온다. */
  filter: string;
}

// 처음 열면 역할 목록
const HOME: PgRoute = { view: "roles" };

const IAM_OFF: Record<PgTargetKind, string> = {
  cluster: "이 클러스터는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요",
  instance: "이 인스턴스는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요",
};

type Connection = "connecting" | "connected" | "failed";
const CONNECTION: Record<Connection, { dot: string; label: string }> = {
  connecting: { dot: "yellow", label: "연결 중…" },
  connected: { dot: "green", label: "연결됨" },
  failed: { dot: "red", label: "연결 안 됨" },
};

interface BarProps {
  info: PgTargetInfo;
  /** 이 대상에 기억된 DB 사용자. 아직 없으면 null */
  loginUser: string | null;
  connection: Connection | null;
  /** 개요를 읽은 시각. 아직 연결하지 못했으면 null */
  fetchedAt: string | null;
  reading: boolean;
  /** [바꾸기]를 보일지(이미 묻는 중이면 숨긴다) */
  canChange: boolean;
  onChange: () => void;
  onReread: () => void;
}

/** 위쪽 줄: 대상 이름, 엔진 버전, 로그인한 DB 사용자([바꾸기]), 연결 상태, 읽은 시각, [다시 읽기] */
function TopBar({ info, loginUser, connection, fetchedAt, reading, canChange, onChange, onReread }: BarProps) {
  const at = fetchedAt ? new Date(fetchedAt) : null;
  return (
    <div className="pg-top" role="group" aria-label="연결 정보">
      <b className="pg-ident">{info.identifier}</b>
      <span className="dim mono">
        {info.engine} {info.engineVersion}
      </span>
      {loginUser && (
        <span className="pg-user">
          <span className="dim">DB 사용자</span>
          <b>{loginUser}</b>
          {canChange && (
            <button className="link" onClick={onChange}>
              바꾸기
            </button>
          )}
        </span>
      )}
      {connection && (
        <span className="pg-status">
          <span className={`dot ${CONNECTION[connection].dot}`} aria-hidden="true" />
          {CONNECTION[connection].label}
        </span>
      )}
      <span className="pg-top-end">
        {at && !Number.isNaN(at.getTime()) && <span className="dim">읽은 시각 {at.toLocaleTimeString("ko-KR")}</span>}
        {fetchedAt && (
          <button className="btn small" onClick={onReread} disabled={reading}>
            {reading ? "읽는 중…" : "다시 읽기"}
          </button>
        )}
      </span>
    </div>
  );
}

/** 적용을 마친 뒤의 안내 한 줄. 함께 알릴 일(notes)이 있으면 사용자가 닫을 때까지 남는다. IAM과 달리 반영이 늦어진다는 말은 없다: 커밋하면 바로 보인다. */
function DoneNotice({ notice, onDismiss }: { notice: ApplyNotice; onDismiss: () => void }) {
  return (
    <div className="iam-done" role="status">
      <span aria-hidden="true">✓</span> <span>{notice.summary}</span>
      <button className="icon" aria-label="알림 닫기" onClick={onDismiss}>
        ✕
      </button>
      {/* 바꾸기는 했지만 하지 못한 일(변경 기록 저장 등). 이 안내는 닫을 때까지 남는다 */}
      {notice.notes.length > 0 && (
        <ul className="iam-done-notes" aria-label="함께 알릴 일">
          {/* 같은 안내가 여러 번 올 수 있고 목록은 순서가 바뀌지 않아서, 글이 아니라 순서를 키로 쓴다 */}
          {notice.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PgTab({ target, active, filter }: Props) {
  const qc = useQueryClient();
  const info = usePgTarget(target);
  const { settings, update } = useSettings();
  const targetInfo = info.data;
  // DB 사용자는 대상 ARN별로 설정 파일에 기억한다. IAM 인증이 꺼진 대상에는 연결하지 않는다.
  const loginUser = (targetInfo && settings?.pgLogins?.[targetInfo.arn]) || null;
  // 이 탭이 사는 동안 계속 구독해야 한다. 화면마다 바뀌는 자식에서만 부르면 화면을 옮길 때마다 다시 연결한다(usePgOverview).
  const overview = usePgOverview(target, targetInfo?.iamAuth ? loginUser : null);
  const ov = overview.data;
  const { route, canBack, canForward, navigate, replace, back, forward } = useRouteHistory(HOME, samePgRoute);
  useHistoryKeys(active, back, forward);
  // 점검은 모든 데이터베이스를 읽어 무겁다. 점검 화면을 열었을 때만 읽는다. 이 탭이 계속 구독하니 한 번 읽은 건수는 화면을 떠나도 메뉴에 남는다.
  // 점검이 보이지 않는 동안의 새로 고침은, 이미 읽은 점검이면 표시와 무효화만 해 두었다가 다시 열 때 force로 읽는다(refreshPg). 한 번도 열지 않았으면 아무것도 하지 않는다.
  const findings = usePgFindings(target, !!ov && route.view === "findings");
  const [changing, setChanging] = useState(false);
  // 모든 변경(변경 기록의 되돌리기 …)이 지나는 길: 미리보기 → 확인 → 적용. 하나짜리 변경과 묶음(변경 여럿이 한 트랜잭션)을 섞지 않는다.
  // 이 탭이 들고 있어서 PostgreSQL 안의 다른 화면을 보고 돌아와도 열린 창과 안내가 남는다.
  const change = usePgChange(target);
  const batch = usePgBatch(target);
  // 역할 목록, 권한 표, 누가 할 수 있나가 함께 쓰는 칩과 시스템 역할 토글, 역할 목록에서 고른 행. 상세를 보고 돌아와도 남는다.
  const [kinds, setKinds] = useState(DEFAULT_KINDS);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  // 권한 표, 기본 권한(누가 할 수 있나도)이 함께 쓰는 데이터베이스 선택. 탭 하나에 하나이고, 기록(경로)이 아니라 여기에만 둔다.
  // 아직 안 골랐거나 고른 데이터베이스에 연결할 수 없게 되면 화면이 대상의 기본 데이터베이스를 보인다(pickDatabase).
  const [database, setDatabase] = useState<string | undefined>(undefined);
  // 점검 항목이 권한 표를 열면서 부탁한 것(스키마와 역할). 표가 처음 그려지면서 한 번 쓰고 알리면 비운다.
  const [pick, setPick] = useState<SchemaFocus | null>(null);

  // 로그인 사용자를 바꿔 새로 연결하면, 데이터베이스·역할·점검 …은 이전 사용자의 연결로 읽은 것이다. 새 개요가 오면 나머지를 다시 읽는다.
  // 첫 연결에서는 읽을 것이 없고, 개요를 다시 읽는 새로 고침은 사용자가 같아서 여기에 걸리지 않는다.
  const hasOverview = !!ov;
  const connectedAs = useRef<string | null>(null);
  useEffect(() => {
    if (!hasOverview) return;
    if (connectedAs.current !== null && connectedAs.current !== loginUser) void refreshPgData(qc, target);
    connectedAs.current = loginUser;
  }, [hasOverview, loginUser, qc, target]);

  const reread = () => void refreshPg(qc, target);
  const saveLogin = (name: string) => {
    if (!targetInfo || !settings) return;
    setChanging(false);
    update({ pgLogins: { ...settings.pgLogins, [targetInfo.arn]: name } });
    // 같은 이름이면 쿼리 키가 그대로라 저절로 다시 연결하지 않는다. 직접 다시 읽는다.
    if (name === loginUser) reread();
  };
  const go = (to: PgRoute) => {
    if (to.view === "roles" && to.id) setSelectedRole(to.id);
    navigate(to);
  };
  // 점검 항목의 객체를 누르면: 그 데이터베이스를 이 탭의 선택으로 하고, 권한 표를 그 스키마(와 역할)를 고른 채로 연다.
  const openSchema = (to: SchemaFocus) => {
    setDatabase(to.database);
    setPick(to);
    navigate({ view: "privileges" });
  };
  // 상세 화면이 보던 하위 탭을 현재 기록 항목에 남긴다. 뒤로 돌아오면 되살린다.
  const remember = (state: Partial<PgRoute>) => replace((r) => ({ ...r, ...state }));

  // 연결이 끝난 뒤의 화면: 메뉴, 이동 줄, 고른 화면
  const renderConnected = (o: PgOverview) => (
    <>
      <PgNav
        view={route.view}
        counts={{ findings: findings.data?.groups.reduce((n, g) => n + g.items.length, 0) }}
        onSelect={(view) => navigate({ view })}
      />
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
                  {PG_VIEW_LABEL[route.view]}
                </button>
                <span aria-hidden="true">›</span>
                <b>{route.id}</b>
              </>
            ) : (
              <b>{PG_VIEW_LABEL[route.view]}</b>
            )}
          </nav>
        </div>
        <div className="iam-main">
          {route.view === "roles" && route.id ? (
            <RoleDetail key={route.id} target={target} role={route.id} onOpen={go} initialTab={route.tab} onViewState={remember} />
          ) : route.view === "roles" ? (
            <RoleList
              roles={o.roles}
              filter={filter}
              kinds={kinds}
              onKinds={setKinds}
              selectedId={selectedRole}
              onSelect={setSelectedRole}
              onOpen={(name) => go(roleRoute(name))}
            />
          ) : route.view === "privileges" ? (
            <PrivilegeGrid
              target={target}
              overview={o}
              database={database}
              onDatabase={setDatabase}
              filter={filter}
              kinds={kinds}
              onKinds={setKinds}
              pick={pick}
              onPickUsed={() => setPick(null)}
            />
          ) : route.view === "defaults" ? (
            <DefaultPrivileges target={target} overview={o} database={database} onDatabase={setDatabase} />
          ) : route.view === "whoCan" ? (
            <WhoCan target={target} overview={o} database={database} onDatabase={setDatabase} kinds={kinds} onKinds={setKinds} />
          ) : route.view === "sessions" ? (
            <Sessions target={target} />
          ) : route.view === "changes" ? (
            <ChangeLog target={target} targetArn={o.target.arn} onStart={change.start} onStartBatch={batch.start} />
          ) : (
            <Findings target={target} overview={o} onOpenRole={(name) => go(roleRoute(name))} onOpenSchema={openSchema} />
          )}
        </div>
      </div>
    </>
  );

  let content;
  if (!targetInfo) {
    content = info.isError ? <PgError error={info.error} target={target} /> : <div className="empty">대상을 확인하는 중이에요</div>;
  } else if (!targetInfo.iamAuth) {
    content = <div className="empty">{IAM_OFF[targetInfo.kind]}</div>;
  } else if (!settings) {
    content = <div className="empty">불러오는 중…</div>;
  } else if (!loginUser || changing) {
    content = (
      <div className="pg-prompt">
        <LoginPrompt initial={loginUser ?? ""} onSubmit={saveLogin} onCancel={loginUser ? () => setChanging(false) : undefined} />
      </div>
    );
  } else if (!ov) {
    content = overview.isError ? <PgError error={overview.error} target={target} /> : <div className="empty">연결하는 중이에요</div>;
  } else {
    content = renderConnected(ov);
  }

  const connection: Connection | null = !loginUser || !targetInfo?.iamAuth ? null : overview.isError ? "failed" : ov ? "connected" : "connecting";

  return (
    <div className="pg">
      {targetInfo && (
        <TopBar
          info={targetInfo}
          loginUser={targetInfo.iamAuth ? loginUser : null}
          connection={connection}
          fetchedAt={ov?.fetchedAt ?? null}
          reading={overview.isFetching}
          canChange={!changing}
          onChange={() => setChanging(true)}
          onReread={reread}
        />
      )}
      {ov && !ov.canManage && ov.manageReason && <div className="iam-hint">{ov.manageReason}</div>}
      {ov && overview.isError && <PgError compact error={overview.error} target={target} />}
      {/* 대상 정보를 다시 읽다 실패해도 이전 정보는 화면에 남는다. 연결도 실패했으면 그 쪽이 이유를 이미 보이니 한 번만 알린다. */}
      {targetInfo && info.isError && !overview.isError && <PgError compact error={info.error} target={target} />}
      {change.notices.map((notice) => (
        <DoneNotice key={`change-${notice.id}`} notice={notice} onDismiss={() => change.dismissNotice(notice.id)} />
      ))}
      {batch.notices.map((notice) => (
        <DoneNotice key={`batch-${notice.id}`} notice={notice} onDismiss={() => batch.dismissNotice(notice.id)} />
      ))}
      <div className="pg-main">{content}</div>
      {change.pending && <PgChangeDialog pending={change.pending} onApply={change.apply} onRetry={change.retryPreview} onCancel={change.cancel} />}
      {batch.pending && <PgBatchDialog pending={batch.pending} onApply={batch.apply} onRetry={batch.retryPreview} onCancel={batch.cancel} />}
    </div>
  );
}
