import { fireEvent, render, screen } from "@testing-library/react";
import { KindTree } from "./KindTree";
import { CATEGORIES, DEPLOYMENTS, PODS } from "./kinds";
import { CAT_WORKLOADS, KIND_TREE_LABEL } from "./text";

test("shows categories, marks the selected kind, and selects on click", () => {
  const onSelect = vi.fn();
  render(<KindTree categories={CATEGORIES} selected={PODS} onSelect={onSelect} />);
  expect(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).toBeInTheDocument();
  expect(screen.getByText(CAT_WORKLOADS)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pod" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Deployment" })).not.toHaveAttribute("aria-current");
  fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
  expect(onSelect).toHaveBeenCalledWith(DEPLOYMENTS);
});
