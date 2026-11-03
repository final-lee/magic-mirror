import { act, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

/** 화면에 떠 있는 CodeMirror 편집기. 이름(label)을 주면 그 이름의 편집기, 없으면 처음 것 */
export function editorView(label?: string): EditorView {
  const dom = label ? screen.getByLabelText(label).closest<HTMLElement>(".cm-editor") : document.querySelector<HTMLElement>(".cm-editor");
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error("편집기가 없어요");
  return view;
}

/** 사용자가 글을 통째로 바꾼 것처럼 넣는다 */
export function typeYaml(text: string, label?: string) {
  const view = editorView(label);
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
}
