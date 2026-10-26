import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ActionInput, MAX_SUGGESTIONS, matchActions } from "./ActionInput";
import { catalogActions } from "./fixtures";

describe("matchActions", () => {
  test("a blank query suggests nothing instead of dumping the catalog", () => {
    expect(matchActions(catalogActions, "")).toEqual([]);
    expect(matchActions(catalogActions, "   ")).toEqual([]);
  });

  test("matches prefixes and substrings, ignoring case", () => {
    expect(matchActions(catalogActions, "S3:GET")).toEqual(["s3:GetObject", "s3:GetObjectAcl"]);
    expect(matchActions(catalogActions, "getobj")).toEqual(["s3:GetObject", "s3:GetObjectAcl"]);
    expect(matchActions(catalogActions, "nothing-like-this")).toEqual([]);
  });

  test("lists matches that start with the query before the ones that merely contain it", () => {
    const options = ["ses:GetS3Thing", "s3:GetObject", "ec2:DescribeS3Stuff"];
    expect(matchActions(options, "s3")).toEqual(["s3:GetObject", "ses:GetS3Thing", "ec2:DescribeS3Stuff"]);
  });

  test("returns at most 50 suggestions", () => {
    const many = Array.from({ length: 120 }, (_, i) => `s3:Action${String(i).padStart(3, "0")}`);
    const hits = matchActions(many, "s3:");
    expect(MAX_SUGGESTIONS).toBe(50);
    expect(hits).toHaveLength(50);
    expect(hits[0]).toBe("s3:Action000");
    // 접두어 일치가 가득 차도 부분 일치에 밀리지 않는다
    expect(matchActions(["x:s3:Late", ...many], "s3:")).not.toContain("x:s3:Late");
  });
});

function Harness({ initial = "", onSubmit = vi.fn(), options = catalogActions }: { initial?: string; onSubmit?: () => void; options?: string[] }) {
  const [value, setValue] = useState(initial);
  return <ActionInput label="작업" value={value} onChange={setValue} onSubmit={onSubmit} options={options} placeholder="s3:GetObject" />;
}
const input = () => screen.getByRole("combobox", { name: "작업" }) as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const key = (k: string) => fireEvent.keyDown(input(), { key: k });
const optionNames = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("ActionInput", () => {
  test("shows suggestions while typing and nothing for an empty box", () => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    type("s3:get");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(optionNames()).toEqual(["s3:GetObject", "s3:GetObjectAcl"]);
    expect(input()).toHaveAttribute("aria-expanded", "true");
    type("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  test("shows no list when nothing matches", () => {
    render(<Harness />);
    type("zzz");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  test("clicking a suggestion fills the box and closes the list without searching", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("put");
    fireEvent.click(screen.getByRole("option", { name: "s3:PutObject" }));
    expect(input().value).toBe("s3:PutObject");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("↓ and ↑ move the highlight and Enter picks it; the next Enter submits", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("s3:get");
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);

    key("ArrowDown");
    expect(screen.getByRole("option", { name: "s3:GetObject" })).toHaveAttribute("aria-selected", "true");
    key("ArrowDown");
    const second = screen.getByRole("option", { name: "s3:GetObjectAcl" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input()).toHaveAttribute("aria-activedescendant", second.id);
    key("ArrowDown"); // 끝에서는 더 내려가지 않는다
    expect(second).toHaveAttribute("aria-selected", "true");
    key("ArrowUp");
    expect(screen.getByRole("option", { name: "s3:GetObject" })).toHaveAttribute("aria-selected", "true");

    key("ArrowDown");
    key("Enter");
    expect(input().value).toBe("s3:GetObjectAcl");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    key("Enter");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("Enter without a highlighted suggestion submits what was typed", () => {
    const onSubmit = vi.fn();
    render(<Harness initial="s3:GetObject" onSubmit={onSubmit} />);
    type("s3:get");
    key("Enter");
    expect(input().value).toBe("s3:get");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("Escape closes the list and ↓ opens it again", () => {
    render(<Harness />);
    type("s3:l");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    key("Escape");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    key("ArrowDown");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "s3:ListBucket" })).toHaveAttribute("aria-selected", "true");
  });

  test("losing focus closes the list", () => {
    render(<Harness />);
    type("s3:");
    fireEvent.blur(input());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  test("typing again resets the highlight", () => {
    render(<Harness />);
    type("s3:");
    key("ArrowDown");
    key("ArrowDown");
    type("s3:p");
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    expect(input()).not.toHaveAttribute("aria-activedescendant");
  });

  test("renders at most 50 suggestions", () => {
    const many = Array.from({ length: 120 }, (_, i) => `s3:Action${i}`);
    render(<Harness options={many} />);
    type("s3:");
    expect(screen.getAllByRole("option")).toHaveLength(50);
  });
});
