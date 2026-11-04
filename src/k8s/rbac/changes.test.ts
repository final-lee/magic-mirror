import { describe, expect, it } from "vitest";
import { bindingName, changeTitle, createBinding, deleteBinding, isRbacChange, splitList, subjectSpecOf } from "./changes";

describe("권한 변경 만들기", () => {
  it("바인딩 이름은 DNS에 맞게 다듬고 주체 종류를 넣지 않는다", () => {
    expect(bindingName({ kind: "User", name: "Alice@Corp.com" }, "view")).toBe("mm-alice-corp.com-view");
    expect(bindingName({ kind: "ServiceAccount", name: "web", namespace: "dev" }, "edit")).toBe("mm-dev-web-edit");
    expect(bindingName({ kind: "Group", name: "!!!" }, "")).toBe("mm-subject-role");
  });

  it("목록 입력은 공백과 중복과 빈 항목을 정리한다", () => {
    expect(splitList(" a, b ,,a\nc ")).toEqual(["a", "b", "c"]);
  });

  it("ClusterRoleBinding에는 네임스페이스가 없고 ServiceAccount 주체는 네임스페이스를 가진다", () => {
    const change = createBinding({ namespace: null, name: "b" }, { kind: "ClusterRole", name: "view" }, [{ kind: "ServiceAccount", name: "web", namespace: "dev" }]);
    expect(change.kind.kind).toBe("ClusterRoleBinding");
    expect(change.type === "bindingCreate" && change.object).toMatchObject({ metadata: { name: "b" }, subjects: [{ kind: "ServiceAccount", name: "web", namespace: "dev" }] });
  });

  it("권한 변경 모듈이 받는 변경만 알아본다(바인딩 삭제 포함)", () => {
    expect(isRbacChange(deleteBinding({ namespace: "dev", name: "b" }))).toBe(true);
    expect(isRbacChange({ kind: { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true }, namespace: "dev", name: "w", type: "delete" })).toBe(false);
    expect(changeTitle(deleteBinding({ namespace: "dev", name: "b" }))).toContain("RoleBinding dev/b");
  });

  it("IAM 주체는 바인딩 주체가 될 수 없다", () => {
    expect(subjectSpecOf({ kind: "iam", name: "arn", namespace: null })).toBeNull();
    expect(subjectSpecOf({ kind: "group", name: "g", namespace: null })).toEqual({ kind: "Group", name: "g" });
  });
});
