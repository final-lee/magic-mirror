import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { YAML_EDITOR_LABEL } from "./text";
import { yamlProblems } from "./yamlDocs";

// 읽기용 YAML 색(.y-*)과 같은 색을 쓴다
const highlight = HighlightStyle.define([
  { tag: [tags.definition(tags.propertyName), tags.propertyName], color: "var(--syntax-property)" },
  { tag: [tags.string, tags.content], color: "var(--syntax-string)" },
  { tag: [tags.number], color: "var(--syntax-number)" },
  { tag: [tags.bool, tags.null, tags.keyword], color: "var(--syntax-keyword)" },
  { tag: [tags.comment, tags.lineComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.separator, tags.punctuation, tags.meta], color: "var(--syntax-comment)" },
]);

const theme = EditorView.theme(
  {
    "&": { fontSize: "12px", backgroundColor: "var(--code-bg)", color: "var(--text)", borderRadius: "6px", minHeight: "240px", maxHeight: "60vh" },
    ".cm-scroller": { fontFamily: "var(--mono, ui-monospace, monospace)", overflow: "auto" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--syntax-comment)" },
    ".cm-content": { caretColor: "var(--text)" },
    "&.cm-focused": { outline: "1px solid var(--accent)" },
  },
  { dark: false },
);

interface Props {
  value: string;
  onChange: (text: string) => void;
  /** 보조 기기에 알리는 편집기 이름 */
  label?: string;
}

/** CodeMirror 6 YAML 편집기. 구문 오류는 줄에 밑줄로 보인다. 글은 처음 값으로만 채우고 이후에는 편집기가 쥔다. */
export function YamlEditor({ value, onChange, label = YAML_EDITOR_LABEL }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const diagnostics = (view: EditorView): Diagnostic[] => {
      const length = view.state.doc.length;
      return yamlProblems(view.state.doc.toString()).map((problem) => ({
        from: Math.min(problem.from, length),
        to: Math.min(Math.max(problem.to, problem.from + 1), length),
        severity: "error",
        message: problem.message,
      }));
    };
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          yaml(),
          syntaxHighlighting(highlight),
          linter(diagnostics, { delay: 200 }),
          lintGutter(),
          theme,
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

  return <div ref={host} className="k8s-yaml-editor" data-testid="yaml-editor" />;
}
