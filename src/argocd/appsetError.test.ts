import { summarizeAppSetError } from "./appsetError";

test("an SCM API status error becomes provider, status and what was being listed", () => {
  const github =
    "error listing repos: error listing pull requests for AhaOfficial/citadel-frontend: GET https://api.github.com/repos/AhaOfficial/citadel-frontend/pulls?per_page=100: 502 Server Error []";
  expect(summarizeAppSetError(github)).toBe("GitHub API가 502 오류를 돌려줬어요 (pull request 목록)");
  expect(summarizeAppSetError("error listing branches: GET https://gitlab.example.com/api/v4/projects/1/repository/branches: 503 Service Unavailable")).toBe(
    "GitLab API가 503 오류를 돌려줬어요 (브랜치 목록)",
  );
  expect(summarizeAppSetError("GET https://scm.internal/api/repos: 500")).toBe("scm.internal API가 500 오류를 돌려줬어요");
});

test("rate limits and bad credentials get their own hint; anything else is left to the raw message", () => {
  expect(summarizeAppSetError("error listing repos: API rate limit exceeded")).toBe("SCM API 사용 한도를 넘었어요 (저장소 목록)");
  expect(summarizeAppSetError("error listing pull requests: Bad credentials")).toMatch(/^SCM 인증에 실패했어요/);
  expect(summarizeAppSetError("failed to render template: missing key")).toBeNull();
});
