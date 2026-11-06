/** ApplicationSet generator 오류 원문을 한 줄로 줄인다. 알아볼 수 없는 모양이면 null(원문을 그대로 보인다). */
const PROVIDERS: [RegExp, string][] = [
  [/github/i, "GitHub"],
  [/gitlab/i, "GitLab"],
  [/bitbucket/i, "Bitbucket"],
  [/gitea/i, "Gitea"],
  [/dev\.azure\.com|visualstudio\.com/i, "Azure DevOps"],
];

/** 무엇을 읽다가 실패했는지. 가장 구체적인 것부터 */
const subject = (message: string) =>
  /pull request/i.test(message) ? " (pull request 목록)" : /branch/i.test(message) ? " (브랜치 목록)" : /listing repos|repositor/i.test(message) ? " (저장소 목록)" : "";

export function summarizeAppSetError(message: string): string | null {
  const http = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/\S+?):\s*(\d{3})\b/.exec(message);
  if (http) {
    let host = http[1];
    try {
      host = new URL(http[1]).hostname;
    } catch {
      // 주소 모양이 아니면 그대로 보인다
    }
    const provider = PROVIDERS.find(([pattern]) => pattern.test(host))?.[1] ?? host;
    return `${provider} API가 ${http[2]} 오류를 돌려줬어요${subject(message)}`;
  }
  if (/rate limit/i.test(message)) return `SCM API 사용 한도를 넘었어요${subject(message)}`;
  if (/bad credentials|unauthorized|\b401\b/i.test(message)) return `SCM 인증에 실패했어요. 토큰이나 GitHub App 설정을 확인해 주세요${subject(message)}`;
  return null;
}
