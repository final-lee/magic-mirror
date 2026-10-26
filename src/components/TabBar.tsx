export interface TabInfo {
  id: string;
  title: string;
  closable: boolean;
}

interface Props {
  tabs: TabInfo[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabBar({ tabs, active, onActivate, onClose }: Props) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <div key={t.id} className={`tab${t.id === active ? " on" : ""}`}>
          <button role="tab" aria-selected={t.id === active} className="tab-title" onClick={() => onActivate(t.id)}>
            {t.title}
          </button>
          {t.closable && (
            <button
              className="tab-x"
              aria-label={`${t.title} 닫기`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
