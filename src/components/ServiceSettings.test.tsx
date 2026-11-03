import { SETTINGS_KUBECONFIG_LABEL, SETTINGS_KUBECONFIG_PLACEHOLDER } from "../k8s/text";
import { fireEvent, render, screen } from "@testing-library/react";
import { ServiceSettings } from "./ServiceSettings";
import { sampleServices } from "../test/utils";

test("theme choice reports the setting to save", () => {
  const onThemeChange = vi.fn();
  const { rerender } = render(<ServiceSettings services={sampleServices} enabled={[]} onChange={() => {}} onClose={() => {}} onThemeChange={onThemeChange} />);
  expect(screen.getByLabelText("시스템 설정 따르기")).toBeChecked();
  fireEvent.click(screen.getByLabelText("밝게"));
  expect(onThemeChange).toHaveBeenCalledWith("light");
  rerender(<ServiceSettings services={sampleServices} enabled={[]} onChange={() => {}} onClose={() => {}} theme="light" onThemeChange={onThemeChange} />);
  expect(screen.getByLabelText("밝게")).toBeChecked();
  fireEvent.click(screen.getByLabelText("어둡게"));
  expect(onThemeChange).toHaveBeenCalledWith("dark");
});

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

test("kubeconfig path field saves on blur and maps empty to null", () => {
  const onKubeconfigPathChange = vi.fn();
  render(
    <ServiceSettings
      services={sampleServices}
      enabled={[]}
      onChange={() => {}}
      onClose={() => {}}
      kubeconfigPath="/old/config"
      onKubeconfigPathChange={onKubeconfigPathChange}
    />,
  );
  const input = screen.getByLabelText(SETTINGS_KUBECONFIG_LABEL);
  expect(input).toHaveValue("/old/config");
  expect(input).toHaveAttribute("placeholder", SETTINGS_KUBECONFIG_PLACEHOLDER);
  fireEvent.change(input, { target: { value: "/new/config" } });
  expect(onKubeconfigPathChange).not.toHaveBeenCalled();
  fireEvent.blur(input);
  expect(onKubeconfigPathChange).toHaveBeenLastCalledWith("/new/config");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(onKubeconfigPathChange).toHaveBeenLastCalledWith(null);
});

test("blurring the kubeconfig path field without a change does nothing", () => {
  const onKubeconfigPathChange = vi.fn();
  const { rerender } = render(
    <ServiceSettings services={sampleServices} enabled={[]} onChange={() => {}} onClose={() => {}} kubeconfigPath="/old/config" onKubeconfigPathChange={onKubeconfigPathChange} />,
  );
  fireEvent.blur(screen.getByLabelText(SETTINGS_KUBECONFIG_LABEL));
  expect(onKubeconfigPathChange).not.toHaveBeenCalled();
  rerender(<ServiceSettings services={sampleServices} enabled={[]} onChange={() => {}} onClose={() => {}} kubeconfigPath={null} onKubeconfigPathChange={onKubeconfigPathChange} />);
  const input = screen.getByLabelText(SETTINGS_KUBECONFIG_LABEL);
  fireEvent.change(input, { target: { value: "  " } });
  fireEvent.blur(input);
  expect(onKubeconfigPathChange).not.toHaveBeenCalled();
});
