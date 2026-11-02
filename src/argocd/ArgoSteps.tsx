import { STEPS_LABEL, STEP_SERVER, STEP_TOKEN } from "./text";

/** 처음 연결하는 순서(서버 주소 → API 토큰)에서 지금 단계를 보인다. */
export function ArgoSteps({ step }: { step: "server" | "token" }) {
  return (
    <ol className="argo-steps" aria-label={STEPS_LABEL}>
      <li aria-current={step === "server" ? "step" : undefined}>{STEP_SERVER}</li>
      <li aria-current={step === "token" ? "step" : undefined}>{STEP_TOKEN}</li>
    </ol>
  );
}
