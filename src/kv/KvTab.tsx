import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { useSettings } from "../api/queries";
import { shortcutTitle } from "../keymap/keybindings";
import { useHistoryKeys } from "../lib/useHistoryKeys";
import { useRouteHistory } from "../lib/useRouteHistory";
import { kvApi } from "./api";
import { BigKeys } from "./BigKeys";
import { BullQueue } from "./BullQueue";
import { BullQueues } from "./BullQueues";
import { Clients } from "./Clients";
import { KeyBrowser } from "./KeyBrowser";
import { KvError } from "./KvError";
import { KvNav } from "./KvNav";
import { LoginPrompt } from "./LoginPrompt";
import { KvLoginContext, type KvLoginApi } from "./loginContext";
import { Overview } from "./Overview";
import { forgetKvData, rereadKv, useKvOverview, useKvTarget, type KvConnect } from "./queries";
import { KV_VIEW_LABEL, sameKvRoute, type KvRoute, type KvView } from "./route";
import { Slowlog } from "./Slowlog";
import * as t from "./text";
import type { KvKeyName, KvLogin, KvLoginSaved, KvOverview, KvTarget, KvTargetInfo } from "./types";
import { useBigKeys } from "./useBigKeys";

interface Props {
  target: KvTarget;
  /** 이 탭이 보이는 탭일 때만 마우스 뒤로/앞으로 버튼과 ⌘F에 반응한다(⌘[ ⌘]는 탭의 뿌리 상자가 보이는지로 가린다) */
  active: boolean;
}

// 처음 열면 키 화면
const HOME: KvRoute = { view: "keys" };

/** 🐂 큐를 찾는 prefix의 기본값 */
const DEFAULT_BULL_PREFIX = "bull";

type Connection = keyof typeof t.CONNECTION;

interface BarProps {
  info: KvTargetInfo;
  overview: KvOverview | null;
  login: KvLoginSaved | null;
  connection: Connection | null;
  reading: boolean;
  /** [바꾸기]를 보일지(이미 묻는 중이면 숨긴다) */
  canChange: boolean;
  onChange: () => void;
  onDatabase: (db: number) => void;
  onForgetPassword: () => void;
  onReread: () => void;
}

/** 위쪽 줄: 대상 이름, 엔진 버전, 모드, 노드 수, 로그인([바꾸기]), DB 번호, 연결 상태, [다시 읽기] */
function TopBar({ info, overview, login, connection, reading, canChange, onChange, onDatabase, onForgetPassword, onReread }: BarProps) {
  const mode = overview?.mode ?? (info.serverless ? "serverless" : info.clusterMode ? "cluster" : "standalone");
  return (
    <div className="kv-top" role="group" aria-label={t.INFO_GROUP}>
      <b className="kv-ident">{info.identifier}</b>
      <span className="dim mono">
        {overview?.engine ?? info.engine} {overview?.version ?? info.engineVersion}
      </span>
      <span className="iam-chip">{t.MODE_LABEL[mode]}</span>
      {overview && <span className="dim">{t.NODE_COUNT(overview.nodes.length)}</span>}
      {login && (
        <span className="kv-login-state">
          <span className="dim">{t.LOGIN_LABEL}</span>
          <b>{t.MODES[login.mode].label}</b>
          {login.user && <span className="mono">{login.user}</span>}
          {canChange && (
            <button className="link" onClick={onChange}>
              {t.LOGIN_CHANGE}
            </button>
          )}
          {(login.mode === "password" || login.mode === "user") && (
            <button className="link" onClick={onForgetPassword}>
              {t.FORGET_PASSWORD}
            </button>
          )}
        </span>
      )}
      {overview && overview.mode === "standalone" && overview.databases.length > 0 && (
        <label className="sel kv-db-picker">
          <small>{t.DATABASE_LABEL}</small>
          <select aria-label={t.DATABASE_LABEL} value={overview.database} onChange={(e) => onDatabase(Number(e.target.value))}>
            {(overview.databases.includes(overview.database) ? overview.databases : [...overview.databases, overview.database].sort((a, b) => a - b)).map((db) => (
              <option key={db} value={db}>
                {t.databaseOption(db)}
              </option>
            ))}
          </select>
        </label>
      )}
      {connection && (
        <span className="kv-status-dot">
          <span className={`dot ${t.CONNECTION[connection].dot}`} aria-hidden="true" />
          {t.CONNECTION[connection].label}
        </span>
      )}
      <span className="kv-top-end">
        {overview && (
          <button className="btn small" onClick={onReread} disabled={reading}>
            {reading ? t.READING : t.REREAD}
          </button>
        )}
      </span>
    </div>
  );
}

export function KvTab({ target, active }: Props) {
  const qc = useQueryClient();
  const info = useKvTarget(target);
  const { settings, update } = useSettings();
  const targetInfo = info.data;
  // 로그인(방식·사용자·DB 번호)은 대상 ARN별로 설정 파일에 기억한다. 비밀번호는 키체인에만 있다.
  const saved = (targetInfo && settings?.kvLogins?.[targetInfo.arn]) || null;
  // 사용자가 로그인 상자에서 보낸 로그인. 없으면 기억해 둔 로그인으로 바로 연결한다(비밀번호는 키체인에서).
  const [submitted, setSubmitted] = useState<KvConnect | null>(null);
  const [changing, setChanging] = useState(false);
  const savedMode = saved?.mode;
  const savedUser = saved?.user;
  const savedDatabase = saved?.database;
  const connect = useMemo<KvConnect | null>(
    () => submitted ?? (savedMode !== undefined ? { login: { mode: savedMode, user: savedUser ?? "", database: savedDatabase ?? 0, password: null, rememberPassword: false }, attempt: 0 } : null),
    [submitted, savedMode, savedUser, savedDatabase],
  );
  // 이 탭이 사는 동안 계속 구독해야 한다. 화면마다 바뀌는 자식에서만 부르면 화면을 옮길 때마다 다시 연결한다(useKvOverview).
  const overview = useKvOverview(target, connect);
  const ov = overview.data;
  const { route, canBack, canForward, navigate, replace, back, forward } = useRouteHistory(HOME, sameKvRoute);
  const root = useRef<HTMLDivElement>(null);
  useHistoryKeys(root, active, back, forward);
  const bigKeys = useBigKeys(target);
  const [notice, setNotice] = useState<string | null>(null);

  // 연결에 성공하면 로그인(방식·사용자·DB 번호)을 설정에 기억하고, 보낸 비밀번호는 메모리에서 지운다(이후 연결은 키체인의 것을 쓴다).
  const remembered = useRef<string | null>(null);
  useEffect(() => {
    if (!ov || !connect || !targetInfo || !settings) return;
    const { login, attempt } = connect;
    const id = `${login.mode}|${login.user}|${login.database}|${attempt}`;
    if (remembered.current === id) return;
    remembered.current = id;
    const current = settings.kvLogins?.[targetInfo.arn];
    if (!current || current.mode !== login.mode || current.user !== login.user || current.database !== login.database) {
      update({ kvLogins: { ...settings.kvLogins, [targetInfo.arn]: { mode: login.mode, user: login.user, database: login.database } } });
    }
    if (login.password !== null) setSubmitted((s) => (s ? { ...s, login: { ...s.login, password: null } } : s));
  }, [ov, connect, targetInfo, settings, update]);

  const submitLogin = (login: KvLogin) => {
    setChanging(false);
    setNotice(null);
    // 다른 로그인·DB로 읽은 키와 서버 상태는 이 연결의 것이 아니다
    forgetKvData(qc, target);
    bigKeys.reset();
    navigate({ view: route.view });
    setSubmitted((s) => ({ login, attempt: (s?.attempt ?? 0) + 1 }));
  };
  const forgetPassword = () => {
    if (!connect) return;
    kvApi.forgetPassword(target, connect.login.user).then(
      () => setNotice(t.PASSWORD_FORGOTTEN),
      (e: unknown) => setNotice(errorMessage(e)),
    );
  };

  const current: KvLoginSaved | null = connect ? { mode: connect.login.mode, user: connect.login.user, database: connect.login.database } : null;
  const loginApi: KvLoginApi | null = targetInfo ? { info: targetInfo, current, connect: submitLogin } : null;

  const openKey = route.view === "keys" ? (route.key ?? null) : null;
  const openKeyView = (name: KvKeyName | null) => navigate(name ? { view: "keys", key: name } : { view: "keys" });

  // 🐂 큐를 찾는 prefix는 대상 ARN별로 설정에 기억한다. 비어 있으면 bull
  const bullPrefix = (targetInfo && settings?.kvBullPrefixes?.[targetInfo.arn]) || DEFAULT_BULL_PREFIX;
  const saveBullPrefix = (prefix: string) => {
    if (!targetInfo || !settings) return;
    update({ kvBullPrefixes: { ...settings.kvBullPrefixes, [targetInfo.arn]: prefix } });
    navigate({ view: "bull" });
  };

  const renderConnected = (o: KvOverview) => {
    const disabled: Partial<Record<KvView, string>> = {};
    if (o.unsupported.includes("slowlog")) disabled.slowlog = t.UNSUPPORTED.slowlog;
    if (o.unsupported.includes("clients")) disabled.clients = t.UNSUPPORTED.clients;
    return (
      <>
        <KvNav view={route.view} disabled={disabled} onSelect={(view) => navigate({ view })} />
        <div className="iam-body">
          <div className="iam-bar">
            <button className="icon" aria-label={t.NAV_BACK} title={shortcutTitle(t.NAV_BACK, "tab.back")} disabled={!canBack} onClick={back}>
              ‹
            </button>
            <button className="icon" aria-label={t.NAV_FORWARD} title={shortcutTitle(t.NAV_FORWARD, "tab.forward")} disabled={!canForward} onClick={forward}>
              ›
            </button>
            <nav className="iam-crumb" aria-label={t.CRUMB_LABEL}>
              {route.view === "bull" && route.queue ? (
                <>
                  <button className="link crumb-link" onClick={() => navigate({ view: "bull" })}>
                    {KV_VIEW_LABEL.bull}
                  </button>
                  <span aria-hidden="true">›</span>
                  <b className="mono">{route.queue}</b>
                </>
              ) : openKey ? (
                <>
                  <button className="link crumb-link" onClick={() => navigate({ view: route.view })}>
                    {KV_VIEW_LABEL[route.view]}
                  </button>
                  <span aria-hidden="true">›</span>
                  <b className="mono">{openKey.text}</b>
                </>
              ) : (
                <b>{KV_VIEW_LABEL[route.view]}</b>
              )}
            </nav>
          </div>
          <div className="iam-main">
            {route.view === "keys" ? (
              <KeyBrowser target={target} overview={o} openKey={openKey} onOpenKey={openKeyView} active={active} />
            ) : route.view === "bull" && route.queue ? (
              <BullQueue
                target={target}
                prefix={bullPrefix}
                name={route.queue}
                state={route.state}
                jobId={route.job}
                onBack={() => navigate({ view: "bull" })}
                onState={(state) => replace((r) => ({ ...r, state }))}
                onOpenJob={(queue, id) => navigate({ view: "bull", queue, state: queue === route.queue ? route.state : undefined, job: id })}
                onCloseJob={() => navigate({ view: "bull", queue: route.queue, state: route.state })}
                active={active}
              />
            ) : route.view === "bull" ? (
              <BullQueues target={target} prefix={bullPrefix} onPrefix={saveBullPrefix} onOpenQueue={(queue) => navigate({ view: "bull", queue })} active={active} />
            ) : route.view === "overview" ? (
              <Overview target={target} overview={o} />
            ) : route.view === "slowlog" ? (
              <Slowlog target={target} overview={o} active={active} />
            ) : route.view === "clients" ? (
              <Clients target={target} overview={o} active={active} />
            ) : (
              <BigKeys target={target} overview={o} state={bigKeys.state} onStart={bigKeys.start} onStop={bigKeys.stop} onOpenKey={openKeyView} />
            )}
          </div>
        </div>
      </>
    );
  };

  let content;
  if (!targetInfo) {
    content = info.isError ? <KvError error={info.error} target={target} /> : <div className="empty">{t.TARGET_LOADING}</div>;
  } else if (!settings) {
    content = <div className="empty">{t.LOADING}</div>;
  } else if (!connect || changing) {
    content = (
      <div className="kv-prompt">
        <LoginPrompt info={targetInfo} initial={current ?? saved} onSubmit={submitLogin} onCancel={connect ? () => setChanging(false) : undefined} />
      </div>
    );
  } else if (!ov) {
    content = overview.isError ? <KvError error={overview.error} target={target} /> : <div className="empty">{t.CONNECTING}</div>;
  } else {
    content = renderConnected(ov);
  }

  const connection: Connection | null = !connect ? null : overview.isError ? "failed" : ov ? "connected" : "connecting";

  return (
    <KvLoginContext.Provider value={loginApi}>
      <div className="kv-tab" ref={root}>
        {targetInfo && (
          <TopBar
            info={targetInfo}
            overview={ov ?? null}
            login={current}
            connection={connection}
            reading={overview.isFetching}
            canChange={!changing}
            onChange={() => setChanging(true)}
            onDatabase={(database) => connect && submitLogin({ ...connect.login, database, password: null, rememberPassword: false })}
            onForgetPassword={forgetPassword}
            onReread={() => void rereadKv(qc, target)}
          />
        )}
        {ov && overview.isError && <KvError compact error={overview.error} target={target} />}
        {/* 대상 정보를 다시 읽다 실패해도 이전 정보는 화면에 남는다. 연결도 실패했으면 그 쪽이 이유를 이미 보이니 한 번만 알린다. */}
        {targetInfo && info.isError && !overview.isError && <KvError compact error={info.error} target={target} />}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <div className="kv-main">{content}</div>
      </div>
    </KvLoginContext.Provider>
  );
}
