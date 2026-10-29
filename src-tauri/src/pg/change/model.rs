//! 변경의 모양(계약의 `PgChange`와 그 부품). 화면이 보낸 변경이 그대로 이 값으로 읽히고, 미리보기·적용·변경 기록이 같은 값을 쓴다.
//! 필드 이름은 camelCase고 종류는 `kind`로 가른다(계약과 같다). 값이 없는 칸은 생략하지 않고 `null`로 쓴다.
//! 권한은 `aclexplode`가 주는 이름("SELECT" …)으로 쓰고 읽는다. 모르는 이름은 읽지 않는다.

use serde::{Deserialize, Serialize};

use crate::pg::model::{DefaultObjType, Privilege, RoleRec};

/// 권한을 주고받는 객체
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GrantTarget {
    Database { name: String },
    Schema { name: String },
    /// 테이블·뷰·구체화 뷰·파티션 테이블·외부 테이블
    Relation { schema: String, name: String },
    Sequence { schema: String, name: String },
    /// `signature`는 서버가 찍어 준 인자 목록이다(`FunctionRec::signature`). 문장에 그대로 들어가므로 스냅숏의 함수와 정확히 맞는 것만 쓴다(`OnClause::Routine`)
    Function { schema: String, name: String, signature: String },
    AllTables { schema: String },
    AllSequences { schema: String },
}

/// 객체 하나와 그 객체에 주고받는 권한들
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantItem {
    pub target: GrantTarget,
    #[serde(with = "privilege_names")]
    pub privileges: Vec<Privilege>,
}

/// 새 역할에 함께 주는 권한 묶음의 종류
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PresetKind {
    ReadOnly,
    ReadWrite,
    Owner,
    Admin,
}

/// 프리셋 선택
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetChoice {
    pub preset: PresetKind,
    /// 관리자(`Admin`)만 None
    pub database: Option<String>,
    /// 관리자만 비어 있다
    pub schemas: Vec<String>,
    /// 읽기·읽기쓰기: 이 역할들이 만드는 새 테이블과 시퀀스에도 기본 권한을 준다
    pub creators: Vec<String>,
    /// 권한을 받는 그룹. None이면 새 역할 자신(관리자는 None)
    pub group: Option<String>,
    /// `group`을 같은 트랜잭션에서 만든다
    pub create_group: bool,
}

/// 바라는 속성 전체
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributesSet {
    pub login: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub inherit: bool,
    /// -1은 제한 없음
    pub connection_limit: i32,
    /// ISO 8601 UTC. None은 만료 없음
    pub valid_until: Option<String>,
}

impl AttributesSet {
    /// 역할이 지금 가진 속성 전체
    pub fn of(rec: &RoleRec) -> AttributesSet {
        AttributesSet {
            login: rec.login,
            create_db: rec.create_db,
            create_role: rec.create_role,
            inherit: rec.inherit,
            connection_limit: rec.conn_limit,
            valid_until: rec.valid_until.clone(),
        }
    }
}

/// 데이터베이스를 바꾸는 변경 하나
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PgChange {
    /// 역할 만들기. `groups`에 넣고, `preset`이 있으면 그 권한도 함께 준다
    CreateRole { name: String, login: bool, groups: Vec<String>, connection_limit: i32, valid_until: Option<String>, preset: Option<PresetChoice> },
    /// `add`면 `group`에 `member`를 넣고 아니면 뺀다. `admin`이면 ADMIN OPTION만 다룬다
    Membership { group: String, member: String, add: bool, admin: bool },
    /// 속성을 `set`으로 바꾼다(바라는 속성 전체). 달라지는 칸만 문장이 된다
    Attributes { role: String, set: AttributesSet },
    /// 새 비밀번호를 만들어 정한다
    Password { role: String },
    /// `database` 안의 객체들에 `grantee`가 받는 권한을 주거나(`add`) 거둔다. `grantee`가 `PUBLIC`이면 모든 역할이다
    Grant { database: String, grantee: String, add: bool, items: Vec<GrantItem> },
    /// `creator`가 `schema`(None이면 모든 스키마)에 새로 만드는 `object_type` 객체의 기본 권한을 `grantee`에게 주거나(`add`) 거둔다
    DefaultPrivilege {
        database: String,
        creator: String,
        schema: Option<String>,
        #[serde(with = "object_type_name")]
        object_type: DefaultObjType,
        grantee: String,
        #[serde(with = "privilege_names")]
        privileges: Vec<Privilege>,
        add: bool,
    },
    /// 역할 만들기를 되돌릴 때만 쓴다
    DropRole { role: String },
    /// 세션 끊기. pid와 역할이 같고, 시작 시각(ISO 8601 UTC)을 알면 그 초까지 같을 때만 끊는다
    Terminate { pid: i32, role: String, backend_start: Option<String> },
}

impl PgChange {
    /// 이 변경이 도는 데이터베이스. 권한(`Grant`)과 기본 권한(`DefaultPrivilege`)은 자기 `database`에서 돌고, 프리셋이 데이터베이스를 정한 `CreateRole`도 그렇다
    /// (프리셋의 권한을 그 데이터베이스에 준다). 나머지는 모두 대상의 기본 데이터베이스에서 돈다: 역할·구성원 관계·속성·비밀번호·세션은 클러스터 전체의 것이다.
    pub fn execution_database<'a>(&'a self, default_db: &'a str) -> &'a str {
        match self {
            PgChange::Grant { database, .. } | PgChange::DefaultPrivilege { database, .. } => database,
            PgChange::CreateRole { preset: Some(PresetChoice { database: Some(database), .. }), .. } => database,
            _ => default_db,
        }
    }
}

/// 권한 목록을 `aclexplode`가 주는 이름("SELECT" …)으로 쓰고 읽는다. `Privilege::from_pg`가 모르는 이름이 하나라도 있으면 읽지 못한다.
/// 이름의 목록은 `Privilege`(`as_str`, `from_pg`) 하나에만 있다.
mod privilege_names {
    use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

    use crate::pg::model::Privilege;

    pub fn serialize<S: Serializer>(privileges: &[Privilege], serializer: S) -> Result<S::Ok, S::Error> {
        privileges.iter().map(|privilege| privilege.as_str()).collect::<Vec<_>>().serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Privilege>, D::Error> {
        Vec::<String>::deserialize(deserializer)?
            .into_iter()
            .map(|name| Privilege::from_pg(&name).ok_or_else(|| de::Error::custom(format!("알 수 없는 권한이에요: {name}"))))
            .collect()
    }
}

/// 기본 권한의 객체 종류를 계약의 이름("tables" …)으로 쓰고 읽는다(`view::PgDefaultObjectType`과 같은 이름이다)
mod object_type_name {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use crate::pg::model::DefaultObjType;

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    enum Name {
        Tables,
        Sequences,
        Functions,
        Types,
        Schemas,
    }

    impl From<DefaultObjType> for Name {
        fn from(object_type: DefaultObjType) -> Name {
            match object_type {
                DefaultObjType::Tables => Name::Tables,
                DefaultObjType::Sequences => Name::Sequences,
                DefaultObjType::Functions => Name::Functions,
                DefaultObjType::Types => Name::Types,
                DefaultObjType::Schemas => Name::Schemas,
            }
        }
    }

    impl From<Name> for DefaultObjType {
        fn from(name: Name) -> DefaultObjType {
            match name {
                Name::Tables => DefaultObjType::Tables,
                Name::Sequences => DefaultObjType::Sequences,
                Name::Functions => DefaultObjType::Functions,
                Name::Types => DefaultObjType::Types,
                Name::Schemas => DefaultObjType::Schemas,
            }
        }
    }

    pub fn serialize<S: Serializer>(object_type: &DefaultObjType, serializer: S) -> Result<S::Ok, S::Error> {
        Name::from(*object_type).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<DefaultObjType, D::Error> {
        Name::deserialize(deserializer).map(DefaultObjType::from)
    }
}

#[cfg(test)]
mod tests;
