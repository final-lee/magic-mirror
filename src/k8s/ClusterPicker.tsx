import { useEffect } from "react";
import { useResources } from "../api/queries";
import { errorMessage } from "../api/errors";
import type { ServiceInfo } from "../api/types";
import { PICKER_EMPTY, PICKER_TITLE } from "./text";

interface Props {
  /** EKS 서비스 정의. 목록은 리소스 목록과 같은 쿼리를 쓴다. */
  service: ServiceInfo;
  profile: string;
  region: string;
  onPick: (cluster: string) => void;
  onClose: () => void;
}

/** 사이드바의 "클러스터 관리"에서 열 클러스터를 고르는 창 */
export function ClusterPicker({ service, profile, region, onPick, onClose }: Props) {
  const q = useResources(profile, region, service, "clusters");
  const items = q.data?.items ?? [];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal"
      data-testid="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-label={PICKER_TITLE}>
        <h3>{PICKER_TITLE}</h3>
        {q.isError && !q.data ? (
          <div className="err">{errorMessage(q.error)}</div>
        ) : q.isPending ? (
          <p>불러오는 중…</p>
        ) : items.length === 0 ? (
          <p>{PICKER_EMPTY}</p>
        ) : (
          <ul className="k8s-clusters">
            {items.map((c) => (
              <li key={c.id}>
                <button className="btn" onClick={() => onPick(c.id)}>
                  <strong>{c.name}</strong> <small>{[c.values.version, c.values.status].filter(Boolean).join(" · ")}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="foot">
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
