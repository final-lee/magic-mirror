import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage } from "../api/errors";
import { iamApi } from "./api";
import type { ValidationResult } from "./types";

/** 새 정책의 시작 문서. 그대로 저장해도 아무 권한도 주지 않는 자리표시 작업이다. */
export const NEW_POLICY_TEMPLATE = JSON.stringify(
  { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "service:Action", Resource: "*" }] },
  null,
  2,
);

const NAME_PATTERN = /^[\w+=,.@-]+$/;
const MAX_NAME = 128;

interface Parsed {
  error: string | null;
  /** 공백을 없앤 JSON. 서식만 다른 문서를 같은 문서로 비교하는 데 쓴다 */
  normalized: string | null;
}

function parseDocument(text: string): Parsed {
  if (text.trim() === "") return { error: "내용을 입력하세요", normalized: null };
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "정책은 JSON 객체여야 해요", normalized: null };
    return { error: null, normalized: JSON.stringify(value) };
  } catch (e) {
    return { error: `JSON 형식이 올바르지 않아요 · ${e instanceof Error ? e.message : String(e)}`, normalized: null };
  }
}

/** 새 인라인 정책의 이름 검사. 같은 이름이 있으면 PutXxxPolicy가 조용히 덮어쓰므로 여기서 막는다. */
function nameProblem(name: string, existing: string[]): string | null {
  if (name === "") return "정책 이름을 입력하세요";
  if (name.length > MAX_NAME) return `이름은 ${MAX_NAME}자까지 쓸 수 있어요`;
  if (!NAME_PATTERN.test(name)) return "이름에는 영문자, 숫자, + = , . @ _ - 만 쓸 수 있어요";
  if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) return "같은 이름의 인라인 정책이 이미 있어요. 그 정책을 편집하세요";
  return null;
}

const FINDING_ORDER: ValidationResult["findings"][number]["level"][] = ["error", "securityWarning", "warning", "suggestion"];
const FINDING_TEXT = { error: "오류", securityWarning: "보안 경고", warning: "경고", suggestion: "제안" } as const;
const FINDING_CHIP = { error: "denied", securityWarning: "boundary", warning: "conditional", suggestion: "" } as const;

interface Check {
  /** 검사한 문서. 지금 문서와 다르면 결과를 보여주지 않는다 */
  doc: string;
  state: "running" | "done" | "error";
  result?: ValidationResult;
  error?: string;
}

interface Props {
  profile: string;
  /** new: 새 인라인 정책(이름을 입력받는다) · edit: 이미 있는 정책(이름은 고정) */
  mode: "new" | "edit";
  /** edit일 때의 정책 이름 */
  name?: string;
  /** new일 때 이미 있는 인라인 정책 이름 */
  existingNames?: string[];
  title: string;
  /** 처음 보여줄 문서. new에서 생략하면 시작 문서를 쓴다 */
  document?: string;
  onSubmit: (name: string, document: string) => void;
  onCancel: () => void;
}

/**
 * 정책 JSON 편집기. 입력하는 동안 JSON 문법을 바로 확인하고, [검사]로 AWS 정책 검사기 결과를 받고,
 * [미리보기]로 변경 흐름에 넘긴다(여기서 직접 저장하지 않는다).
 */
export function PolicyEditor({ profile, mode, name: fixedName = "", existingNames = [], title, document: initial, onSubmit, onCancel }: Props) {
  const start = initial ?? (mode === "new" ? NEW_POLICY_TEMPLATE : "");
  const baseline = useRef(parseDocument(start).normalized);
  const escaped = useRef(false);
  const results = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(start);
  const [name, setName] = useState("");
  const [check, setCheck] = useState<Check | null>(null);

  const doc = text.trim();
  const parsed = parseDocument(text);
  const nameValue = mode === "new" ? name.trim() : fixedName;
  const problem = mode === "new" ? nameProblem(nameValue, existingNames) : null;
  const unchanged = mode === "edit" && parsed.normalized !== null && parsed.normalized === baseline.current;
  const canSubmit = !parsed.error && !problem && !unchanged;
  const shown = check && check.doc === doc ? check : null;

  // 편집 상자가 커서 검사 결과가 화면 밖에 놓이기 쉽다. 검사가 끝나면 결과가 보이는 곳까지 스크롤한다.
  const finished = shown && shown.state !== "running" ? shown.state : null;
  useEffect(() => {
    if (finished) results.current?.scrollIntoView?.({ block: "nearest" });
  }, [finished]);

  const validate = async () => {
    setCheck({ doc, state: "running" });
    try {
      const result = await iamApi.validatePolicy(profile, doc);
      setCheck((c) => (c?.doc === doc ? { doc, state: "done", result } : c));
    } catch (e) {
      setCheck((c) => (c?.doc === doc ? { doc, state: "error", error: errorMessage(e) } : c));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      escaped.current = true; // 키보드로 이 칸을 빠져나가는 길: Esc 다음의 Tab은 초점을 옮긴다
      return;
    }
    if (e.key !== "Tab") {
      if (e.key !== "Shift") escaped.current = false;
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
    setText(el.value);
  };

  return (
    <section className="pe" aria-label="정책 편집기">
      <h3>{title}</h3>
      {mode === "new" ? (
        <label className="field">
          <span>정책 이름</span>
          <input aria-label="정책 이름" className="mono" value={name} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
          {name !== "" && problem && <span className="err">{problem}</span>}
        </label>
      ) : (
        <div className="pe-name">
          <span className="dim">정책 이름</span> <b className="mono">{fixedName}</b>
        </div>
      )}
      <label className="field">
        <span>정책 JSON</span>
        <textarea
          aria-label="정책 JSON"
          className="pe-text mono"
          spellCheck={false}
          autoCapitalize="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => (escaped.current = false)}
        />
      </label>
      {parsed.error ? (
        <div className="err pe-line" role="alert">
          {parsed.error}
        </div>
      ) : (
        <div className="ok pe-line">JSON 형식이 맞아요{unchanged && <span className="dim"> · 바꾼 내용이 없어요</span>}</div>
      )}
      <div className="dim pe-tip">Tab은 공백 2칸을 넣어요. 다른 칸으로 나가려면 Esc를 누른 뒤 Tab을 누르세요</div>

      <div className="pe-actions">
        <button className="btn small" disabled={!!parsed.error || shown?.state === "running"} onClick={() => void validate()}>
          검사
        </button>
        <span className="pe-end">
          <button className="btn plain" onClick={onCancel}>
            취소
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={() => onSubmit(nameValue, doc)}>
            미리보기
          </button>
        </span>
      </div>
      {unchanged && <div className="dim pe-tip">바꾼 내용이 없어요</div>}
      <div className="pe-results" ref={results}>
        {shown && <CheckResult check={shown} />}
      </div>
    </section>
  );
}

function CheckResult({ check }: { check: Check }) {
  if (check.state === "running") return <p className="up-progress">AWS 정책 검사기로 확인하는 중이에요…</p>;
  if (check.state === "error") return <div className="err pe-line">{check.error}</div>;
  const result = check.result!;
  const findings = [...result.findings].sort((a, b) => FINDING_ORDER.indexOf(a.level) - FINDING_ORDER.indexOf(b.level));
  const clean = result.analyzerAvailable && !result.syntaxError && findings.length === 0;
  return (
    <div className="pe-result" aria-live="polite">
      {result.syntaxError && <div className="err pe-line">{result.syntaxError}</div>}
      {!result.analyzerAvailable && (
        <div className="iam-hint">
          <span aria-hidden="true">ⓘ</span> AWS 정책 검사기를 쓸 수 없어요. access-analyzer:ValidatePolicy 권한이 없어서 JSON 문법만 확인했어요
        </div>
      )}
      {clean && <div className="ok pe-line">검사에서 문제가 발견되지 않았어요</div>}
      {findings.length > 0 && (
        <ul className="pe-findings" aria-label="검사 결과">
          {findings.map((f, i) => (
            <li key={i} data-level={f.level}>
              <span className={`iam-chip ${FINDING_CHIP[f.level]}`}>{FINDING_TEXT[f.level]}</span> <span className="mono dim">{f.code}</span>
              <div>{f.message}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
