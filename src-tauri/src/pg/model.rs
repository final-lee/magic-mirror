//! 카탈로그 스냅숏의 모델. 서버가 읽어 준 값을 그대로 담고, 상속·출처·실제 효과 같은 해석은 하지 않는다(그것은 `eval`의 일이다).
//! 화면으로 나가는 계약은 따로 있고(`view`), 이것은 그 재료다. 직렬화하지 않는다.
//!
//! 접근 권한(ACL)은 `aclexplode`가 풀어 준 항목 하나가 `AclEntry` 하나다. 객체에 ACL이 비어 있으면(NULL) 서버가 `acldefault`로 채운 기본값이 들어 있다.

/// 권한 종류. `aclexplode`의 `privilege_type` 문자열과 하나씩 맞는다.
/// 순서는 선언 순서다. 화면에 권한을 나열할 때 이 순서를 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Privilege {
    Select,
    Insert,
    Update,
    Delete,
    Truncate,
    References,
    Trigger,
    /// PG17부터 테이블에 있는 권한(VACUUM, ANALYZE, REINDEX 등을 허용한다)
    Maintain,
    Execute,
    Usage,
    Create,
    Connect,
    Temporary,
}

impl Privilege {
    /// `aclexplode`가 주는 이름("SELECT" …)을 권한으로 읽는다. 이 앱이 다루지 않는 권한(`SET`, `ALTER SYSTEM`처럼 다른 객체의 것)이나 모르는 이름은 None.
    pub fn from_pg(name: &str) -> Option<Privilege> {
        Some(match name {
            "SELECT" => Privilege::Select,
            "INSERT" => Privilege::Insert,
            "UPDATE" => Privilege::Update,
            "DELETE" => Privilege::Delete,
            "TRUNCATE" => Privilege::Truncate,
            "REFERENCES" => Privilege::References,
            "TRIGGER" => Privilege::Trigger,
            "MAINTAIN" => Privilege::Maintain,
            "EXECUTE" => Privilege::Execute,
            "USAGE" => Privilege::Usage,
            "CREATE" => Privilege::Create,
            "CONNECT" => Privilege::Connect,
            "TEMPORARY" => Privilege::Temporary,
            _ => return None,
        })
    }

    /// `aclexplode`와 같은 이름("SELECT" …)
    pub fn as_str(self) -> &'static str {
        match self {
            Privilege::Select => "SELECT",
            Privilege::Insert => "INSERT",
            Privilege::Update => "UPDATE",
            Privilege::Delete => "DELETE",
            Privilege::Truncate => "TRUNCATE",
            Privilege::References => "REFERENCES",
            Privilege::Trigger => "TRIGGER",
            Privilege::Maintain => "MAINTAIN",
            Privilege::Execute => "EXECUTE",
            Privilege::Usage => "USAGE",
            Privilege::Create => "CREATE",
            Privilege::Connect => "CONNECT",
            Privilege::Temporary => "TEMPORARY",
        }
    }
}

/// ACL 항목 하나: `grantor`가 `grantee`에게 `privilege`를 줬다. `grantee`가 None이면 PUBLIC(모든 역할)이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclEntry {
    pub grantor: String,
    pub grantee: Option<String>,
    pub privilege: Privilege,
    pub grantable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleRec {
    pub name: String,
    pub login: bool,
    pub inherit: bool,
    pub create_role: bool,
    pub create_db: bool,
    pub replication: bool,
    pub bypass_rls: bool,
    pub superuser: bool,
    /// -1은 제한 없음
    pub conn_limit: i32,
    /// ISO 8601 UTC. 없거나 `infinity`면 None. `-infinity`(그 역할은 비밀번호로는 로그인할 수 없다)는 만료로 보이도록 가장 오래된 시각
    /// `1970-01-01T00:00:00Z`로 읽는다
    pub valid_until: Option<String>,
    pub comment: Option<String>,
}

/// 구성원 관계마다 INHERIT·SET 옵션이 있는 첫 서버 버전(`server_version_num`). 카탈로그는 이 버전부터 두 옵션을 함께 읽는 질의를 고르고,
/// `eval`은 이 버전부터 구성원 역할의 `rolinherit` 대신 관계의 INHERIT 옵션으로 상속을 가른다.
pub const MEMBERSHIP_OPTIONS_SINCE: i32 = 160_000;

/// 역할 구성원 관계 하나: `member`가 `group`의 구성원이다. 쌍마다 하나다(PG16에서 부여자가 여럿이어도 하나로 합친다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberRec {
    pub member: String,
    pub group: String,
    pub admin: bool,
    /// PG16부터 부여마다 있는 INHERIT 옵션. 그 전 버전에는 없어서 None이다(그때는 구성원의 `inherit` 속성이 정한다).
    pub inherit: Option<bool>,
    /// PG16부터 부여마다 있는 SET 옵션(`SET ROLE`을 허용하는지). 그 전 버전에는 없어서 None이다(그때는 구성원이면 언제나 `SET ROLE`을 할 수 있다).
    /// PG16에서 CREATEROLE 사용자가 만든 역할은 그 사용자에게 `admin: true, inherit: Some(false), set: Some(false)`로 부여된다.
    pub set: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseRec {
    pub name: String,
    pub owner: String,
    pub allow_conn: bool,
    pub acl: Vec<AclEntry>,
}

/// `ALTER ROLE … SET`·`ALTER DATABASE … SET`로 정한 설정 하나. 역할이나 데이터베이스가 None이면 "모두"다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleSettingRec {
    pub role: Option<String>,
    pub database: Option<String>,
    /// `이름=값`
    pub setting: String,
}

/// 접속 중인 세션 하나(`pg_stat_activity`의 클라이언트 백엔드). 값이 없는 칸은 None이다.
/// 로그인 사용자가 superuser도 `pg_read_all_stats` 멤버도 아니면 다른 역할의 세션은 역할·데이터베이스·응용 이름만 오고
/// 나머지(`state`, `client_addr`, `backend_start`, `query_start`, `wait_event`)는 None이다(`catalog::sessions` 참고).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRec {
    pub pid: i32,
    pub role: Option<String>,
    pub database: Option<String>,
    pub client_addr: Option<String>,
    pub application_name: String,
    pub state: Option<String>,
    pub backend_start: Option<String>,
    pub query_start: Option<String>,
    pub wait_event: Option<String>,
}

/// 클러스터 전체에 걸친 것: 역할, 구성원 관계, 데이터베이스, 역할별 설정, 세션
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterSnapshot {
    /// `server_version_num`(160004 같은 값)
    pub version_num: i32,
    pub version: String,
    /// `md5` 또는 `scram-sha-256`
    pub password_encryption: String,
    /// 앱이 이 연결로 로그인한 DB 사용자
    pub login_user: String,
    pub roles: Vec<RoleRec>,
    pub members: Vec<MemberRec>,
    /// 템플릿과 `rdsadmin`은 뺀다
    pub databases: Vec<DatabaseRec>,
    pub settings: Vec<RoleSettingRec>,
    pub sessions: Vec<SessionRec>,
    /// ISO 8601 UTC
    pub fetched_at: String,
}

/// 관계(`pg_class`)의 종류. 괄호는 `relkind` 코드.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RelKind {
    /// r
    Table,
    /// v
    View,
    /// m
    MatView,
    /// p
    Partitioned,
    /// f
    Foreign,
    /// S
    Sequence,
}

impl RelKind {
    /// `relkind`의 한 글자 코드를 읽는다. 이 앱이 다루지 않는 종류(인덱스 등)나 모르는 코드는 None.
    pub fn from_pg(code: &str) -> Option<RelKind> {
        Some(match code {
            "r" => RelKind::Table,
            "v" => RelKind::View,
            "m" => RelKind::MatView,
            "p" => RelKind::Partitioned,
            "f" => RelKind::Foreign,
            "S" => RelKind::Sequence,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaRec {
    pub name: String,
    pub owner: String,
    pub acl: Vec<AclEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationRec {
    pub schema: String,
    pub name: String,
    pub kind: RelKind,
    pub owner: String,
    /// 행 수준 보안이 켜져 있다
    pub rls: bool,
    pub acl: Vec<AclEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionRec {
    pub schema: String,
    pub name: String,
    /// 같은 이름을 구분하는 인자 목록(`pg_get_function_identity_arguments`). 이름과 괄호는 빠진다(예: `a integer, b text`)
    pub signature: String,
    pub owner: String,
    pub security_definer: bool,
    /// 함수에 `search_path`가 고정되어 있다
    pub search_path_set: bool,
    pub acl: Vec<AclEntry>,
}

/// 기본 권한(`ALTER DEFAULT PRIVILEGES`)이 적용되는 객체 종류. 괄호는 `defaclobjtype` 코드.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DefaultObjType {
    /// r
    Tables,
    /// S
    Sequences,
    /// f
    Functions,
    /// T
    Types,
    /// n
    Schemas,
}

impl DefaultObjType {
    /// `defaclobjtype`의 한 글자 코드를 읽는다. 이 앱이 다루지 않는 종류(새 서버가 더한 것 등)나 모르는 코드는 None.
    pub fn from_pg(code: &str) -> Option<DefaultObjType> {
        Some(match code {
            "r" => DefaultObjType::Tables,
            "S" => DefaultObjType::Sequences,
            "f" => DefaultObjType::Functions,
            "T" => DefaultObjType::Types,
            "n" => DefaultObjType::Schemas,
            _ => return None,
        })
    }
}

/// 기본 권한 하나: `creator`가 `schema`(None이면 모든 스키마)에 새 객체를 만들면 `acl`이 붙는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultAclRec {
    pub creator: String,
    pub schema: Option<String>,
    pub obj_type: DefaultObjType,
    pub acl: Vec<AclEntry>,
}

/// 데이터베이스 하나 안의 것: 스키마, 관계, 함수, 기본 권한
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbSnapshot {
    pub database: String,
    pub owner: String,
    pub schemas: Vec<SchemaRec>,
    pub relations: Vec<RelationRec>,
    pub functions: Vec<FunctionRec>,
    pub default_acls: Vec<DefaultAclRec>,
    /// 객체가 너무 많아 일부만 읽었다. 관계가 먼저 자리를 잡고(이름순 앞쪽), 함수는 남는 자리만큼만 읽는다
    pub truncated: bool,
    /// ISO 8601 UTC
    pub fetched_at: String,
}
