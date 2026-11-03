import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { yamlProblems } from "../k8s/yamlDocs";

// 읽기용 YAML 색(.y-*)과 같은 색을 쓴다
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
  onChange: (text: string) => void;
  /** 보조 기기에 알리는 편집기 이름 */
  label: string;
  /** yaml: 줄 번호·구문 색·구문 오류 밑줄. text: 여러 줄 글(파라미터 값 등) */
  language?: "yaml" | "text";
  /** 비었을 때의 높이. 기본은 YAML 문서용 240px */
  minHeight?: string;
}

/**
 * 앱의 하나뿐인 여러 줄 편집기(CodeMirror 6). textarea는 쓰지 않는다.
 * 글은 처음 값으로만 채우고 이후에는 편집기가 쥔다: 바깥에서 글을 갈아 끼우려면 key를 바꿔 다시 만든다.
 */
export function CodeEditor({ value, onChange, label, language = "yaml", minHeight = language === "yaml" ? "240px" : "60px" }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const languageExtensions: Extension[] =
      language === "yaml"
        ? [lineNumbers(), yaml(), syntaxHighlighting(highlight), linter(yamlDiagnostics, { delay: 200 }), lintGutter()]
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
          EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // 글은 처음 값으로만 채운다: 값이 바뀔 때마다 편집기를 다시 만들면 입력 중인 글과 커서를 잃는다
  }, []);

  return <div ref={host} className="code-editor" />;
}
