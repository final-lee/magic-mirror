import { fireEvent, screen } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { invoke } from "../api/invoke";
import { renderWithClient } from "../test/utils";
import { OrgView } from "./OrgView";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./orgText";

vi.mock("../api/invoke", () => ({ invoke: vi.fn() }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));

test("creation previews the organization request and shows the one-time secret", async () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  vi.mocked(invoke).mockResolvedValueOnce([]).mockResolvedValueOnce({ id: "T1", displayName: "Staging", oauthClient: { id: "k1", secret: "once" } }).mockResolvedValue([]);
  renderWithClient(<OrgView />);
  fireEvent.change(screen.getByLabelText(t.NAME), { target: { value: "Staging" } });
  fireEvent.click(screen.getByRole("button", { name: t.CREATE }));
  expect(screen.getByText(/POST \/organizations\/-\/tailnets/)).toHaveTextContent("Staging");
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "tailscale_org_create")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: t.APPLY }));
  expect(await screen.findByText("once")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: t.COPY }));
  expect(desktop.copy).toHaveBeenCalledWith("once");
});
