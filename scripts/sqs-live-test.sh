#!/usr/bin/env bash
# 실제 AWS 계정으로 SQS 명령을 대조한다. 읽기 시험은 큐를 읽기만 하고, 쓰기 시험은 임시 큐(mm-smoke-<날짜>-<임의>와 -dlq)를 만들어 쓰고 지운다.
# 사용: scripts/sqs-live-test.sh <프로필> <흐름 큐>   (리전은 MM_SQS_REGION, 기본 ap-northeast-2)
# 흐름 큐: EventBridge 규칙이 보내고 Lambda가 받고 DLQ가 있는 기존 큐의 이름. 읽기만 한다.
set -euo pipefail

if [[ $# -ne 2 || -z "$1" || -z "$2" ]]; then
  echo "사용: $0 <AWS 프로필> <흐름 큐 이름>" >&2
  exit 2
fi

echo "SQS 실계정 시험이에요. 프로필: $1, 리전: ${MM_SQS_REGION:-ap-northeast-2}, 흐름 큐: $2. 임시 큐를 만들었다가 지워요."
cd "$(dirname "$0")/../src-tauri"
MM_SQS_PROFILE="$1" MM_SQS_FLOW_QUEUE="$2" MM_SQS_REGION="${MM_SQS_REGION:-ap-northeast-2}" cargo test --lib sqs::live_tests -- --ignored --nocapture --test-threads=1
