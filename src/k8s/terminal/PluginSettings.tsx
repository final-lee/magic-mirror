import { useState } from "react";
import type { K8sPlugin } from "../../api/types";
import type { K8sKindRef } from "../types";
import { pluginKeyError, pluginTemplateError } from "./plugins";
import { PLUGIN_SETTINGS as T } from "./text";

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
    <section className="k8s-plugin-settings" aria-label={T.title}>
      <h4>{T.title}</h4>
      <p>{T.description}</p>
      {plugins.map((plugin, index) => (
        <div className="tools" key={`${index}-${plugin.name}`}>
          <span>{plugin.name}</span>
          <button className="btn tone-secondary" onClick={() => start(index)}>{T.edit}</button>
          <button className="btn tone-danger" onClick={() => { onChange(plugins.filter((_, i) => i !== index)); setEditing(null); }}>{T.delete}</button>
        </div>
      ))}
      {editing === null ? <button className="btn tone-secondary" onClick={() => start(plugins.length)}>{T.add}</button> : (
        <div className="k8s-plugin-editor">
          <label>{T.name}<input className="field-input" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{T.descriptionLabel}<input className="field-input" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>{T.kinds}<input className="field-input mono" value={kinds} onChange={(event) => setKinds(event.target.value)} /></label>
          <p className="dim">{T.kindsHelp}</p>
          {!parsed && <p className="err">{T.kindsError}</p>}
          <label>{T.command}<input className="field-input mono" value={command} onChange={(event) => setCommand(event.target.value)} /></label>
          <p className="dim">{T.commandHelp}</p>
          {templateError && <p className="err">{templateError}</p>}
          <label>{T.key}<input className="field-input mono" value={key} onChange={(event) => setKey(event.target.value)} /></label>
          {keyError && <p className="err">{keyError}</p>}
          <label><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />{T.confirm}</label>
          <div className="tools"><button className="btn tone-primary" disabled={!name.trim() || !command.trim() || !parsed || !!keyError || !!templateError} onClick={save}>{T.save}</button><button className="btn tone-ghost" onClick={() => setEditing(null)}>{T.cancel}</button></div>
        </div>
      )}
    </section>
  );
}
