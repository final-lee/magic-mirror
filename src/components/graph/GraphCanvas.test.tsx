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

/** 지도를 한 번 눌러 잡는다(그 누름은 끌기를 시작하지 않는다) */
function grab(frame: HTMLElement) {
  fireEvent.mouseDown(frame, { clientX: 0, clientY: 0 });
  fireEvent.mouseUp(frame);
}

test("the wheel scrolls past until the frame is grabbed, then zooms within limits, and stops when focus leaves", () => {
  const { group } = setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  // 잡지 않았으면 휠을 막지 않는다(fireEvent는 기본 동작이 막히지 않았으면 true): 화면이 스크롤된다
  expect(fireEvent.wheel(frame, { deltaY: -100 })).toBe(true);
  expect(group().getAttribute("transform")).toContain("scale(1)");
  grab(frame);
  expect(frame).toHaveFocus();
  expect(frame).toHaveClass("grabbed");
  expect(fireEvent.wheel(frame, { deltaY: -100 })).toBe(false);
  expect(group().getAttribute("transform")).toContain("scale(1.1)");
  for (let i = 0; i < 60; i++) fireEvent.wheel(frame, { deltaY: -100 });
  expect(group().getAttribute("transform")).toContain("scale(3)");
  fireEvent.blur(frame);
  expect(frame).not.toHaveClass("grabbed");
  expect(fireEvent.wheel(frame, { deltaY: 100 })).toBe(true);
  expect(group().getAttribute("transform")).toContain("scale(3)");
});

test("the press that grabs does not pan; dragging after that does", () => {
  const { group } = setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  fireEvent.mouseDown(frame, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(frame, { clientX: 130, clientY: 90 });
  fireEvent.mouseUp(frame);
  expect(group().getAttribute("transform")).toBe("translate(0,0) scale(1)");
  fireEvent.mouseDown(frame, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(frame, { clientX: 130, clientY: 90 });
  fireEvent.mouseUp(frame);
  expect(group().getAttribute("transform")).toBe("translate(30,-10) scale(1)");
});

test("pressing to drag does not start a text selection, other buttons are left alone", () => {
  setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  // fireEvent는 기본 동작이 막혔으면 false를 돌려준다
  expect(fireEvent.mouseDown(frame, { button: 0 })).toBe(false);
  expect(fireEvent.mouseDown(frame, { button: 2 })).toBe(true);
});

test("the frame grows with the drawing at the frame's width, between the minimum and 3/4 of the window", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(816);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(1000);
  try {
    const frameOf = (label: string) => screen.getByRole("img", { name: label }).parentElement!;
    render(
      <>
        {/* 맞춤 1.25배(최대)라 200 × 1.25 + 16 = 266 */}
        <GraphCanvas width={400} height={200} label="보통">
          <g />
        </GraphCanvas>
        {/* 800/1600 = 0.5배라 100 × 0.5 + 16 = 66 → 최소 220 */}
        <GraphCanvas width={1600} height={100} label="납작">
          <g />
        </GraphCanvas>
        {/* 1.25 × 2000 → 창 높이의 3/4 = 750 */}
        <GraphCanvas width={400} height={2000} label="길쭉">
          <g />
        </GraphCanvas>
        <GraphCanvas width={400} height={2000} label="채움" fill minHeight={300}>
          <g />
        </GraphCanvas>
      </>,
    );
    expect(frameOf("보통").style.height).toBe("266px");
    expect(frameOf("납작").style.height).toBe("220px");
    expect(frameOf("길쭉").style.height).toBe("750px");
    expect(frameOf("채움").style.height).toBe("");
    expect(frameOf("채움").style.minHeight).toBe("300px");
  } finally {
    vi.restoreAllMocks();
  }
});

test("a click is a click, but letting go of a drag over a node is not", () => {
  const { onClick } = setup();
  const frame = screen.getByRole("img", { name: "시험 그래프" }).parentElement!;
  fireEvent.click(screen.getByRole("button", { name: "노드" }));
  expect(onClick).toHaveBeenCalledTimes(1);
  grab(frame);
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
