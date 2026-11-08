#!/usr/bin/env bash
# 실제 AWS 계정으로 SNS 워크스페이스를 대조한다. 시험 주제 하나와 SQS 큐 셋(mm-live-<초>)을 만들고 끝에 지운다.
# 구독·큐 정책·DLQ·필터·시험 발행(메시지 2건)·되돌리기·해지를 실제로 보낸다.
# 사용: scripts/sns-live-test.sh <프로필> [리전]
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "사용: $0 <AWS 프로필> [리전, 기본 ap-northeast-2]" >&2
  exit 2
fi

echo "프로필 $1, 리전 ${2:-ap-northeast-2}에 mm-live-* 주제·큐를 만들었다가 지워요"
cd "$(dirname "$0")/../src-tauri"
MM_SNS_PROFILE="$1" MM_SNS_REGION="${2:-ap-northeast-2}" cargo test --lib sns::live_tests -- --ignored --nocapture
