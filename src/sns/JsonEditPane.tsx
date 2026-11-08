import { useMemo, useState, type ReactNode } from "react";
import { CodeEditor } from "../components/CodeEditor";
import * as t from "./editText";

/** JSON 글을 읽어 보고 문제를 한 줄로. 비어 있으면 `empty` */
export function jsonProblem(text: string): { kind: "empty" } | { kind: "bad"; message: string } | { kind: "ok" } {
  if (text.trim() === "") return { kind: "empty" };
  try {
    JSON.parse(text);
    return { kind: "ok" };
  } catch (e) {
    return { kind: "bad", message: t.EDITOR_BAD_JSON(e instanceof Error ? e.message : String(e)) };
  }
}

interface Props {
  /** 편집기 이름(보조 기기용) */
  label: string;
  /** 처음 글. 편집기는 처음 값으로만 채운다 */
  initial: string;
  /** 비워서 미리 볼 수 있는가(필터·배달 정책을 지우는 변경). 아니면 빈 글은 막는다 */
  allowEmpty: boolean;
  emptyHint?: string;
  /** 편집기 위에 둘 입력(필터 범위 고르기 같은 것) */
  children?: ReactNode;
  /** [미리 보기…]: 글을 넘긴다(비어 있으면 null). 아무것도 바꾸지 않는다 */
  onPreview: (text: string | null) => void;
  onCancel: () => void;
  /** 편집기 밖에서 막을 이유(있으면 [미리 보기…]가 꺼진다) */
  blocked?: string | null;
}

/**
 * 같은 자리에서 바뀌는 JSON 편집기(CodeEditor). 입력하는 동안 문법을 바로 확인한다.
 * [편집 취소]는 투명(취소), [미리 보기…]는 파랑(실행): 편집 모드로 들어오게 한 [편집]은 보조(회색)다.
 */
export function JsonEditPane({ label, initial, allowEmpty, emptyHint, children, onPreview, onCancel, blocked = null }: Props) {
  const [text, setText] = useState(initial);
  const problem = useMemo(() => jsonProblem(text), [text]);
  const why = blocked ?? (problem.kind === "bad" ? problem.message : problem.kind === "empty" && !allowEmpty ? t.EDITOR_EMPTY : null);
  return (
    <div className="sns-edit">
      {children}
      <CodeEditor value={initial} onChange={setText} label={label} language="json" minHeight="160px" />
      {problem.kind === "bad" && (
        <p className="sns-note sns-error" role="alert">
          {problem.message}
        </p>
      )}
      {problem.kind === "empty" && allowEmpty && emptyHint && <p className="sns-note dim">{emptyHint}</p>}
      <div className="sns-edit-foot">
        <button type="button" className="btn small tone-ghost" onClick={onCancel}>
          {t.EDIT_CANCEL}
        </button>
        <button type="button" className="btn small tone-primary" disabled={why !== null} title={why ?? undefined} aria-description={why ?? undefined} onClick={() => onPreview(problem.kind === "empty" ? null : text)}>
          {t.PREVIEW}
        </button>
      </div>
    </div>
  );
}
