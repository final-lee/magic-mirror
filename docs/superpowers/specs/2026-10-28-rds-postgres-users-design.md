# RDS PostgreSQL 사용자 관리: 설계

## 목표
RDS 목록에서 PostgreSQL 클러스터나 인스턴스를 더블클릭하면 "🐘 <식별자>" 탭이 열린다. 그 탭에서 DB 역할(사용자·그룹)과 권한을 한눈에 보고, 미리보기 → 확인 → 적용 흐름으로 바꾼다.
- 역할과 구성원: 목록, 속성, 그룹, 만들기(프리셋), 속성·비밀번호 바꾸기, 안전한 삭제.
- 권한 표와 기본 권한: 데이터베이스별 실효 권한(상속·PUBLIC·소유권 포함), 칸을 눌러 GRANT·REVOKE, 앞으로 만들 객체의 기본 권한.
- 누가 할 수 있나와 세션: 객체와 권한으로 역할 찾기(이유 포함), 접속 세션 보기와 끊기.
- 보안 점검.
- 모든 변경은 SQL 미리보기, 확인, 적용 순서로 가고, 기록과 되돌리기가 있다. IAM 작업 공간과 같은 원칙이다.

## 범위 밖
- MySQL·Aurora MySQL. 탭이 열리지 않는다.
- 클러스터 설정 바꾸기(IAM 인증 켜기, 파라미터 그룹 등). 필요하면 안내만 한다.
- Data API, SSM 터널, 비밀번호 로그인, Secrets Manager. 앱은 VPN으로 직접 연결하고 IAM 데이터베이스 인증으로만 로그인한다.
- 역할별 설정(`ALTER ROLE … SET`) 편집, RLS 정책 편집, 주석 편집. 역할별 설정과 주석은 표시만 한다.
- 새 사용자의 IAM 인증·Secrets Manager 저장. 새 사용자는 비밀번호 로그인만 만든다.
- 마지막 로그인 시각. PostgreSQL이 저장하지 않으므로 "안 쓰는 사용자" 점검은 없고, 화면에 그렇게 밝힌다.

## 단계
첫 버전에 위 기능을 모두 넣는다. 구현은 두 단계로 나누고, 릴리즈는 2단계 뒤에 한다.
- 1단계(읽기): 접속, 카탈로그 스냅숏, 역할 목록·상세, 권한 표, 기본 권한, 누가 할 수 있나, 세션 보기, 점검.
- 2단계(변경): 변경 모델, 미리보기, 트랜잭션 적용, 기록·되돌리기, 만들기·프리셋, 구성원, 권한 칸(장바구니), 기본 권한, 속성·비밀번호, 안전한 삭제, 세션 끊기.

## 대상과 탭
- 대상 엔진: Aurora PostgreSQL 클러스터(`aurora-postgresql`), RDS for PostgreSQL 인스턴스와 Multi-AZ DB 클러스터(`postgres`).
- RDS의 DB Clusters·DB Instances 목록에서 대상 행을 더블클릭하면 탭이 열린다. DB Instances 목록의 Aurora 인스턴스(`aurora-postgresql`)를 더블클릭하면 그 인스턴스가 속한 클러스터의 탭이 열린다. 같은 대상은 탭 하나만 연다(다시 더블클릭하면 그 탭으로 간다). 다른 엔진의 행을 더블클릭하면 "PostgreSQL 엔진만 열 수 있어요" 알림을 보인다.
- 탭 제목: "🐘 <식별자>". 탭을 닫으면 그 탭의 DB 연결을 모두 닫는다. 프로필을 바꾸면 다른 리소스 탭처럼 닫는다.
- Aurora 클러스터는 클러스터 엔드포인트(쓰기)에 연결한다. 인스턴스는 인스턴스 엔드포인트에 연결한다. 읽기 전용 복제본 인스턴스는 열 수는 있지만 변경 버튼이 꺼진다("읽기 전용 복제본이라 바꿀 수 없어요").

## 접속
- 네트워크: 사용자의 VPN·사내망으로 엔드포인트에 직접 TCP 연결한다. 연결 시간 제한은 10초다.
- TLS: 앱에 넣은 RDS 전역 CA 번들(`global-bundle.pem`)로 인증서와 호스트 이름을 검증한다(verify-full). 검증에 실패하면 연결하지 않는다.
- 로그인: 지금 프로필의 자격 증명으로 IAM 인증 토큰(15분 유효)을 만들어 비밀번호 자리에 쓴다. 토큰은 연결할 때마다 새로 만들고 기록하거나 화면·명령 결과로 돌려주지 않는다.
- 로그인 사용자: 대상마다 처음 열 때 DB 사용자 이름을 묻고(예: `iam_admin`), 대상 ARN별로 설정 파일에 기억한다. 탭 위쪽 줄에서 바꿀 수 있다.
- 필요한 것
  - 대상에 IAM 데이터베이스 인증이 켜져 있어야 한다. 꺼져 있으면 연결을 시도하지 않고 "이 클러스터는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요"를 보인다.
  - 프로필에 `rds:DescribeDBClusters`, `rds:DescribeDBInstances`, `rds-db:connect`(해당 DB 사용자) 권한.
  - 로그인 사용자에게 `rds_iam`이 있어야 하고, 관리하려면 `rds_superuser` 멤버이거나 CREATEROLE이 있어야 한다. 없으면 읽기 화면은 보여주되 변경 버튼은 끄고 이유를 보인다.
- 연결 관리
  - 탭마다 데이터베이스 하나에 연결 하나를 둔다. 처음에는 대상의 기본 데이터베이스(DatabaseName, 없으면 `postgres`)에 연결해 클러스터 전체 정보를 읽는다. 다른 데이터베이스는 그 화면을 처음 볼 때 연결한다.
  - 10분 동안 쓰지 않은 연결은 닫고, 다시 필요하면 새 토큰으로 연결한다.
  - 읽기는 모두 `BEGIN READ ONLY` 트랜잭션에서 `statement_timeout = 30s`로 한다. 쓰기는 `lock_timeout = 5s`, `statement_timeout = 60s`로 한다.
- 오류 문구
  - 연결 실패·시간 초과: "엔드포인트에 연결하지 못했어요(<호스트>:<포트>). VPN이 켜져 있는지 확인하세요"
  - IAM 인증 실패: "IAM 인증에 실패했어요. 프로필에 rds-db:connect 권한이 있는지, DB 사용자 <사용자>에게 rds_iam이 있는지 확인하세요"
  - TLS 검증 실패: "서버 인증서를 확인하지 못했어요"
  - 데이터베이스 없음·접속 권한 없음: PostgreSQL 오류 문구를 그대로 붙여 "<데이터베이스>에 연결하지 못했어요: <이유>"
  - SSO 세션 만료는 지금처럼 앱의 자동 로그인 흐름을 탄다.

## 카탈로그 스냅숏
- 클러스터 전체(기본 데이터베이스에서 한 번): 서버 버전(`server_version_num`), `password_encryption`, 역할(`pg_roles`), 구성원(`pg_auth_members`, PG16 이상은 `inherit_option`·`admin_option`·`set_option`), 데이터베이스(`pg_database`의 이름·소유자·`datallowconn`·ACL), 역할별 설정(`pg_db_role_setting`), 세션(`pg_stat_activity`).
- 데이터베이스마다: 스키마(`pg_namespace`), 테이블·뷰·구체화 뷰·파티션 테이블·외부 테이블·시퀀스(`pg_class`의 종류·소유자·`relrowsecurity`·ACL), 함수·프로시저(`pg_proc`의 소유자·`prosecdef`·`proconfig`·ACL), 기본 권한(`pg_default_acl`).
- ACL은 `aclexplode(coalesce(acl, acldefault(<종류>, <소유자>)))`로 풀어 (권한을 준 역할, 받는 역할, 권한, grant option)으로 읽는다. 받는 역할 OID 0은 PUBLIC이다. 이렇게 하면 ACL이 비어 있을 때의 기본값(데이터베이스의 PUBLIC CONNECT·TEMP, 함수의 PUBLIC EXECUTE 등)도 그대로 들어온다.
- 시스템 스키마(`pg_catalog`, `information_schema`, `pg_toast`, `pg_temp_*`)와 시스템 데이터베이스(`rdsadmin`, `template0`, `template1`)는 읽지 않는다.
- 한 데이터베이스의 객체가 2만 개를 넘으면 처음 2만 개만 읽고 "객체가 많아 일부만 읽었어요"를 보인다.

## 실효 권한 계산 (순수 함수)
- 역할 R이 객체 O에 권한 P를 갖는 출처
  - 소유자: R이 O의 소유자이거나, 소유자 역할을 상속받는다.
  - 직접: O의 ACL에 R이 받는 역할로 있다.
  - 그룹: R이 상속받는 역할 G가 ACL에 있다. 경로(R ← G1 ← G2)를 함께 남긴다.
  - PUBLIC: ACL에 PUBLIC이 있다.
  - 미리 정의된 역할: `pg_read_all_data`(모든 테이블·뷰·시퀀스 SELECT, 모든 스키마 USAGE), `pg_write_all_data`(모든 테이블·뷰·시퀀스 INSERT·UPDATE·DELETE, 시퀀스는 UPDATE만, 모든 스키마 USAGE)를 상속받는다(PG14 이상). PG17부터는 `pg_maintain`(시퀀스를 뺀 모든 관계의 MAINTAIN)도 있다.
- 상속
  - PG15 이하: 멤버 역할의 `rolinherit`가 참이면 그 구성원 관계로 권한을 상속한다.
  - PG16 이상: 구성원 관계마다 `inherit_option`을 따른다.
  - 상속하지 않는 관계는 "SET ROLE로만 쓸 수 있음"으로 따로 표시한다.
- 실제로 쓸 수 있는지: 테이블 권한이 있어도 데이터베이스 CONNECT나 스키마 USAGE가 없으면 "권한은 있지만 실제로는 못 써요"로 표시한다. RLS가 켜진 테이블은 "행 수준 보안 켜짐" 배지를 붙인다(BYPASSRLS 역할은 예외로 표시).
- `rds_superuser`는 진짜 superuser가 아니다. 권한 검사를 건너뛰지 않으므로 특별 취급하지 않고, 배지(관리자급)로만 표시한다.
- 이 계산은 Docker의 실제 PostgreSQL 14·16에서 `has_table_privilege`, `has_schema_privilege`, `has_database_privilege`, `has_function_privilege`, `has_sequence_privilege`의 결과와 대조해 검증한다.

## 화면
- 위쪽 줄: 대상 이름, 엔진 버전, 로그인한 DB 사용자([바꾸기]), 연결 상태, 읽은 시각, [다시 읽기].
- 왼쪽 메뉴: 점검(건수) · 역할 · 권한 · 기본 권한 · 누가 할 수 있나 · 세션 · 변경 기록(2단계). 권한·기본 권한·누가 할 수 있나는 위쪽에 데이터베이스 선택이 있다.
- 역할 목록
  - 칩 [사용자](`rolcanlogin`) [그룹](로그인 불가)으로 거르고, 툴바 필터는 이름에 적용한다. PostgreSQL은 사용자와 그룹을 구분하지 않으므로 LOGIN을 끈(잠근) 사용자는 [그룹] 쪽에 보인다. 잠그는 미리보기에 이 점을 알린다. 시스템 역할(`rdsadmin`, `rds_*`, `pg_*`, `rdstopmgr`)은 [시스템 역할 보기]를 켜야 보인다.
  - 열: 이름, 종류, 배지, 소속 그룹 수, 구성원 수, 세션 수, 만료일.
  - 배지: 관리자급(`rds_superuser` 멤버), IAM 인증(`rds_iam` 멤버), CREATEROLE, CREATEDB, BYPASSRLS, REPLICATION, 만료됨, 30일 안에 만료, 앱이 로그인한 역할.
- 역할 상세: 탭 [개요] [구성원] [권한] [소유 객체] [세션]
  - 개요: 속성(LOGIN, CREATEDB, CREATEROLE, INHERIT, REPLICATION, BYPASSRLS, 연결 수 제한, 만료일), 역할별 설정, 주석.
  - 구성원: 속한 그룹(상속 여부, ADMIN OPTION)과 이 역할의 구성원.
  - 권한: 데이터베이스별로 스키마 × 수준 요약과 출처. 아직 읽지 않은 데이터베이스는 [불러오기]로 읽는다.
  - 소유 객체: 데이터베이스별 소유한 스키마·테이블·시퀀스·함수 수와 목록.
  - 세션: 이 역할의 지금 연결.
- 권한 표(데이터베이스 하나)
  - 행: 역할(종류별 묶음, 칩과 필터는 역할 목록과 같다). 열: 스키마(이름순). 머리 행과 머리 열은 고정하고, 보이는 행만 그린다.
  - 칸: 그 스키마에 대한 [사용](USAGE)·[만들기](CREATE)와, 그 스키마 테이블에 대한 [읽기](SELECT)·[쓰기](INSERT·UPDATE·DELETE)를 아이콘으로 보인다. 테이블 권한은 "모든 테이블" ●, "일부 테이블" ◐, "없음" ○로 구분한다. 출처가 그룹이나 PUBLIC뿐이면 흐린 색으로 그린다.
  - 칸을 누르면 오른쪽에 그 스키마의 테이블 × 권한(SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) 상세와 출처가 나온다. 시퀀스와 함수도 같은 패널의 탭으로 본다.
  - CONNECT나 USAGE가 없어 실제로 못 쓰는 칸은 ⚠와 이유를 보인다.
  - 데이터베이스 수준 권한(CONNECT, CREATE, TEMP)은 표 위쪽의 첫 열에 둔다.
- 기본 권한(데이터베이스 하나)
  - 행: (만드는 역할, 스키마 또는 "모든 스키마"). 열: 테이블, 시퀀스, 함수, 타입, 스키마. 칸: 받는 역할과 권한.
  - 각 행 아래에 문장으로 풀어 쓴다: "migrator가 public에 테이블을 만들면 app_read가 SELECT를 받아요". PostgreSQL 기본값(함수의 PUBLIC EXECUTE, 타입의 PUBLIC USAGE)도 "기본값"으로 표시한다.
- 누가 할 수 있나: 데이터베이스, 객체(스키마·테이블·시퀀스·함수 검색), 권한을 고르면 할 수 있는 역할 목록(사용자 먼저)과 이유 경로를 보인다. 예: "readonly ← 그룹 app_read ← orders SELECT". CONNECT·USAGE가 없어 실제로는 못 하는 역할은 따로 묶는다.
- 세션: 역할, 데이터베이스, 클라이언트 주소, application_name, 상태, 시작 시각, 대기 이벤트. 역할로 거르고, 앱 자신의 세션은 표시한다. [끊기]는 2단계.
- 점검: 항목을 누르면 대상 역할·객체로 간다.
  - PUBLIC에 스키마 CREATE 권한이 있음(PG14 이하 public 스키마 기본값 포함).
  - PUBLIC에 테이블·시퀀스 권한이 있음.
  - `rds_superuser` 멤버.
  - CREATEROLE 보유(PG15 이하에서는 거의 관리자급이라는 설명 포함).
  - BYPASSRLS 보유.
  - 만료됐거나 30일 안에 만료되는 로그인 사용자.
  - 로그인 가능한데 속한 그룹도 받은 권한도 없는 사용자.
  - 기본 권한 빈틈: 어떤 역할이 스키마의 모든 테이블에 권한을 갖지만, 그 스키마에 테이블을 만드는 역할(지금 테이블 소유자들)의 기본 권한에는 빠져 있어 새 테이블에는 권한이 없음.
  - `search_path`를 고정하지 않은 SECURITY DEFINER 함수.
  - `password_encryption`이 `md5`임.
  - 화면 아래에 "역할별 비밀번호 해시 방식과 마지막 로그인은 RDS에서 볼 수 없어 점검하지 않아요"를 밝힌다.

## 변경 (2단계)
### 변경 종류
- 역할 만들기: 이름, 종류(사용자·그룹), 속할 그룹, 연결 수 제한, 만료일, 프리셋(선택). 사용자는 앱이 만든 비밀번호를 받는다.
- 그룹 넣기·빼기(ADMIN OPTION 선택).
- 속성 바꾸기: LOGIN(끄면 잠금), CREATEDB, CREATEROLE, INHERIT, 연결 수 제한, 만료일. REPLICATION·BYPASSRLS는 표시만 한다.
- 비밀번호 재설정.
- 객체 권한 주기·빼기: 데이터베이스(CONNECT, CREATE, TEMP), 스키마(USAGE, CREATE), 테이블(SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER), 시퀀스(USAGE, SELECT, UPDATE), 함수(EXECUTE), 스키마의 모든 테이블·모든 시퀀스.
- 기본 권한 주기·빼기: `ALTER DEFAULT PRIVILEGES FOR ROLE <만드는 역할> IN SCHEMA <스키마> GRANT|REVOKE …`.
- 안전한 삭제(아래).
- 세션 끊기(`pg_terminate_backend`).

### 프리셋
- 권한은 그룹 역할에 주고 사용자를 그 그룹에 넣는 것이 기본이다. 프리셋과 같은 권한을 가진 그룹이 이미 있으면 그 그룹을 추천하고, 없으면 그룹 이름을 제안한다(예: `app_read`).
- 읽기 전용: 고른 데이터베이스의 CONNECT, 고른 스키마의 USAGE, 그 스키마의 모든 테이블 SELECT와 모든 시퀀스 SELECT, 그 스키마에 테이블을 만드는 역할(지금 테이블 소유자들, 사용자가 고칠 수 있다)의 기본 권한 SELECT.
- 읽기·쓰기: 읽기 전용에 테이블 INSERT·UPDATE·DELETE, 시퀀스 USAGE, 같은 기본 권한을 더한다.
- 소유자(마이그레이션): CONNECT, 스키마 USAGE·CREATE.
- 관리자: `rds_superuser` 구성원.

### 장바구니
- 권한 표 칸과 역할 상세의 구성원 칸은 할당 표처럼 눌러서 담는다. 칸 상태, 칠하기, 키보드, 50개 한도는 IAM 할당 표와 같다.
- 묶음 하나에는 데이터베이스 하나의 객체 권한과 클러스터 전체 변경(구성원, 속성)만 담는다. 다른 데이터베이스의 칸을 담으려 하면 "다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요"를 보인다.
- 역할 만들기, 비밀번호 재설정, 삭제, 세션 끊기는 장바구니에 담지 않고 바로 미리보기로 간다.

### 미리보기
- 실행할 SQL 문장을 순서대로 그대로 보인다. 비밀번호 자리는 `'••••••••'`로 가린다.
- 영향: 역할별로 얻고 잃는 권한(가상 스냅숏 전후 비교), 구성원과 속성 변화.
- 경고는 막힘 → 확인 → 주의 순서다.
  - 막힘: 시스템 역할(`rdsadmin`, `rds_*`, `pg_*`, `rdstopmgr`)을 바꾸거나 시스템 역할을 그룹으로 넣고 빼기(단 `rds_superuser`·`rds_iam`·`rds_password`·`rds_replication`·`pg_read_all_data` 같은 부여 가능한 역할에 넣고 빼는 것은 된다). 앱 자신의 세션 끊기. 읽기 전용 복제본. 로그인 사용자에게 그 역할을 바꿀 권한이 없음(PG15 이하: `rds_superuser` 멤버이거나 CREATEROLE, PG16 이상: 추가로 대상 역할에 대한 ADMIN OPTION). 스냅숏으로 판단할 수 없는 권한 문제는 적용할 때 PostgreSQL 오류를 그대로 보인다(트랜잭션이라 아무것도 바뀌지 않는다).
  - 확인(이름 입력): `rds_superuser`나 CREATEROLE 주기, 역할 삭제, PUBLIC에 권한 주기, 세션 끊기, 구성원이 10명 이상인 그룹의 권한 바꾸기, 앱이 로그인한 역할이 `rds_iam`·LOGIN·관리 권한을 잃는 변경("적용하면 이 앱이 다시 접속하지 못할 수 있어요").
  - 주의: "모든 테이블" 권한을 주는데 그 스키마의 기본 권한이 없음("새로 만드는 테이블에는 적용되지 않아요" + [기본 권한도 담기]). 이미 그 상태라 달라지는 게 없는 변경.
- 확인 문구: 대상이 하나면 그 역할 이름, 여러 개면 `변경 N개 적용`(IAM 묶음과 같다).

### 적용
- 적용 직전에 영향받는 데이터베이스의 카탈로그를 다시 읽어 미리보기를 다시 계산하고, 사용자가 본 계획과 다르면 "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요"로 거부한다.
- 한 묶음(또는 변경 하나)은 `BEGIN; …; COMMIT;` 한 트랜잭션이다. 하나라도 실패하면 ROLLBACK하고 "적용하지 못했어요: <이유>"를 보인다. 아무것도 바뀌지 않았다.
- 락을 기다리다 `lock_timeout`에 걸리면 "다른 작업이 객체를 잠그고 있어 적용하지 못했어요. 잠시 뒤 다시 시도하세요"를 보인다.
- 비밀번호는 앱에서 SCRAM-SHA-256 해시로 바꿔 `PASSWORD 'SCRAM-SHA-256$…'`로 보낸다. 서버 로그에 평문이 남지 않는다. 새 비밀번호는 적용에 성공한 뒤 결과 창에서 한 번만 보여주고 [복사] 버튼을 둔다. 창을 닫으면 다시 볼 수 없다.
- 적용 뒤에는 스냅숏을 다시 읽는다.

### 안전한 삭제
- 삭제를 고르면 모든 데이터베이스(연결할 수 있는 것)에서 그 역할이 소유한 객체와 받은 권한, 기본 권한을 찾는다. 연결하지 못한 데이터베이스가 있으면 계획을 막고 그 이름을 보인다.
- 넘겨받을 역할(기본값: 앱이 로그인한 역할)을 고르면 계획을 보인다: 데이터베이스마다 `REASSIGN OWNED BY <역할> TO <넘겨받을 역할>; DROP OWNED BY <역할>;`, 마지막에 `DROP ROLE <역할>;`.
- 데이터베이스마다 따로 트랜잭션이다. 실패하면 그 자리에서 멈추고 "N개 데이터베이스 중 k개를 정리하고 멈췄어요: <이유>"와 어디까지 했는지 보인다. 역할 이름을 입력해야 적용된다. 되돌릴 수 없다.

### 변경 기록과 되돌리기
- 앱 데이터 폴더의 `db-changes.jsonl`에 한 줄씩 남긴다: 시각, 프로필, 대상 ARN, 데이터베이스, 로그인 사용자, 변경, 요약, 실행한 SQL(비밀번호 자리는 가림), 결과, 역변경, 묶음 id.
- 되돌릴 수 있음: 권한, 구성원, 속성(이전 값으로), 기본 권한, 역할 만들기(그 역할이 아직 아무것도 소유하지 않고 받은 권한이 만들 때 준 것뿐일 때 `DROP ROLE`).
- 되돌릴 수 없음: 삭제, 비밀번호 재설정, 세션 끊기. 기록에 "되돌릴 수 없어요"로 표시한다.
- 되돌리기도 같은 미리보기를 거친다.

## 계약 (Tauri 명령)
1단계
```ts
type PgTarget = { profile: string; region: string; kind: "cluster" | "instance"; id: string };
pg_target(target: PgTarget): PgTargetInfo                          // RDS API로 대상 확인(연결하지 않음)
pg_open(target: PgTarget, loginUser: string): PgOverview          // 연결, 클러스터 전체 스냅숏
pg_database(target: PgTarget, database: string, force: boolean): PgDatabaseView  // 데이터베이스 하나의 스냅숏(스키마, 객체, ACL, 기본 권한)
pg_cell(target: PgTarget, database: string, role: string, schema: string): PgCellDetail
pg_objects(target: PgTarget, database: string, query: string): PgObjectRef[]
pg_role(target: PgTarget, role: string): PgRoleView
pg_who_can(target: PgTarget, database: string, object: PgObjectRef, privilege: string): PgWhoCan
pg_sessions(target: PgTarget): PgSession[]
pg_findings(target: PgTarget, force: boolean): PgFindings         // 연결할 수 있는 데이터베이스를 모두 읽는다
pg_close(target: PgTarget): void                                  // 탭을 닫을 때
```
- 로그인 사용자 이름은 기존 설정(`Settings.pgLogins`: 대상 ARN → 사용자 이름)에 저장한다.
2단계
```ts
pg_preview(target: PgTarget, change: PgChange): PgPreview
pg_apply(target: PgTarget, change: PgChange, confirmText: string | null, undoOf: string | null): PgApplyResult  // { logId, password?, notes? }
pg_preview_batch(target: PgTarget, database: string, changes: PgChange[]): PgBatchPreview
pg_apply_batch(target: PgTarget, database: string, changes: PgChange[], confirmText: string | null): PgBatchResult
pg_drop_plan(target: PgTarget, role: string, reassignTo: string): PgDropPlan
pg_apply_drop(target: PgTarget, role: string, reassignTo: string, confirmText: string): PgDropResult
pg_change_log(): PgChangeLogEntry[]
pg_undo(logId: string): PgChange
```
- `password`는 `pg_apply` 결과에만 한 번 들어간다. 다른 어떤 명령·기록·오류에도 비밀번호와 토큰이 들어가지 않는다.
- 세부 타입(`PgOverview`, `PgChange` 등)은 구현 계획에서 정하고, IAM 계약처럼 필드는 더하기만 한다.

## 구조
- 백엔드 `src-tauri/src/pg/`
  - `connect.rs`: 대상 확인(DescribeDB*), IAM 토큰(`aws_sdk_rds::auth_token`), TLS(rustls + RDS CA 번들), `tokio-postgres` 연결, 연결 관리(탭·데이터베이스별, 10분 유휴 종료), 오류 분류.
  - `catalog.rs`: 읽기 전용 질의와 스냅숏 만들기.
  - `model.rs`, `eval.rs`(실효 권한과 출처), `whocan.rs`, `checks.rs`: 순수 함수.
  - 2단계: `change/`(변경 종류, SQL 만들기, 역변경, 가상 스냅숏 반영, 미리보기·경고), `commit.rs`(계획 재확인 후 트랜잭션 적용), `exec.rs`(바꾸는 SQL을 실행하는 유일한 곳), `log.rs`.
  - `pg_commands.rs`: Tauri 명령. 계획 저장소는 IAM의 `PlanStore<P>`를 쓴다.
- 안전 규칙
  - 바꾸는 SQL은 `pg/exec.rs`에서만 실행한다. 다른 모듈의 질의는 모두 `BEGIN READ ONLY` 트랜잭션 안에서 돈다. 검사 테스트가 다른 파일에서 실행 함수를 쓰지 않는지 확인한다(IAM의 `write.rs` 규칙과 같다).
  - SQL에 식별자는 따옴표 함수 하나로만, 값은 리터럴 함수 하나로만 넣는다.
  - 토큰과 비밀번호는 로그·기록·오류·명령 결과에 넣지 않는다(새 비밀번호를 한 번 돌려주는 `pg_apply` 결과만 예외).
- 프론트 `src/pg/`: IAM에서 만든 부품을 다시 쓴다(ListTable, PickerSheet, previewParts, useApplyFlow, 할당 표의 칸·칠하기·장바구니 방식).

## 테스트
- 단위 테스트(Rust): ACL 평가와 출처, 상속(PG15·PG16 규칙), 따옴표·리터럴, SQL 생성, 미리보기·경고·역변경, 점검, 비밀번호 해시 형식. 스냅숏 픽스처로 돈다.
- 실제 PostgreSQL 대조 테스트: `scripts/pg-live-test.sh`가 Docker로 postgres 14와 16 컨테이너를 띄우고 `#[ignore]` 테스트를 돌린다.
  - 역할·그룹·스키마·테이블·함수·기본 권한 시나리오를 만들고, 실효 권한 계산을 `has_*_privilege` 결과와 칸마다 비교한다.
  - 카탈로그 질의가 두 버전에서 모두 읽히는지, 트랜잭션 적용·ROLLBACK, `lock_timeout`, 비밀번호 해시로 로그인되는지 확인한다.
  - 평소 `cargo test`에서는 건너뛴다.
- 프론트(vitest): 화면, 장바구니, 미리보기, 결과 창(비밀번호 한 번 보이기)을 API를 흉내 내어 확인한다.
- 수동(테스트 Aurora 클러스터, IAM 인증 켬): 체크리스트에 "RDS PostgreSQL 사용자 관리" 절을 더한다(접속 오류 문구, 권한 표, 프리셋 사용자 만들기와 그 비밀번호로 접속, 안전한 삭제, 세션 끊기, 되돌리기).
