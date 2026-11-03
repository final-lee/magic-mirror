import type { WfParam } from "./types";

/** 파라미터마다 값 칸(enum이 있으면 선택). values에 없는 것은 원래 값이다 */
export function ParamFields({
  params,
  values,
  onChange,
}: {
  params: WfParam[];
  values: Record<string, string>;
  onChange(values: Record<string, string>): void;
}) {
  return (
    <>
      {params.map((p) => (
        <label key={p.name} className="argowf-param">
          {p.name}
          {p.enum && p.enum.length > 0 ? (
            <select value={values[p.name] ?? ""} onChange={(e) => onChange({ ...values, [p.name]: e.target.value })}>
              {!p.enum.includes(values[p.name] ?? "") && <option value={values[p.name] ?? ""}>{values[p.name] ?? ""}</option>}
              {p.enum.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <input value={values[p.name] ?? ""} onChange={(e) => onChange({ ...values, [p.name]: e.target.value })} />
          )}
          {p.description && <small className="dim">{p.description}</small>}
        </label>
      ))}
    </>
  );
}

/** 폼 시작값: 값이 있으면 그것, 없으면 기본값 */
export const initialParamValues = (params: WfParam[]): Record<string, string> => Object.fromEntries(params.map((p) => [p.name, p.value ?? p.default ?? ""]));

/** 바꾼 것만 `이름=값`으로(그대로면 서버가 원래 값을 쓴다) */
export const changedParameters = (params: WfParam[], values: Record<string, string>): string[] =>
  params.flatMap((p) => (values[p.name] !== undefined && values[p.name] !== (p.value ?? "") ? [`${p.name}=${values[p.name]}`] : []));
