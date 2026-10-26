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
