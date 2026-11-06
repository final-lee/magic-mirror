export const SEC_ADDRESS = "주소 진단";
export const SEC_ADDRESS_DESC = "URL이나 호스트를 넣으면 이 Mac에서 그 주소까지 Tailscale 연결이 되는지 단계별로 점검해요.";
export const SEC_DNS_STATUS = "DNS 상태";
export const SEC_DNS_STATUS_DESC = "이 Mac이 Tailscale DNS와 MagicDNS를 어떻게 설정했는지 보여줘요.";
export const SEC_DNS_QUERY = "DNS 질의";
export const SEC_DNS_QUERY_DESC = "Tailscale이 쓰는 DNS 서버에 도메인 이름을 직접 물어봐요.";
export const SEC_WHOIS = "IP 주인 조회";
export const SEC_WHOIS_DESC = "Tailscale IP 주소가 테일넷의 어느 기기와 사용자의 것인지 찾아봐요.";
export const SEC_WHOAMI = "내 신원";
export const SEC_WHOAMI_DESC = "이 Mac이 테일넷에서 어떤 기기와 사용자로 보이는지 확인해요.";
export const DNS_STATUS = "DNS 상태";
export const DNS_QUERY = "DNS 질의";
export const DNS_NAME = "도메인 이름";
export const RECORD_TYPE = "레코드 유형 (선택)";
export const WHOIS = "IP 주인 조회";
export const IP = "Tailscale IP 주소";
export const WHOAMI = "내 신원";
export const RUN = "조회";
export const LOADING = "조회하고 있어요";
export const RAW = "원문 보기";

/** `whois`/`whoami --json`을 풀어 보여줄 때의 이름. */
export const IDENTITY = {
  device: "기기 이름",
  dnsName: "DNS 이름",
  user: "사용자",
  tailnet: "테일넷",
  suffix: "MagicDNS 접미사",
  addresses: "IP 주소",
  tags: "태그",
  authorized: "기기 승인",
  created: "등록한 날",
  keyExpiry: "키 만료",
  nodeId: "노드 ID",
  nodeKey: "노드 키",
} as const;
export const AUTHORIZED = "승인됨";
export const UNAUTHORIZED = "승인 대기";
