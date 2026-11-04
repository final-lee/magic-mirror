import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import type { K8sPlugin } from "../../api/types";
import { PluginSettings } from "./PluginSettings";

function Editor() {
  const [plugins, setPlugins] = useState<K8sPlugin[]>([]);
  return <PluginSettings plugins={plugins} onChange={setPlugins} />;
}

test("adds, edits, validates and removes a plugin", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "플러그인 추가" }));
  fireEvent.change(screen.getByLabelText("이름"), { target: { value: "보기" } });
  fireEvent.change(screen.getByLabelText("명령"), { target: { value: "kubectl get $KIND $NAME" } });
  fireEvent.change(screen.getByLabelText("단축키"), { target: { value: "cmd+f" } });
  expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("단축키"), { target: { value: "ctrl+alt+z" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(screen.getByText("보기")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "편집" }));
  expect(screen.getByLabelText("실행 전 확인")).toBeChecked();
  fireEvent.change(screen.getByLabelText("이름"), { target: { value: "고친 이름" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(screen.getByText("고친 이름")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));
  expect(screen.queryByText("고친 이름")).not.toBeInTheDocument();
});
