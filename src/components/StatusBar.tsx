export function StatusBar({
  profile,
  account,
  region,
  updatedAt,
}: {
  profile: string;
  account: string | undefined;
  region: string;
  updatedAt: number;
}) {
  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString("ko-KR") : "";
  return (
    <div className="status">
      <span>
        {profile} · {account ?? "…"} · {region}
      </span>
      <span>{time && `${time} 새로고침`}</span>
    </div>
  );
}
