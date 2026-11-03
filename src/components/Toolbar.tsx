import type { RefObject } from "react";
import type { ProfileInfo } from "../api/types";
import { REGIONS } from "../lib/regions";

interface Props {
  profiles: ProfileInfo[];
  profile: string | null;
  onProfile: (p: string) => void;
  region: string;
  onRegion: (r: string) => void;
  filter: string;
  onFilter: (f: string) => void;
  filterRef: RefObject<HTMLInputElement>;
  onRefresh: () => void;
  onOpenSettings: () => void;
  /** ⌘K 리소스 찾기를 연다 */
  onOpenPalette: () => void;
}

export function Toolbar({ profiles, profile, onProfile, region, onRegion, filter, onFilter, filterRef, onRefresh, onOpenSettings, onOpenPalette }: Props) {
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
      <input
        ref={filterRef}
        className="search"
        placeholder="필터  ⌘F"
        title="글자 일부만 순서대로 쳐도 찾아요(poa → prod-orders-api). 공백으로 나누면 모두 맞는 것만 보여요"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onFilter("");
            e.currentTarget.blur();
          }
        }}
      />
      <button className="icon" title="리소스 찾기 (⌘K)" aria-label="리소스 찾기" onClick={onOpenPalette}>
        ⌕
      </button>
      <button className="icon" title="새로고침 (⌘R)" aria-label="새로고침" onClick={onRefresh}>
        ⟳
      </button>
      <button className="icon" title="서비스 설정" aria-label="서비스 설정" onClick={onOpenSettings}>
        ⚙
      </button>
    </header>
  );
}
