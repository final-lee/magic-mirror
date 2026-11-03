// 백엔드(src-tauri/src/argowf/client.rs)와 글자 하나까지 같아야 하는 오류 문구
export const ARGOWF_TOKEN_INVALID = "Argo Server 토큰이 만료됐거나 맞지 않아요. 새 토큰을 넣어 주세요";
export const ARGOWF_TOKEN_MISSING = "이 Argo Server의 토큰을 넣어 주세요";
export const ARGOWF_NETWORK = "Argo Server에 닿지 못했어요. Tailscale·VPN 연결을 확인해 주세요";
/** context 인증을 서버가 받지 않음(401·403). 뒤에 context 이름이 붙지 않는 고정 문구 */
export const ARGOWF_CONTEXT_REJECTED =
  "Argo Server가 kubeconfig context의 자격 증명을 받지 않았어요. 서버가 --auth-mode=client인지, 이 신원에 권한이 있는지 확인해 주세요";

export const ARGOWF_TITLE = "⚙️ Argo Workflows";
/** 모든 네임스페이스를 읽을 권한이 없을 때(HTTP 403). 백엔드(src-tauri/src/argowf/client.rs)와 글자 하나까지 같아야 한다 */
export const ARGOWF_FORBIDDEN = "Argo Server가 이 요청을 허용하지 않았어요. 이 신원에 권한이 있는 네임스페이스를 골라 주세요";
export const ARGOWF_PICK_NAMESPACE = "네임스페이스를 골라 주세요";
/** Argo Events CRD가 없는 클러스터. 백엔드(src-tauri/src/argowf/events.rs)와 글자 하나까지 같아야 한다 */
export const ARGO_EVENTS_MISSING = "이 클러스터에 Argo Events가 없어요";
export const ARGOWF_APIDOCS = "API Docs ↗";
export const ARGOWF_HELP = "Help ↗";
/** Argo Workflows 문서(Help 메뉴) */
export const ARGOWF_HELP_URL = "https://argo-workflows.readthedocs.io/";
