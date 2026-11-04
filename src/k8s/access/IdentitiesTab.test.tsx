import { fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { accessView, iam, mapping } from "./fixtures";
import { IdentitiesTab } from "./IdentitiesTab";
import { AWS_AUTH_NONE, INACTIVE, MODE_NOTES, MODE_UNKNOWN, NOT_EVALUATED, RBAC_MISSING, SEE_MATRIX, SSO_GROUP_TITLE, gapText, ssoGroupRow } from "./text";
import type { AccessView } from "./types";

vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const T = { profile: "app", region: "r", cluster: "id" };
const SSO_A = "arn:aws:iam::1:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_aaaaaaaaaaaaaaaa";
const SSO_B = "arn:aws:iam::1:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_bbbbbbbbbbbbbbbb";
const CI = "arn:aws:iam::1:role/ci";

function setup(view: AccessView, handlers: { onOpenIam?: (arn: string) => void; onOpenSubject?: (s: unknown) => void } = {}) {
  return render(
    withClientAndSso(<IdentitiesTab target={T} ssoProfile="p" view={view} onRetry={() => {}} onOpenIam={handlers.onOpenIam} onOpenSubject={handlers.onOpenSubject ?? (() => {})} />, newQueryClient(), ssoLoginStub()),
  );
}

const sso = (arn: string) => mapping(arn, { permissionSet: "Admin", label: "Admin" });

test("SSO roles with the same permission set are folded into one expandable row", () => {
  setup(accessView({ mappings: [sso(SSO_A), sso(SSO_B), mapping(CI)] }));
  expect(screen.getByText(ssoGroupRow("Admin", 2), { exact: false })).toBeInTheDocument();
  expect(screen.queryByText(SSO_A)).not.toBeInTheDocument();
  expect(screen.getByText(CI)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Admin.*펼치기/ }));
  expect(screen.getByText(SSO_A)).toBeInTheDocument();
  expect(screen.getByText(SSO_B)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Admin.*접기/ }));
  expect(screen.queryByText(SSO_A)).not.toBeInTheDocument();
});

test("turning the grouping off lists every role", () => {
  setup(accessView({ mappings: [sso(SSO_A), sso(SSO_B)] }));
  fireEvent.click(screen.getByLabelText(SSO_GROUP_TITLE));
  expect(screen.getByText(SSO_A)).toBeInTheDocument();
  expect(screen.getByText(SSO_B)).toBeInTheDocument();
});

test("the authentication mode says which source is used", () => {
  const { unmount } = setup(accessView({ authMode: "API", mode: "api" }));
  expect(screen.getByText(MODE_NOTES.api)).toBeInTheDocument();
  unmount();
  setup(accessView({ authMode: null, mode: null, awsAuth: { present: false, accounts: [], errors: [] } }));
  expect(screen.getByText(MODE_UNKNOWN)).toBeInTheDocument();
  expect(screen.getByText(AWS_AUTH_NONE)).toBeInTheDocument();
});

test("an unused mapping is dimmed with its reason and has no permission summary; unknown policies say they were not evaluated", () => {
  setup(
    accessView({
      mappings: [
        mapping(CI, { source: "awsAuth", effective: false, inactiveReason: "같은 주체의 access entry가 먼저 쓰여요", levels: null, subject: null }),
        mapping("arn:aws:iam::1:role/dev", { policies: [{ policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy", policyName: "AmazonEKSAdminViewPolicy", role: null, scope: { kind: "cluster" } }] }),
      ],
    }),
  );
  const unused = screen.getByText(CI).closest("tr")!;
  expect(within(unused).getByText(INACTIVE)).toBeInTheDocument();
  expect(within(unused).getByText("같은 주체의 access entry가 먼저 쓰여요")).toBeInTheDocument();
  expect(within(unused).queryByRole("button", { name: SEE_MATRIX })).not.toBeInTheDocument();
  expect(screen.getByText(NOT_EVALUATED)).toBeInTheDocument();
});

test("a role opens in IAM and its subject opens in the matrix", () => {
  const onOpenIam = vi.fn();
  const onOpenSubject = vi.fn();
  setup(accessView({ mappings: [mapping(CI)] }), { onOpenIam, onOpenSubject });
  fireEvent.click(screen.getByRole("button", { name: "IAM에서 열기" }));
  expect(onOpenIam).toHaveBeenCalledWith(CI);
  fireEvent.click(screen.getByRole("button", { name: SEE_MATRIX }));
  expect(onOpenSubject).toHaveBeenCalledWith(iam(CI));
});

test("unreadable sources, a missing RBAC read and dangling bindings are all reported", () => {
  setup(
    accessView({
      rbacAvailable: false,
      gaps: [{ section: "accessEntries", error: { kind: "other", message: "읽기 거부" } }],
      dangling: [{ binding: { kind: "ClusterRoleBinding", namespace: null, name: "old" }, role: { kind: "ClusterRole", namespace: null, name: "gone" } }],
    }),
  );
  expect(screen.getByText(gapText("EKS access entry"))).toBeInTheDocument();
  expect(screen.getByText("읽기 거부")).toBeInTheDocument();
  expect(screen.getByText(RBAC_MISSING)).toBeInTheDocument();
  expect(screen.getByText(/ClusterRoleBinding old → ClusterRole gone/)).toBeInTheDocument();
});
