export function NoProfiles() {
  return (
    <div className="empty full">
      <div>
        <h3>AWS 프로필이 없어요</h3>
        <p>터미널에서 아래 명령으로 프로필을 만든 뒤 앱을 다시 실행하세요.</p>
        <pre className="raw">aws configure sso</pre>
      </div>
    </div>
  );
}
