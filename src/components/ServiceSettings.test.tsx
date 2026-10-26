import { fireEvent, render, screen } from "@testing-library/react";
import { ServiceSettings } from "./ServiceSettings";
import { sampleServices } from "../test/utils";

test("toggling checkboxes reports new enabled list", () => {
  const onChange = vi.fn();
  render(<ServiceSettings services={sampleServices} enabled={["ec2"]} onChange={onChange} onClose={() => {}} />);
  expect(screen.getByLabelText(/EC2/)).toBeChecked();
  expect(screen.getByLabelText(/IAM/)).not.toBeChecked();
  fireEvent.click(screen.getByLabelText(/IAM/));
  expect(onChange).toHaveBeenLastCalledWith(["ec2", "iam"]);
  fireEvent.click(screen.getByLabelText(/EC2/));
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test("done button and backdrop close the sheet", () => {
  const onClose = vi.fn();
  render(<ServiceSettings services={sampleServices} enabled={[]} onChange={() => {}} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "완료" }));
  fireEvent.click(screen.getByTestId("modal-backdrop"));
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("diff tool section reports tool and custom command", () => {
  const onDiffToolChange = vi.fn();
  render(
    <ServiceSettings
      services={sampleServices}
      enabled={[]}
      onChange={() => {}}
      onClose={() => {}}
      diffTool="filemerge"
      diffToolCommand={null}
      onDiffToolChange={onDiffToolChange}
    />,
  );
  expect(screen.getByLabelText("FileMerge")).toBeChecked();
  fireEvent.click(screen.getByLabelText("VS Code"));
  expect(onDiffToolChange).toHaveBeenLastCalledWith("vscode", null);
  fireEvent.click(screen.getByLabelText("직접 입력"));
  expect(onDiffToolChange).toHaveBeenLastCalledWith("custom", null);
});

test("custom command input appears for custom tool", () => {
  const onDiffToolChange = vi.fn();
  render(
    <ServiceSettings
      services={sampleServices}
      enabled={[]}
      onChange={() => {}}
      onClose={() => {}}
      diffTool="custom"
      diffToolCommand=""
      onDiffToolChange={onDiffToolChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("비교 명령"), { target: { value: "ksdiff {left} {right}" } });
  expect(onDiffToolChange).toHaveBeenLastCalledWith("custom", "ksdiff {left} {right}");
});
