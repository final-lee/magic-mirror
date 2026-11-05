import { fireEvent, render, screen } from "@testing-library/react";
import { GraphCanvas, GraphEdgeLine } from "./GraphCanvas";

function setup(onClick = vi.fn()) {
  render(
    <GraphCanvas width={400} height={200} label="시험 그래프">
      <GraphEdgeLine path="M0,0 L10,10" mid={{ x: 5, y: 5 }} label="12" tone="bad" />
      <g role="button" aria-label="노드" onClick={onClick}>
        <rect width={10} height={10} />
      </g>
    </GraphCanvas>,
  );
  return { onClick, group: () => screen.getByRole("img", { name: "시험 그래프" }).querySelector("g[transform]") as SVGGElement };
}

test("draws the edge with its label and an arrow of its colour", () => {
  setup();
  expect(screen.getByText("12")).toBeInTheDocument();
  const path = screen.getByRole("img", { name: "시험 그래프" }).querySelector(".kvg-tone-bad path[marker-end]")!;
  expect(path.getAttribute("marker-end")).toMatch(/^url\(#.+-bad\)$/);
  const id = /url\(#(.+)\)/.exec(path.getAttribute("marker-end")!)![1];
  expect(document.getElementById(id)).not.toBeNull();
});

test("the zoom buttons scale the drawing and [100%] resets it", () => {
  const { group } = setup();
  expect(screen.getByText("100%", { selector: ".kvg-zoom" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "확대" }));
  expect(group().getAttribute("transform")).toContain("scale(1.25)");
  expect(screen.getByText("125%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "축소" }));
  fireEvent.click(screen.getByRole("button", { name: "축소" }));
  expect(group().getAttribute("transform")).toContain("scale(0.8)");
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  expect(group().getAttribute("transform")).toBe("translate(0,0) scale(1)");
});

test("the wheel zooms, within limits", () => {
  const { group } = setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  fireEvent.wheel(frame, { deltaY: -100 });
  expect(group().getAttribute("transform")).toContain("scale(1.1)");
  for (let i = 0; i < 60; i++) fireEvent.wheel(frame, { deltaY: -100 });
  expect(group().getAttribute("transform")).toContain("scale(3)");
});

test("dragging pans the drawing", () => {
  const { group } = setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  fireEvent.mouseDown(frame, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(frame, { clientX: 130, clientY: 90 });
  fireEvent.mouseUp(frame);
  expect(group().getAttribute("transform")).toBe("translate(30,-10) scale(1)");
});

test("a click is a click, but letting go of a drag over a node is not", () => {
  const { onClick } = setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  fireEvent.click(screen.getByRole("button", { name: "노드" }));
  expect(onClick).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(frame, { clientX: 0, clientY: 0 });
  fireEvent.mouseMove(frame, { clientX: 40, clientY: 0 });
  fireEvent.mouseUp(frame);
  fireEvent.click(screen.getByRole("button", { name: "노드" }));
  expect(onClick).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "노드" }));
  expect(onClick).toHaveBeenCalledTimes(2);
});

test("[맞춤] fits the whole drawing into the frame", () => {
  const { group } = setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  Object.defineProperty(frame, "clientWidth", { value: 216, configurable: true });
  Object.defineProperty(frame, "clientHeight", { value: 116, configurable: true });
  fireEvent.click(screen.getByRole("button", { name: "맞춤" }));
  // (216-16)/400 = 0.5, (116-16)/200 = 0.5
  expect(group().getAttribute("transform")).toBe("translate(8,8) scale(0.5)");
});
