//! 아이템 변경의 조건식과 UpdateItem 식을 만든다.
use serde_json::{Map, Value};

use crate::dynamo::{attr, expr::Expressions};
use crate::error::AppError;

pub struct ItemExpressions {
    pub update: Option<String>,
    pub condition: String,
    pub expressions: Expressions,
}

fn object(item: &Value) -> Result<&Map<String, Value>, AppError> {
    item.as_object().ok_or_else(|| AppError::other("아이템은 DynamoDB JSON 객체여야 해요."))
}

/// 테이블 키만 추려서 DynamoDB JSON으로 돌려준다.
pub fn key(item: &Value, key_names: &[String]) -> Result<Value, AppError> {
    let item = object(item)?;
    if key_names.is_empty() {
        return Err(AppError::other("테이블 키 정보가 없어요."));
    }
    let mut key = Map::new();
    for name in key_names {
        let value = item.get(name).ok_or_else(|| AppError::other("아이템에 키 속성이 없어요."))?;
        attr::from_json(value)?;
        key.insert(name.clone(), value.clone());
    }
    Ok(Value::Object(key))
}

/// 새 키가 비어 있어야 한다는 조건을 만든다.
pub fn not_exists_condition(partition_key: &str) -> Result<ItemExpressions, AppError> {
    let mut expressions = Expressions::default();
    let name = expressions.name(partition_key)?;
    Ok(ItemExpressions {
        update: None,
        condition: format!("attribute_not_exists({name})"),
        expressions,
    })
}

/// 읽은 아이템의 각 속성이 그대로인지 확인한다.
pub fn same_item_condition(item: &Value) -> Result<ItemExpressions, AppError> {
    let item = object(item)?;
    if item.is_empty() {
        return Err(AppError::other("빈 아이템은 삭제할 수 없어요."));
    }
    let mut expressions = Expressions::default();
    let mut conditions = Vec::with_capacity(item.len());
    for (attribute, value) in item {
        let name = expressions.name(attribute)?;
        let value = expressions.value(value)?;
        conditions.push(format!("{name} = {value}"));
    }
    Ok(ItemExpressions {
        update: None,
        condition: conditions.join(" AND "),
        expressions,
    })
}

/// 바뀐 속성만 SET/REMOVE하며 읽었을 때의 값으로 충돌을 감지한다.
pub fn update(original: &Value, updated: &Value, key_names: &[String]) -> Result<ItemExpressions, AppError> {
    update_guarded(original, updated, key_names, false)
}

pub fn update_guarded(original: &Value, updated: &Value, key_names: &[String], guard_all: bool) -> Result<ItemExpressions, AppError> {
    let original = object(original)?;
    let updated = object(updated)?;
    if key_names.is_empty() {
        return Err(AppError::other("테이블 키 정보가 없어요."));
    }
    for name in key_names {
        if original.get(name).is_none() || original.get(name) != updated.get(name) {
            return Err(AppError::other("키 변경은 아이템 이동으로 처리해 주세요."));
        }
    }

    let mut expressions = Expressions::default();
    let mut sets = Vec::new();
    let mut removes = Vec::new();
    let mut conditions = Vec::new();
    for key in key_names {
        let name = expressions.name(key)?;
        let value = expressions.value(original.get(key).expect("키는 앞에서 확인했어요"))?;
        conditions.push(format!("{name} = {value}"));
    }
    for (attribute, value) in updated {
        if key_names.contains(attribute) || original.get(attribute) == Some(value) {
            continue;
        }
        let name = expressions.name(attribute)?;
        if let Some(old) = original.get(attribute) {
            let old = expressions.value(old)?;
            conditions.push(format!("{name} = {old}"));
        } else {
            conditions.push(format!("attribute_not_exists({name})"));
        }
        let value = expressions.value(value)?;
        sets.push(format!("{name} = {value}"));
    }
    for (attribute, old) in original {
        if key_names.contains(attribute) || updated.contains_key(attribute) {
            continue;
        }
        let name = expressions.name(attribute)?;
        let old = expressions.value(old)?;
        conditions.push(format!("{name} = {old}"));
        removes.push(name);
    }
    if sets.is_empty() && removes.is_empty() {
        return Err(AppError::other("변경된 속성이 없어요."));
    }
    if guard_all {
        for (attribute, value) in original {
            if key_names.contains(attribute) || updated.get(attribute) != Some(value) {
                continue;
            }
            let name = expressions.name(attribute)?;
            let value = expressions.value(value)?;
            conditions.push(format!("{name} = {value}"));
        }
    }
    for version in ["version", "revision", "_version", "ver"] {
        if guard_all || key_names.iter().any(|key| key == version) || original.get(version) != updated.get(version) {
            continue;
        }
        if let Some(value) = original.get(version).filter(|value| value.get("N").is_some()) {
            let name = expressions.name(version)?;
            let value = expressions.value(value)?;
            conditions.push(format!("{name} = {value}"));
        }
    }
    let mut clauses = Vec::new();
    if !sets.is_empty() {
        clauses.push(format!("SET {}", sets.join(", ")));
    }
    if !removes.is_empty() {
        clauses.push(format!("REMOVE {}", removes.join(", ")));
    }
    Ok(ItemExpressions {
        update: Some(clauses.join(" ")),
        condition: conditions.join(" AND "),
        expressions,
    })
}

#[cfg(test)]
mod tests;
