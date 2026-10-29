import { useId } from "react";

interface Props {
  /** 묶음의 이름 */
  label: string;
  /** 고를 수 있는 권한(보이는 순서) */
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}

/** 권한을 하나 이상 고르는 체크박스 묶음. 고른 권한은 options의 순서로 돌려준다 */
export function PrivilegeChecks({ label, options, value, onChange }: Props) {
  const id = useId();
  return (
    <fieldset className="pg-form-checks" aria-labelledby={id}>
      <legend id={id}>{label}</legend>
      {options.map((name) => (
        <label key={name} className="pg-form-check">
          <input type="checkbox" checked={value.includes(name)} onChange={(e) => onChange(options.filter((o) => (o === name ? e.target.checked : value.includes(o))))} /> {name}
        </label>
      ))}
    </fieldset>
  );
}
