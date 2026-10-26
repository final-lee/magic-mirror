import type { ServiceInfo } from "../api/types";
import { ServiceBadge } from "./ServiceBadge";

interface Props {
  services: ServiceInfo[];
  enabled: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}

export function ServiceSettings({ services, enabled, onChange, onClose }: Props) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...enabled, id] : enabled.filter((x) => x !== id));
  return (
    <div
      className="modal"
      data-testid="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-label="표시할 서비스">
        <h3>표시할 서비스</h3>
        <p>체크한 서비스만 사이드바에 나오고 조회해요.</p>
        <div className="grid">
          {services.map((s) => (
            <label key={s.id}>
              <input type="checkbox" checked={enabled.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
              <ServiceBadge service={s} /> {s.name}
            </label>
          ))}
        </div>
        <div className="foot">
          <button className="btn primary" onClick={onClose}>
            완료
          </button>
        </div>
      </div>
    </div>
  );
}
