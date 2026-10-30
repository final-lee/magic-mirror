import { fireEvent, render, screen } from "@testing-library/react";
import { ContextPicker } from "./ContextPicker";
import { savedMissing } from "./text";

const c = (name: string) => ({ name, cluster: "c", user: `${name}-u`, namespace: null, execProfile: null });

test("lists candidates, reports the missing saved one, and picks", () => {
  const onPick = vi.fn();
  render(<ContextPicker candidates={[c("a"), c("b")]} missing="old" onPick={onPick} />);
  expect(screen.getByText(savedMissing("old"))).toBeInTheDocument();
  fireEvent.click(screen.getByText("b").closest("button")!);
  expect(onPick).toHaveBeenCalledWith("b");
});
