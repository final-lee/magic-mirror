import * as t from "./text";
import { useTailscaleTabs } from "./TabContext";

/** API 보기가 자격 증명이 없을 때 보여 주는 빈 상태. 버튼은 연결 탭으로 옮긴다. */
export function ApiRequired({ title }: { title: string }) {
  const tabs = useTailscaleTabs();
  return (
    <>
    <div className="awc-bar"><h2 className="awc-title">{title}</h2></div>
    <div className="empty">
      <div>
        <p>{t.API_REQUIRED}</p>
        {tabs && (
          <button className="btn tone-nav" onClick={() => tabs.select("connect")}>
            {t.API_REQUIRED_BUTTON}
          </button>
        )}
      </div>
    </div>
    </>
  );
}
