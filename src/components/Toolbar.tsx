import type { ProfileInfo } from "../api/types";
import { shortcutTitle } from "../keymap/keybindings";
import { REGIONS } from "../lib/regions";

interface Props {
  profiles: ProfileInfo[];
  profile: string | null;
  onProfile: (p: string) => void;
  region: string;
  onRegion: (r: string) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  /** ⌘K 리소스 찾기를 연다 */
  onOpenPalette: () => void;
}

export function Toolbar({ profiles, profile, onProfile, region, onRegion, onRefresh, onOpenSettings, onOpenPalette }: Props) {
  const regions = REGIONS.includes(region) ? REGIONS : [region, ...REGIONS];
  return (
    <header className="titlebar">
      <label className="sel">
        <small>프로필</small>
        <select aria-label="프로필" value={profile ?? ""} onChange={(e) => onProfile(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="sel">
        <small>리전</small>
        <select aria-label="리전" value={region} onChange={(e) => onRegion(e.target.value)}>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <span className="titlebar-gap" />
      <button className="icon" title={shortcutTitle("리소스 찾기", "app.findResource")} aria-label="리소스 찾기" onClick={onOpenPalette}>
        ⌕
      </button>
      <button className="icon" title={shortcutTitle("새로고침", "app.refresh")} aria-label="새로고침" onClick={onRefresh}>
        ⟳
      </button>
      <button className="icon" title="서비스 설정" aria-label="서비스 설정" onClick={onOpenSettings}>
        ⚙
      </button>
    </header>
  );
}
