import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newQueryClient } from "../../test/utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { grant, mapping, user } from "../access/fixtures";
import { BindingActions } from "./BindingActions";
import { resetCarts, useCart } from "./cart";
import { CellActions } from "./CellActions";
import { EntryDialog } from "./EntryDialog";
import * as t from "./text";
import type { K8sObjectView, K8sRules } from "../types";

vi.mock("../api", () => ({ k8sApi: { rules: vi.fn() } }));
import { k8sApi } from "../api";

const T = { profile: "p", region: "r", cluster: "c" };
const allow = (verbs: string[]): K8sRules => ({ namespace: "default", resourceRules: [{ verbs, apiGroups: ["*"], resources: ["*"], resourceNames: [] }], nonResourceRules: [], incomplete: false });
const ref = { kind: { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRoleBinding", plural: "clusterrolebindings", namespaced: false }, namespace: null, name: "ops" };
const view = { yaml: "subjects:\n- kind: User\n  name: alice\n  apiGroup: rbac.authorization.k8s.io\n" } as K8sObjectView;

function Count() {
  return <span data-testid="count">{useCart(T).changes.length}</span>;
}

afterEach(() => {
  resetCarts();
  vi.clearAllMocks();
});

describe("BindingActions", () => {
  it("권한이 없으면 이유와 함께 끄고, 주체를 입력하면 미리보기와 장바구니로 보낸다", () => {
    const onStart = vi.fn();
    render(
      <>
        <BindingActions target={T} objectRef={ref} view={view} rules={allow(["get", "patch"])} onStart={onStart} />
        <Count />
      </>,
    );
    const del = screen.getByRole("button", { name: t.BINDING_CART_DELETE });
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect(del.getAttribute("title")).toBe(t.BINDING_DENIED("delete", "clusterrolebindings"));
    fireEvent.click(screen.getByRole("button", { name: t.BINDING_ADD_SUBJECT }));
    expect((screen.getByRole("button", { name: t.BINDING_PREVIEW }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(t.BINDING_SUBJECT_NAME)), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: t.CART_ADD }));
    expect(screen.getByTestId("count").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: t.CART_ADD }));
    expect(screen.getByRole("status").textContent).toBe(t.CART_DUPLICATE);
    fireEvent.click(screen.getByRole("button", { name: t.BINDING_PREVIEW }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ type: "bindingSubjects", add: [{ kind: "User", name: "bob", namespace: null }], remove: [] }));
  });

  it("ServiceAccount는 네임스페이스가 있어야 하고 뺄 주체는 바인딩에서 고른다", () => {
    const onStart = vi.fn();
    render(<BindingActions target={T} objectRef={ref} view={view} rules={allow(["patch", "delete"])} onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: t.BINDING_ADD_SUBJECT }));
    fireEvent.change(screen.getByLabelText(new RegExp(t.BINDING_SUBJECT_KIND)), { target: { value: "ServiceAccount" } });
    fireEvent.change(screen.getByLabelText(new RegExp(t.BINDING_SUBJECT_NAME)), { target: { value: "web" } });
    expect((screen.getByRole("button", { name: t.BINDING_PREVIEW }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: t.BINDING_REMOVE_SUBJECT }));
    fireEvent.change(screen.getByLabelText(new RegExp(t.BINDING_SUBJECT_PICK)), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: t.BINDING_PREVIEW }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ type: "bindingSubjects", add: [], remove: [{ kind: "User", name: "alice", namespace: null }] }));
  });
});

describe("CellActions", () => {
  const wrap = (ui: React.ReactElement) => <QueryClientProvider client={newQueryClient()}>{ui}<Count /></QueryClientProvider>;

  it("권한을 주는 경로마다 주체 빼기·바인딩 삭제를 담고, 열에 맞는 바인딩을 만든다", async () => {
    vi.mocked(k8sApi.rules).mockResolvedValue(allow(["*"]));
    const onStart = vi.fn();
    render(wrap(<CellActions target={T} context="ctx" ssoProfile="p" subject={user("alice")} cell="write" namespace="dev" grants={[grant("dev")]} onStart={onStart} />));
    await waitFor(() => expect(k8sApi.rules).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: t.CELL_REMOVE_SUBJECT }));
    fireEvent.click(screen.getByRole("button", { name: t.CELL_DELETE_BINDING }));
    expect(screen.getByTestId("count").textContent).toBe("2");
    expect((screen.getByLabelText(t.CELL_GRANT_ROLE) as HTMLInputElement).value).toBe("edit");
    fireEvent.click(screen.getByRole("button", { name: t.CELL_GRANT_PREVIEW }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ type: "bindingCreate", namespace: "dev", name: "mm-alice-edit", kind: expect.objectContaining({ kind: "RoleBinding" }) }));
  });

  it("세션 이름 템플릿에 기댄 경로는 주체로 빼지 못하고, IAM 주체는 권한 주기 대신 안내를 보인다", async () => {
    vi.mocked(k8sApi.rules).mockResolvedValue(allow(["*"]));
    const arn = "arn:aws:iam::1:role/ops";
    render(wrap(<CellActions target={T} context="ctx" ssoProfile="p" subject={{ kind: "iam", name: arn, namespace: null }} cell="read" namespace={null} grants={[grant(null, { sessionDependent: true })]} mapping={mapping(arn)} onStart={vi.fn()} />));
    const remove = screen.getByRole("button", { name: t.CELL_REMOVE_SUBJECT }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe(t.CELL_NO_SUBJECT_REMOVE);
    expect(screen.getByText(t.CELL_GRANT_IAM)).toBeTruthy();
  });
});

describe("EntryDialog", () => {
  it("ARN과 정책 범위를 확인하고 입력한 대로 변경을 만든다", () => {
    const onSubmit = vi.fn();
    render(<EntryDialog form={{ mode: "create" }} onSubmit={onSubmit} onClose={vi.fn()} />);
    const preview = screen.getByRole("button", { name: t.ENTRY_PREVIEW }) as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t.ENTRY_PRINCIPAL), { target: { value: " arn:aws:iam::1:role/dev " } });
    fireEvent.change(screen.getByLabelText(t.ENTRY_GROUPS_LABEL), { target: { value: "devs, qa, devs" } });
    fireEvent.change(screen.getByLabelText(t.ENTRY_POLICY), { target: { value: t.KNOWN_POLICIES[3].arn } });
    fireEvent.click(screen.getByLabelText(t.ENTRY_SCOPE_NAMESPACES));
    expect(screen.getByText(t.ENTRY_NAMESPACES_REQUIRED)).toBeTruthy();
    expect(preview.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t.ENTRY_SCOPE_NAMESPACES_LABEL), { target: { value: "dev" } });
    fireEvent.click(preview);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "accessEntryCreate", name: "arn:aws:iam::1:role/dev", groups: ["devs", "qa"], policies: [{ policyArn: t.KNOWN_POLICIES[3].arn, scope: { kind: "namespaces", namespaces: ["dev"] } }] }),
    );
  });

  it("그룹 바꾸기는 지금 그룹으로 시작하고 비우면 그룹이 없는 변경이다", () => {
    const onSubmit = vi.fn();
    render(<EntryDialog form={{ mode: "groups", arn: "arn:aws:iam::1:role/dev", groups: ["devs"] }} onSubmit={onSubmit} onClose={vi.fn()} />);
    const input = screen.getByLabelText(t.ENTRY_GROUPS_LABEL) as HTMLInputElement;
    expect(input.value).toBe("devs");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: t.ENTRY_PREVIEW }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ type: "accessEntryGroups", groups: [] }));
  });
});
