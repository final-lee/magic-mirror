import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { yamlProblems } from "../k8s/yamlDocs";

// 읽기용 YAML 색(.y-*)과 같은 색을 쓴다. JSON도 같은 색(키·문자열·숫자·키워드)
const highlight = HighlightStyle.define([
  { tag: [tags.definition(tags.propertyName), tags.propertyName], color: "var(--syntax-property)" },
  { tag: [tags.string, tags.content], color: "var(--syntax-string)" },
  { tag: [tags.number], color: "var(--syntax-number)" },
  { tag: [tags.bool, tags.null, tags.keyword], color: "var(--syntax-keyword)" },
  { tag: [tags.comment, tags.lineComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.separator, tags.punctuation, tags.meta], color: "var(--syntax-comment)" },
]);

const theme = (minHeight: string) =>
  EditorView.theme(
    {
      "&": { fontSize: "12px", backgroundColor: "var(--code-bg)", color: "var(--text)", borderRadius: "6px", minHeight, maxHeight: "60vh" },
      ".cm-scroller": { fontFamily: "var(--mono, ui-monospace, monospace)", overflow: "auto" },
      ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--syntax-comment)" },
      ".cm-content": { caretColor: "var(--text)" },
      "&.cm-focused": { outline: "1px solid var(--accent)" },
    },
    { dark: false },
  );

/** HuJSON(주석·마지막 쉼표를 허용하는 JSON). 구문 색만 입히고 문법 검사는 서버가 한다 */
const hujsonParser: StreamParser<{ block: boolean }> = {
  startState: () => ({ block: false }),
  token(stream, state) {
    if (state.block) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.block = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.block = true;
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return stream.match(/^\s*:/, false) ? "propertyName" : "string";
    if (stream.eat('"')) {
      stream.skipToEnd();
      return "string";
    }
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:true|false|null)\b/)) return "keyword";
    stream.next();
    return "punctuation";
  },
};

const yamlDiagnostics = (view: EditorView): Diagnostic[] => {
  const length = view.state.doc.length;
  return yamlProblems(view.state.doc.toString()).map((problem) => ({
    from: Math.min(problem.from, length),
    to: Math.min(Math.max(problem.to, problem.from + 1), length),
    severity: "error",
    message: problem.message,
  }));
};

interface Props {
  value: string;
  /** 읽기 전용이면 없어도 된다 */
  onChange?: (text: string) => void;
  /** 보조 기기에 알리는 편집기 이름 */
  label: string;
  /** yaml·json: 줄 번호·구문 색·구문 오류 밑줄. hujson: 줄 번호·구문 색만(주석 허용). text: 여러 줄 글(파라미터·Secret 값 등) */
  language?: "yaml" | "json" | "hujson" | "text";
  /** 비었을 때의 높이. 기본은 문서용 240px, 글은 60px */
  minHeight?: string;
  /** 고칠 수 없게 보여 준다(구문 색·줄 번호는 그대로, 고르기·복사는 된다) */
  readOnly?: boolean;
}

/**
 * 앱의 하나뿐인 여러 줄 편집기(CodeMirror 6). textarea는 쓰지 않는다.
 * yaml·json에서는 Tab·Shift+Tab이 들여쓰기·내어쓰기이고, 다음 칸으로 나가려면 Esc를 누른 뒤 Tab(CodeMirror의 Tab 탈출).
 * text에서는 Tab이 평소처럼 다음 칸으로 간다.
 * 글은 처음 값으로만 채우고 이후에는 편집기가 쥔다: 바깥에서 글을 갈아 끼우려면 key를 바꿔 다시 만든다.
 */
export function CodeEditor({ value, onChange, label, language = "yaml", minHeight = language === "text" ? "60px" : "240px", readOnly = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const document = [lineNumbers(), syntaxHighlighting(highlight), lintGutter(), keymap.of([indentWithTab])];
    const languageExtensions: Extension[] =
      language === "yaml"
        ? [...document, yaml(), linter(yamlDiagnostics, { delay: 200 })]
        : language === "json"
          ? [...document, json(), linter(jsonParseLinter(), { delay: 200 })]
          : language === "hujson"
            ? [...document, StreamLanguage.define(hujsonParser)]
            : [EditorView.lineWrapping];
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          ...languageExtensions,
          theme(minHeight),
          EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true", ...(readOnly ? { "aria-readonly": "true" } : {}) }),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // 글은 처음 값으로만 채운다: 값이 바뀔 때마다 편집기를 다시 만들면 입력 중인 글과 커서를 잃는다
  }, []);

  return <div ref={host} className="code-editor" />;
}
