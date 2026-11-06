import { fireEvent, screen } from "@testing-library/react";
import { invoke } from "../api/invoke";
import { renderWithClient } from "../test/utils";
import { ServicesView } from "./ServicesView";
import { useTailscaleApi } from "./useTailscaleApi";
import * as t from "./servicesText";

vi.mock("../api/invoke", () => ({ invoke: vi.fn() }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));

test("service creation previews its exact PUT before applying", async () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  vi.mocked(invoke).mockResolvedValueOnce([]).mockResolvedValue(null);
  renderWithClient(<ServicesView />);
  fireEvent.click(screen.getByRole("button", { name: t.CREATE_OPEN }));
  fireEvent.change(screen.getByLabelText(t.NAME), { target: { value: "svc:web" } });
  fireEvent.change(screen.getByLabelText(t.PORTS), { target: { value: "tcp:443" } });
  fireEvent.click(screen.getByRole("button", { name: t.PREVIEW_OPEN }));
  expect(screen.getByText(/PUT \/tailnet\/-\/services\/svc%3Aweb/)).toHaveTextContent("tcp:443");
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "tailscale_service_put")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: t.APPLY }));
  expect(await screen.findByText(t.DONE)).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("tailscale_service_put", expect.objectContaining({ tailnet: "example.com", name: "svc:web" }));
});
