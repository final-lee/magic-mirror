import { useMemo, useState } from "react";
import { stringify } from "yaml";
import { CodeEditor } from "../../components/CodeEditor";
import { MANAGE_NO_CHANGE, MANAGE_PREVIEW, MANAGE_YAML_HINT, MANAGE_YAML_LABEL, MANAGE_YAML_RESET, MANAGE_YAML_TITLE } from "./text";
import { deepEqual, type Obj } from "./specForm";
import { gateYaml } from "./yamlGate";

interface Props {
  spec: Obj;
  /** 구문 오류가 없고 바뀐 곳이 있는 YAML로 미리 보기를 연다 */
  onPreview: (yaml: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}

/** Application.spec 전체를 YAML로 고친다. 구문 오류가 있으면 미리 볼 수 없다 */
export function YamlEditPane({ spec, onPreview, disabled, disabledReason }: Props) {
  const seed = useMemo(() => stringify(spec), [spec]);
  const [text, setText] = useState(seed);
  // 편집기는 처음 값으로만 채우므로 "처음 값으로"는 편집기를 다시 만든다
  const [round, setRound] = useState(0);
  const gate = useMemo(() => gateYaml(text), [text]);
  const unchanged = gate.ok && deepEqual(gate.value, spec);
  const blocked = disabled || !gate.ok || unchanged;

  return (
    <div className="mg-form">
      <section className="k8s-sect" aria-label={MANAGE_YAML_TITLE}>
        <h4>{MANAGE_YAML_TITLE}</h4>
        <p className="dim">{MANAGE_YAML_HINT}</p>
        <CodeEditor key={round} value={text} onChange={setText} label={MANAGE_YAML_LABEL} minHeight="320px" />
      </section>
      {gate.reason && (
        <p className="err" role="alert">
          {gate.reason}
        </p>
      )}
      <div className="mg-foot">
        <button
          className="btn small tone-ghost"
          onClick={() => {
            setText(seed);
            setRound((n) => n + 1);
          }}
        >
          {MANAGE_YAML_RESET}
        </button>
        <button className="btn small tone-primary" disabled={blocked} title={disabled ? disabledReason : unchanged ? MANAGE_NO_CHANGE : undefined} onClick={() => onPreview(text)}>
          {MANAGE_PREVIEW}
        </button>
      </div>
    </div>
  );
}
