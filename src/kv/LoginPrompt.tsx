import { useId, useState } from "react";
import * as t from "./text";
import type { KvAuthMode, KvLogin, KvLoginSaved, KvTargetInfo, KvUser } from "./types";

const MODE_ORDER: KvAuthMode[] = ["none", "password", "user", "iam"];

/** 사용자의 인증 방식이 가리키는 로그인 방식. IAM 사용자는 IAM이 되는 캐시에서만 iam이다 */
const modeOfUser = (u: KvUser, info: KvTargetInfo): KvAuthMode => (u.auth === "iam" && info.iamSupported ? "iam" : "user");

/** 이 방식에 맞는 사용자인가(IAM 방식은 IAM 사용자, 사용자 방식은 그 밖의 사용자) */
const fits = (u: KvUser, mode: KvAuthMode) => (mode === "iam" ? u.auth === "iam" : u.auth !== "iam");

/**
 * 로그인 화면이 미리 고르는 값. 기억해 둔 로그인이 있으면 그대로이고, 없으면 대상 정보로 고른다:
 * 사용자 그룹 → 그 사용자 목록에서 하나(사용자 방식이나 IAM), AUTH 토큰 켜짐 → password, 둘 다 없음 → none.
 * 사용자 목록은 "default" 말고 다른 사용자가 있으면 그쪽을 먼저 고른다(default는 보통 접근을 막아 둔다).
 */
export function defaultLogin(info: KvTargetInfo, saved: KvLoginSaved | null): KvLoginSaved {
  if (saved) return saved;
  const users = info.users ?? [];
  if (users.length > 0) {
    const u = users.find((x) => x.name !== "default") ?? users[0];
    return { mode: modeOfUser(u, info), user: u.name, database: 0 };
  }
  if (info.userGroupIds.length > 0) return { mode: "user", user: "", database: 0 };
  if (info.authTokenEnabled) return { mode: "password", user: "", database: 0 };
  return { mode: "none", user: "", database: 0 };
}

interface Props {
  info: KvTargetInfo;
  /** 기억해 둔(또는 지금 쓰는) 로그인. 없으면 대상 정보로 방식을 미리 고른다 */
  initial: KvLoginSaved | null;
  /** 연결이 loginRequired로 거절된 이유. 입력칸 위에 보인다 */
  message?: string;
  onSubmit: (login: KvLogin) => void;
  /** 돌아갈 곳이 있을 때(바꾸기로 연 경우)만 준다. [취소]가 생긴다 */
  onCancel?: () => void;
}

/**
 * 캐시에 로그인하는 상자. 방식 네 가지(로그인 없음·AUTH 토큰·사용자·IAM) 중 대상 정보로 미리 고른 것을 바꿀 수 있고,
 * 사용자 그룹을 읽었으면 사용자를 목록에서 고른다(고르면 그 사용자의 인증 방식에 맞게 방식이 바뀐다).
 * 비밀번호는 보내기만 하고 이 앱의 설정에 남기지 않는다. [비밀번호 기억하기]를 켜면 백엔드가 키체인에 둔다.
 */
export function LoginPrompt({ info, initial, message, onSubmit, onCancel }: Props) {
  const start = defaultLogin(info, initial);
  const [mode, setMode] = useState<KvAuthMode>(start.mode);
  const [user, setUser] = useState(start.user);
  const [database, setDatabase] = useState(start.database);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const ids = useId();
  const users = info.users ?? [];
  const chosen = users.find((u) => u.name === user);
  const showDatabase = !info.clusterMode && !info.serverless;
  const needsUser = mode === "user" || mode === "iam";
  // 비밀번호가 필요 없는 사용자는 칸을 숨긴다. 사용자를 모르면(직접 입력) 묻는다.
  const needsPassword = mode === "password" || (mode === "user" && chosen?.auth !== "no-password");
  const ready = (!needsUser || user.trim() !== "") && (mode !== "iam" || info.iamSupported);

  const pickUser = (u: KvUser) => {
    setUser(u.name);
    setMode(modeOfUser(u, info));
  };
  const changeMode = (next: KvAuthMode) => {
    setMode(next);
    // 이 방식에 맞지 않는 사용자가 골라져 있으면 맞는 첫 사용자로 옮긴다
    if ((next === "user" || next === "iam") && users.length > 0 && !(chosen && fits(chosen, next))) {
      const first = users.find((u) => fits(u, next));
      if (first) setUser(first.name);
    }
  };

  const submit = () => {
    if (!ready) return;
    onSubmit({
      mode,
      user: needsUser ? user.trim() : "",
      database: showDatabase ? database : 0,
      password: needsPassword && password !== "" ? password : null,
      rememberPassword: needsPassword && password !== "" && remember,
    });
  };

  return (
    <form
      className="kv-login"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{t.LOGIN_TITLE}</h3>
      <p>{t.LOGIN_INTRO}</p>
      {message && (
        <p className="kv-login-error" role="alert">
          {message}
        </p>
      )}
      <div className="kv-modes" role="radiogroup" aria-label={t.MODE_GROUP}>
        {MODE_ORDER.map((m) => {
          const off = m === "iam" && !info.iamSupported;
          return (
            <label key={m} className={`kv-mode${mode === m ? " on" : ""}${off ? " off" : ""}`} title={off ? t.IAM_UNSUPPORTED : undefined}>
              <input type="radio" name={`${ids}-mode`} checked={mode === m} disabled={off} onChange={() => changeMode(m)} />
              <b>{t.MODES[m].label}</b>
              <small className="dim">{t.MODES[m].hint}</small>
            </label>
          );
        })}
      </div>
      {needsUser &&
        (users.length > 0 ? (
          <div className="kv-users" role="radiogroup" aria-label={t.USER_GROUP}>
            {users.map((u) => (
              <label key={u.id} className={`kv-user${u.name === user ? " on" : ""}`}>
                <input type="radio" name={`${ids}-user`} checked={u.name === user} onChange={() => pickUser(u)} />
                <b className="mono">{u.name}</b>
                <span className={`iam-chip kv-auth-${u.auth}`}>{t.AUTH_LABEL[u.auth]}</span>
                <span className="dim kv-user-status">{u.status}</span>
                <span className="dim mono kv-user-access" title={u.access}>
                  {u.access}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="kv-field">
            <input className="field-input mono" aria-label={t.USER_INPUT} value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoComplete="off" placeholder={t.USER_INPUT} />
            {info.users === null && info.userGroupIds.length > 0 && <small className="dim">{t.USERS_UNREADABLE}</small>}
          </div>
        ))}
      {needsPassword && (
        <div className="kv-field">
          <input
            type="password"
            className="field-input mono"
            aria-label={mode === "password" ? t.TOKEN_LABEL : t.PASSWORD_LABEL}
            placeholder={t.PASSWORD_HINT}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
          <label className="kv-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t.REMEMBER_PASSWORD}
          </label>
        </div>
      )}
      {showDatabase && (
        <label className="kv-field kv-db">
          <span className="dim">{t.DATABASE_LABEL}</span>
          <input className="field-input mono" type="number" min={0} step={1} aria-label={t.DATABASE_LABEL} value={database} onChange={(e) => setDatabase(Math.max(0, Math.trunc(Number(e.target.value)) || 0))} />
        </label>
      )}
      <div className="kv-login-foot">
        {onCancel && (
          <button type="button" className="btn plain" onClick={onCancel}>
            {t.CANCEL}
          </button>
        )}
        <button type="submit" className="btn primary" disabled={!ready}>
          {t.CONNECT}
        </button>
      </div>
    </form>
  );
}
