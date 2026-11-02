import { fireEvent, render, screen } from "@testing-library/react";
import { KindTree } from "./KindTree";
import { CATEGORIES, DEPLOYMENTS, PODS, bookmarkKey } from "./kinds";
import { CAT_WORKLOADS, KIND_TREE_LABEL, bookmarkAdd, bookmarkRemove } from "./text";

test("shows categories, marks the selected kind, and selects on click", () => {
  const onSelect = vi.fn();
  render(<KindTree categories={CATEGORIES} selected={PODS} onSelect={onSelect} bookmarked={new Set()} onToggleBookmark={vi.fn()} />);
  expect(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).toBeInTheDocument();
  expect(screen.getByText(CAT_WORKLOADS)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pod" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Deployment" })).not.toHaveAttribute("aria-current");
  fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
  expect(onSelect).toHaveBeenCalledWith(DEPLOYMENTS);
});

test("the star bookmarks a kind or removes its bookmark without selecting it", () => {
  const onSelect = vi.fn();
  const onToggleBookmark = vi.fn();
  render(<KindTree categories={CATEGORIES} selected={PODS} onSelect={onSelect} bookmarked={new Set([bookmarkKey(DEPLOYMENTS)])} onToggleBookmark={onToggleBookmark} />);
  expect(screen.getByRole("button", { name: bookmarkRemove("Deployment") })).toHaveAttribute("aria-pressed", "true");
  const podStar = screen.getByRole("button", { name: bookmarkAdd("Pod") });
  expect(podStar).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(podStar);
  expect(onToggleBookmark).toHaveBeenCalledWith(PODS);
  expect(onSelect).not.toHaveBeenCalled();
});
