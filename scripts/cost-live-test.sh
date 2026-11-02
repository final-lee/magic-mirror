#!/usr/bin/env bash
# 실제 AWS 계정으로 비용 명령을 대조한다. Cost Explorer는 요청마다 돈이 든다.
# 사용: scripts/cost-live-test.sh <프로필>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "사용: $0 <AWS 프로필>" >&2
  exit 2
fi

echo "Cost Explorer 요청 약 3건(≈ \$0.03)이 들어요. 프로필: $1"
cd "$(dirname "$0")/../src-tauri"
MM_COST_PROFILE="$1" cargo test --lib cost_commands::live_tests -- --ignored --nocapture
