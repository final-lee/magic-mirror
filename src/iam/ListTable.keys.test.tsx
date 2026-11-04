import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ListTable } from "./ListTable";

function Table({ vimKeys }: { vimKeys?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const rows = ["a", "b", "c"];
  return (
    <>
      <output data-testid="selected">{selected ?? ""}</output>
      <ListTable label="t" rows={rows} columns={[{ key: "n", label: "이름", render: (r) => r, sort: (r) => r }]} rowKey={(r) => r}
        selectedId={selected} onSelect={setSelected} onClear={() => setSelected(null)} onOpen={setSelected} empty="없음" vimKeys={vimKeys} />
    </>
  );
}
const selected = () => screen.getByTestId("selected").textContent;
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(screen.getByTestId("iam-list"), { key, ...init });

test("with vimKeys j, k, g and G move like the arrow keys and jump to the ends", () => {
  render(<Table vimKeys />);
  press("j");
  expect(selected()).toBe("a");
  press("j");
  expect(selected()).toBe("b");
  press("G");
  expect(selected()).toBe("c");
  press("k");
  expect(selected()).toBe("b");
  press("g");
  expect(selected()).toBe("a");
});

test("without vimKeys the letters do nothing, and the arrows still work", () => {
  render(<Table />);
  for (const key of ["j", "k", "g", "G"]) press(key);
  expect(selected()).toBe("");
  press("ArrowDown");
  expect(selected()).toBe("a");
});

test("vimKeys ignore the letters with ⌘, ⌃ or ⌥", () => {
  render(<Table vimKeys />);
  press("j", { metaKey: true });
  press("j", { ctrlKey: true });
  press("j", { altKey: true });
  expect(selected()).toBe("");
});
