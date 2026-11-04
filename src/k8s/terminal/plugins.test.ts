import { describe, expect, it } from "vitest";
import { expandPlugin, pluginKeyError, pluginTemplateError, shellQuote, supportsKind } from "./plugins";

const pod = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };

describe("EKS plugins", () => {
  it("quotes every substituted value without expanding it again", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(expandPlugin("kubectl -n $NAMESPACE get $KIND $NAME; echo $CONTEXT $CONTAINER", {
      NAMESPACE: "space name", KIND: "Pod", NAME: "a'$(bad)", CONTEXT: "$NAME", CONTAINER: "",
    })).toBe("kubectl -n 'space name' get 'Pod' 'a'\\''$(bad)'; echo '$NAME' ''");
    expect(expandPlugin(`echo "$NAME" '$NAME'`, {
      NAMESPACE: "", KIND: "", NAME: `a'"$(bad)`, CONTEXT: "", CONTAINER: "",
    })).toBe(`echo ""'a'\\''"$(bad)'"" '''a'\\''"$(bad)'''`);
  });
  it("rejects shell constructs and embedded unquoted placeholders", () => {
    for (const command of ["echo $(id) $NAME", "echo `${NAME}`", "echo ${NAME}", "echo prefix$NAME", "echo $NAME/suffix", "cat <<EOF\n$NAME\nEOF", "echo \\$NAME"]) {
      expect(pluginTemplateError(command)).not.toBeNull();
    }
    expect(pluginTemplateError(`echo "$NAME" '$NAME' $NAME`)).toBeNull();
  });
  it("accepts wildcard and exact kind references", () => {
    const plugin = { name: "x", command: "x", kinds: [pod] };
    expect(supportsKind(plugin, pod)).toBe(true);
    expect(supportsKind(plugin, { ...pod, group: "other" })).toBe(false);
    expect(supportsKind({ ...plugin, kinds: ["*"] }, pod)).toBe(true);
  });
  it("rejects malformed and conflicting keys", () => {
    expect(pluginKeyError("cmd+f")).not.toBeNull();
    expect(pluginKeyError("shift+ctrl+x", ["ctrl+shift+x"])).not.toBeNull();
    expect(pluginKeyError("banana+x")).not.toBeNull();
    expect(pluginKeyError("ctrl+ctrl+x")).not.toBeNull();
    expect(pluginKeyError("ctrl+alt+z")).toBeNull();
  });
});
