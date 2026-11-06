import { useState } from "react";
import { errorMessage } from "../api/errors";
import { tailscaleApi } from "./api";
import * as p from "./policyText";
import type { PolicyPreviewKind, PolicyRuleMatch } from "./policyTypes";

interface Result {
  kind: PolicyPreviewKind;
  subject: string;
  /** 판정에 쓴 정책 글. 줄 번호는 이 글의 줄이다 */
  text: string;
  matches: PolicyRuleMatch[];
}

/** "누가 무엇에 닿나": 이메일이나 IP:포트에 맞는 규칙들. 편집 중인 정책(저장 전)으로 판정한다. */
export function PolicyAccess({ tailnet, text, edited }: { tailnet: string; text: string; edited: boolean }) {
  const [kind, setKind] = useState<PolicyPreviewKind>("user");
  const [subject, setSubject] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const target = subject.trim();
    setRunning(true);
    setError(null);
    try {
      const matches = await tailscaleApi.policyPreview(tailnet, kind, target, text);
      setResult({ kind, subject: target, text, matches });
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const lineOf = (r: Result, match: PolicyRuleMatch) => r.text.split("\n")[match.lineNumber - 1]?.trim() ?? "";

  return (
    <section className="ts-policy-section" aria-label={p.ACCESS}>
      <h3>{p.ACCESS}</h3>
      <form
        className="ts-policy-access"
        onSubmit={(e) => {
          e.preventDefault();
          if (subject.trim() && !running) void run();
        }}
      >
        <select aria-label={p.ACCESS_KIND} value={kind} onChange={(e) => setKind(e.target.value as PolicyPreviewKind)}>
          <option value="user">{p.ACCESS_USER}</option>
          <option value="ipport">{p.ACCESS_IPPORT}</option>
        </select>
        <input
          aria-label={p.ACCESS_SUBJECT}
          placeholder={kind === "user" ? p.ACCESS_USER_PLACEHOLDER : p.ACCESS_IPPORT_PLACEHOLDER}
          value={subject}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSubject(e.target.value)}
        />
        <button className="btn small" type="submit" disabled={running || subject.trim() === ""}>
          {running ? p.ACCESS_RUNNING : p.ACCESS_RUN}
        </button>
        <span className="dim">{edited ? p.ACCESS_DRAFT : p.ACCESS_SAVED}</span>
      </form>
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      {result && (
        <div aria-live="polite">
          <p className="dim">{p.accessResult(result.matches.length, result.subject)}</p>
          {result.matches.length === 0 ? (
            <p>{p.ACCESS_NONE}</p>
          ) : (
            <div className="argowf-table-wrap">
              <table className="argowf-table">
                <thead>
                  <tr>
                    <th>{p.ACCESS_SOURCES}</th>
                    <th>{p.ACCESS_TARGETS}</th>
                    <th>{p.ACCESS_LINE}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matches.map((m, i) => (
                    <tr key={i}>
                      <td className="mono">{m.users.join(", ")}</td>
                      <td className="mono">{m.ports.join(", ")}</td>
                      <td>
                        <span className="dim">{m.lineNumber}</span> <code className="mono">{lineOf(result, m)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
