import { useEffect, useRef, useState } from "react";
import { ListFind, useListFind } from "../../components/ListFind";
import { vimTableKeys } from "../../iam/ListTable";
import { fuzzyKeep } from "../../lib/fuzzy";
import { K8sError } from "../K8sError";
import { DETAIL_PCT } from "../lanes";
import type { K8sTarget } from "../types";
import { accessApi } from "./api";
import { PathLine, PathList, SubjectName, uniquePaths } from "./paths";
import { buildQuery } from "./parse";
import { useWhoCan } from "./queries";
import {
  CHECK_BUTTON, CHECK_DENIED_TITLE, NO_IDENTITY_MATCH, WHO_FILTER, MISMATCH_TEXT, CHECK_LIMIT, CHECK_MATCH, CHECK_MISMATCH, CHECK_RUNNING, CHECK_SKIPPED, CLOSE, DETAIL_LABEL, FIND, F_NAME, F_NAMESPACE, F_RESOURCE, F_RESOURCE_HINT, F_VERB,
  H_CHECK, H_KIND, H_PATH, H_SUBJECT, LOADING, NO_RESULT, NS_CLUSTER, OPEN_IAM, PATHS_TITLE, PRESETS, PRESETS_LABEL, REQUEST_INVALID, REVIEW_FAILED, WHO_INHERITED_NOTE, WHO_LABEL,
  checkLimited, checkSummary, morePaths, resultsTruncated, subjectKindText,
} from "./text";
import type { AccessQuery, Subject, WhoCan } from "./types";

const VERBS = ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection", "bind", "escalate", "impersonate"];
/** 한꺼번에 보내는 SubjectAccessReview 수 */
const CHECK_CONCURRENCY = 4;

type Check = { kind: "match" } | { kind: "mismatch" } | { kind: "skipped" } | { kind: "failed"; message: string };

interface Props {
  target: K8sTarget;
  context: string | null;
  ssoProfile: string;
  namespaces: string[];
  /** 이 신원이 SubjectAccessReview를 만들 수 있는지(규칙 목록으로 본 것). no면 단추를 끄고 이유를 보인다 */
  canReview: "yes" | "no" | "unknown";
  onOpenIam?: (arn: string) => void;
  /** 처음에 채울 요청 */
  initial?: { verb: string; resource: string; namespace: string | null };
}

const keyOf = (s: Subject) => `${s.kind}|${s.namespace ?? ""}|${s.name}`;

/** 동사 + 리소스(+하위 리소스) + 네임스페이스(+이름) → 할 수 있는 주체와 경로. 클러스터에 대조해 다른 것을 찾을 수도 있다. */
export function WhoCanTab({ target, context, ssoProfile, namespaces, canReview, onOpenIam, initial }: Props) {
  const [verb, setVerb] = useState(initial?.verb ?? "get");
  const [resource, setResource] = useState(initial?.resource ?? "");
  const [namespace, setNamespace] = useState<string>(initial?.namespace ?? "");
  const [name, setName] = useState("");
  const [asked, setAsked] = useState<AccessQuery | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useWhoCan(target, context, ssoProfile, asked);
  const [checks, setChecks] = useState<Map<string, Check> | null>(null);
  const [checking, setChecking] = useState(false);
  // 새 질문이나 새 결과가 오면 이전 대조와 선택을 버린다. 대조가 도는 중이면 결과를 받지 않게 번호로 구분한다
  const run = useRef(0);
  useEffect(() => {
    run.current += 1;
    setChecks(null);
    setChecking(false);
    setSelected(null);
  }, [asked]);

  const ask = (v: string, r: string, ns: string, n: string) => {
    const query = buildQuery(v, r, ns, n);
    setInvalid(query === null);
    if (query) setAsked(query);
  };
  const preset = (v: string, r: string) => {
    setVerb(v);
    setResource(r);
    ask(v, r, namespace, name);
  };

  const entries = q.data?.entries ?? [];
  // ⌘F: 결과 표 안에서만 찾는다(대조·상세는 모든 결과 기준). 위 질문 칸은 찾기가 아니라 요청이다
  const tab = useRef<HTMLDivElement>(null);
  const find = useListFind(tab, { enabled: q.data !== undefined });
  const listed = fuzzyKeep(entries, find.query, (e) => [e.label, e.subject.name, e.subject.namespace, subjectKindText(e.subject)]);
  const checkOne = async (entry: WhoCan, query: AccessQuery): Promise<[string, Check]> => {
    const key = keyOf(entry.subject);
    // 세션 이름 템플릿에만 기대는 권한은 클러스터에 같은 신원이 없어서 대조하지 않는다
    if (entry.grants.every((g) => g.source.sessionDependent)) return [key, { kind: "skipped" }];
    try {
      const r = await accessApi.review(target, query, entry.subject, ssoProfile);
      return [key, r.allowed ? { kind: "match" } : { kind: "mismatch" }];
    } catch (e) {
      return [key, { kind: "failed", message: e instanceof Error ? e.message : REVIEW_FAILED }];
    }
  };
  const startCheck = async () => {
    if (!asked) return;
    const token = ++run.current;
    setChecking(true);
    const done = new Map<string, Check>();
    setChecks(done);
    const todo = entries.slice(0, CHECK_LIMIT);
    let next = 0;
    const worker = async () => {
      while (next < todo.length && run.current === token) {
        const entry = todo[next++];
        const [key, result] = await checkOne(entry, asked);
        if (run.current !== token) return;
        done.set(key, result);
        setChecks(new Map(done));
      }
    };
    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
    if (run.current === token) setChecking(false);
  };

  const values = checks ? [...checks.values()] : [];
  const match = values.filter((c) => c.kind === "match").length;
  const mismatch = values.filter((c) => c.kind === "mismatch").length;
  const failed = values.filter((c) => c.kind === "failed").length;
  const chosen = entries.find((e) => keyOf(e.subject) === selected);
  const reviewDenied = canReview === "no" ? CHECK_DENIED_TITLE : undefined;

  return (
    <div className="acc-who" ref={tab}>
      <form
        className="acc-form"
        aria-label={WHO_LABEL}
        onSubmit={(e) => {
          e.preventDefault();
          ask(verb, resource, namespace, name);
        }}
      >
        <label>
          {F_VERB}
          <input aria-label={F_VERB} list="acc-verbs" value={verb} onChange={(e) => setVerb(e.target.value)} />
          <datalist id="acc-verbs">
            {VERBS.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </label>
        <label>
          {F_RESOURCE}
          <input aria-label={F_RESOURCE} placeholder={F_RESOURCE_HINT} value={resource} onChange={(e) => setResource(e.target.value)} />
        </label>
        <label>
          {F_NAMESPACE}
          <select aria-label={F_NAMESPACE} value={namespace} onChange={(e) => setNamespace(e.target.value)}>
            <option value="">{NS_CLUSTER}</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          {F_NAME}
          <input aria-label={F_NAME} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn small tone-primary" type="submit">
          {FIND}
        </button>
      </form>
      <div className="acc-presets" role="group" aria-label={PRESETS_LABEL}>
        {PRESETS.map((p) => (
          <button key={p.label} className="btn small tone-ghost" onClick={() => preset(p.verb, p.resource)}>
            {p.label}
          </button>
        ))}
      </div>
      {invalid && <p className="err">{REQUEST_INVALID}</p>}
      {q.isError && <K8sError error={q.error} target={target} ssoProfile={ssoProfile} compact />}
      {asked && !q.data && !q.isError && <div className="empty">{LOADING}</div>}
      {q.data && (
        <div className="acc-results">
          <div className="acc-results-bar">
            <p className="dim">{WHO_INHERITED_NOTE}</p>
            <span className="acc-push" />
            {q.data.total > q.data.entries.length && <span className="dim">{resultsTruncated(q.data.entries.length, q.data.total)}</span>}
            {entries.length > CHECK_LIMIT && <span className="dim">{checkLimited(CHECK_LIMIT)}</span>}
            <button className="btn small tone-secondary" disabled={canReview === "no" || checking || entries.length === 0} title={reviewDenied} aria-description={reviewDenied} onClick={() => void startCheck()}>
              {checking ? CHECK_RUNNING : CHECK_BUTTON}
            </button>
          </div>
          {checks && !checking && <p role="status">{checkSummary(match, mismatch, failed)}</p>}
          <ListFind find={find} placeholder={WHO_FILTER} count={listed.length} />
          <div className="tbl acc-table" tabIndex={0} onKeyDown={(e) => vimTableKeys(e, true)}>
            <table aria-label={WHO_LABEL}>
              <thead>
                <tr>
                  <th>{H_KIND}</th>
                  <th>{H_SUBJECT}</th>
                  <th>{H_PATH}</th>
                  {checks && <th>{H_CHECK}</th>}
                </tr>
              </thead>
              <tbody>
                {listed.map((e) => {
                  const k = keyOf(e.subject);
                  const paths = uniquePaths(e.grants);
                  const c = checks?.get(k);
                  return (
                    <tr key={k} className={selected === k ? "on" : undefined} aria-selected={selected === k} onClick={() => setSelected((s) => (s === k ? null : k))}>
                      <td>{subjectKindText(e.subject)}</td>
                      <td>
                        <SubjectName subject={e.subject} label={e.label} />
                      </td>
                      <td>
                        {paths[0] && <PathLine grant={paths[0]} />}
                        {paths.length > 1 && <span className="dim"> {morePaths(paths.length - 1)}</span>}
                      </td>
                      {checks && (
                        <td>
                          {c?.kind === "match" && <span className="acc-badge ok">{CHECK_MATCH}</span>}
                          {c?.kind === "mismatch" && <span className="acc-badge bad">{CHECK_MISMATCH}: {MISMATCH_TEXT}</span>}
                          {c?.kind === "skipped" && <span className="dim">{CHECK_SKIPPED}</span>}
                          {c?.kind === "failed" && <span className="dim" title={c.message}>{REVIEW_FAILED}</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {listed.length === 0 && <div className="empty small">{entries.length === 0 ? NO_RESULT : NO_IDENTITY_MATCH}</div>}
          </div>
        </div>
      )}
      {chosen && (
        <aside className="k8s-detail" aria-label={DETAIL_LABEL} style={{ width: `${DETAIL_PCT}%` }}>
          <div className="k8s-detail-head">
            <b>{subjectKindText(chosen.subject)}</b>
            <span className="k8s-wrap">
              <SubjectName subject={chosen.subject} label={chosen.label} />
            </span>
            <button className="icon k8s-push tone-ghost" aria-label={CLOSE} title={CLOSE} onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <div className="k8s-actions k8s-toolbar">
            {chosen.subject.kind === "iam" && onOpenIam && (
              <button className="btn small tone-nav" onClick={() => onOpenIam(chosen.subject.name)}>
                {OPEN_IAM}
              </button>
            )}
          </div>
          <div className="k8s-detail-body">
            <h5 className="acc-h">{PATHS_TITLE}</h5>
            <PathList grants={chosen.grants} label={PATHS_TITLE} />
          </div>
        </aside>
      )}
    </div>
  );
}
