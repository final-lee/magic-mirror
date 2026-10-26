# 수동 테스트 체크리스트

실제 SSO 프로필로 `npm run tauri dev` 실행 후 확인한다.

## 기본
- [ ] 첫 실행 시 16개 서비스가 모두 사이드바에 보인다
- [ ] 프로필 드롭다운에 `~/.aws/config`의 프로필이 모두 보이고, 바꾸면 그 프로필의 기본 리전으로 바뀐다
- [ ] 앱을 재시작하면 마지막 프로필/리전/활성 서비스/즐겨찾기가 복원된다
- [ ] 상태바에 프로필 · 계정 ID · 리전(전역 서비스는 global)이 보인다

## 서비스별 목록과 상세 (각 타입: 목록 표시, 행 선택 시 상세, 콘솔 열기 동작)
- [ ] EC2: Instances / Security Groups / Volumes
- [ ] S3: Buckets → 더블클릭으로 폴더 진입, 경로 클릭으로 상위 이동, "더 보기"
- [ ] Lambda: Functions
- [ ] RDS: DB Instances / DB Clusters
- [ ] ECS: Clusters / Services / Tasks
- [ ] EKS: Clusters / Node Groups
- [ ] VPC: VPCs / Subnets
- [ ] IAM: Users / Roles / Policies
- [ ] DynamoDB: Tables
- [ ] CloudWatch Logs: Log Groups
- [ ] CloudFront: Distributions
- [ ] SQS: Queues
- [ ] SNS: Topics
- [ ] ECR: Repositories
- [ ] Route53: Hosted Zones
- [ ] Secrets Manager: Secrets (시크릿 값은 어디에도 표시되지 않는다)

## 조작
- [ ] ⌘F 필터 포커스, Esc로 필터 지우기
- [ ] ⌘R 새로고침 후 상태바 시간이 갱신된다
- [ ] 행 선택 후 ⌘C로 ID(S3는 s3:// URI) 복사
- [ ] ↑↓로 행 이동, Enter로 S3 버킷/폴더 열기
- [ ] 리소스 타입 우클릭으로 즐겨찾기 추가/제거
- [ ] ⚙에서 서비스를 끄면 사이드바에서 즉시 사라진다
- [ ] 원본 데이터 보기 모달이 열리고 닫힌다

## 오류
- [ ] `aws sso logout --profile <p>` 후 조회 → "SSO 세션이 만료됐어요" + 로그인 버튼 → 로그인 후 자동 재조회
- [ ] 권한 없는 타입은 "권한 없음 (액션)"만 표시하고 다른 타입은 정상 동작
- [ ] 네트워크 끊고 조회 → 네트워크 오류 + 다시 시도
