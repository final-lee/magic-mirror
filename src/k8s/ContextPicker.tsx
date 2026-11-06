import type { K8sContextCandidate } from "./types";
import { SEVERAL_CONTEXTS, savedMissing } from "./text";

interface Props {
  candidates: K8sContextCandidate[];
  /** 저장해 둔 context가 더는 후보가 아닐 때 그 이름 */
  missing: string | null;
  onPick: (name: string) => void;
}

/** 이 클러스터를 가리키는 context가 여럿일 때 접속할 것을 고른다 */
export function ContextPicker({ candidates, missing, onPick }: Props) {
  return (
    <div className="k8s-prompt">
      <div className="k8s-card">
        {missing && <p className="err">{savedMissing(missing)}</p>}
        <p>{SEVERAL_CONTEXTS}</p>
        <ul className="k8s-ctx-list">
          {candidates.map((c) => (
            <li key={c.name}>
              <button className="k8s-ctx tone-primary" onClick={() => onPick(c.name)}>
                <b className="mono">{c.name}</b>
                <span className="dim">{c.user}</span>
                {c.execProfile && <span className="dim mono">{c.execProfile}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
