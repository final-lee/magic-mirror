import { useState } from "react";
import type { K8sPlugin } from "../../api/types";
import type { K8sKindRef } from "../types";
import { pluginKeyError, pluginTemplateError } from "./plugins";

const formatKind = (kind: "*" | K8sKindRef) => kind === "*" ? "*" : `${kind.group || "core"}/${kind.version}/${kind.kind}/${kind.plural}/${kind.namespaced ? "namespaced" : "cluster"}`;

function parseKinds(input: string): ("*" | K8sKindRef)[] | null {
  const result: ("*" | K8sKindRef)[] = [];
  for (const item of input.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (item === "*") {
      result.push("*");
      continue;
    }
    const parts = item.split("/");
    if (parts.length !== 5 || parts.some((part) => !part) || !["namespaced", "cluster"].includes(parts[4])) return null;
    result.push({ group: parts[0] === "core" ? "" : parts[0], version: parts[1], kind: parts[2], plural: parts[3], namespaced: parts[4] === "namespaced" });
  }
  return result.length ? result : null;
}

export function PluginSettings({ plugins, onChange }: { plugins: K8sPlugin[]; onChange: (plugins: K8sPlugin[]) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kinds, setKinds] = useState("*");
  const [command, setCommand] = useState("");
  const [confirm, setConfirm] = useState(true);
  const [key, setKey] = useState("");
  const start = (index: number) => {
    const plugin = plugins[index];
    setEditing(index);
    setName(plugin?.name ?? "");
    setDescription(plugin?.description ?? "");
    setKinds(plugin?.kinds.map(formatKind).join(", ") ?? "*");
    setCommand(plugin?.command ?? "");
    setConfirm(plugin?.confirm ?? true);
    setKey(plugin?.key ?? "");
  };
  const parsed = parseKinds(kinds);
  const keyError = pluginKeyError(key, plugins.filter((_, index) => index !== editing).flatMap((plugin) => plugin.key ? [plugin.key] : []));
  const templateError = pluginTemplateError(command);
  const save = () => {
    if (editing === null || !name.trim() || !command.trim() || !parsed || keyError || templateError) return;
    const plugin: K8sPlugin = { name: name.trim(), description: description.trim() || null, kinds: parsed, command, confirm, key: key.trim() || null };
    const next = plugins.slice();
    if (editing === next.length) next.push(plugin);
    else next[editing] = plugin;
    onChange(next);
    setEditing(null);
  };
  return (
    <section className="k8s-plugin-settings" aria-label="EKS 플러그인">
      <h4>EKS 플러그인</h4>
      <p>선택한 객체에 대해 로컬 셸에서 실행할 명령이에요.</p>
      {plugins.map((plugin, index) => (
        <div className="tools" key={`${index}-${plugin.name}`}>
          <span>{plugin.name}</span>
          <button className="btn tone-secondary" onClick={() => start(index)}>편집</button>
          <button className="btn tone-danger" onClick={() => { onChange(plugins.filter((_, i) => i !== index)); setEditing(null); }}>삭제</button>
        </div>
      ))}
      {editing === null ? <button className="btn tone-secondary" onClick={() => start(plugins.length)}>플러그인 추가</button> : (
        <div className="k8s-plugin-editor">
          <label>이름<input className="field-input" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>설명<input className="field-input" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>종류<input className="field-input mono" value={kinds} onChange={(event) => setKinds(event.target.value)} /></label>
          <p className="dim">* 또는 그룹/버전/Kind/복수형/namespaced(또는 cluster). 여러 종류는 쉼표로 나눠요. 코어 그룹은 core로 적어요.</p>
          {!parsed && <p className="err">종류를 확인해 주세요</p>}
          <label>명령<input className="field-input mono" value={command} onChange={(event) => setCommand(event.target.value)} /></label>
          <p className="dim">$NAMESPACE $NAME $CONTEXT $KIND $CONTAINER를 쓸 수 있어요.</p>
          {templateError && <p className="err">{templateError}</p>}
          <label>단축키<input className="field-input mono" value={key} onChange={(event) => setKey(event.target.value)} /></label>
          {keyError && <p className="err">{keyError}</p>}
          <label><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />실행 전 확인</label>
          <div className="tools"><button className="btn tone-primary" disabled={!name.trim() || !command.trim() || !parsed || !!keyError || !!templateError} onClick={save}>저장</button><button className="btn tone-secondary" onClick={() => setEditing(null)}>취소</button></div>
        </div>
      )}
    </section>
  );
}
