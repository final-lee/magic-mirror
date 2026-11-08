//! 아이템 쓰기의 미리 보기와 되돌리기.
use serde_json::{json, Value};
use crate::error::AppError;
use super::{attr, change::{Call, DynamoChange, DynamoPreview}, item_write::{self, ItemExpressions}, DynamoTable};

pub fn key_names(table: &DynamoTable) -> Vec<String> {
    let mut names = vec![table.keys.pk.name.clone()];
    if let Some(sk) = &table.keys.sk {
        names.push(sk.name.clone());
    }
    names
}

fn expression_params(expressions: ItemExpressions) -> Result<Value, AppError> {
    let values = expressions.expressions.values.iter()
        .map(|(name, value)| Ok((name.clone(), attr::to_json(value)?)))
        .collect::<Result<serde_json::Map<String, Value>, AppError>>()?;
    let mut params = json!({
        "conditionExpression": expressions.condition,
        "expressionAttributeNames": expressions.expressions.names,
    });
    if !values.is_empty() {
        params["expressionAttributeValues"] = Value::Object(values);
    }
    if let Some(update) = expressions.update {
        params["updateExpression"] = json!(update);
    }
    Ok(params)
}

fn add(params: &mut Value, name: &str, value: Value) {
    params.as_object_mut().unwrap().insert(name.into(), value);
}

pub fn put(table: &DynamoTable, item: &Value) -> Result<Value, AppError> {
    attr::item_from_json(item)?;
    item_write::key(item, &key_names(table))?;
    let mut params = expression_params(item_write::not_exists_condition(&table.keys.pk.name)?)?;
    add(&mut params, "tableName", json!(table.name));
    add(&mut params, "item", item.clone());
    Ok(params)
}

pub fn delete(table: &DynamoTable, item: &Value) -> Result<Value, AppError> {
    let mut params = expression_params(item_write::same_item_condition(item)?)?;
    add(&mut params, "tableName", json!(table.name));
    add(&mut params, "key", item_write::key(item, &key_names(table))?);
    add(&mut params, "returnValues", json!("ALL_OLD"));
    Ok(params)
}

pub fn update(table: &DynamoTable, key: &Value, original: &Value, updated: &Value, guard_all: bool) -> Result<Value, AppError> {
    let names = key_names(table);
    if item_write::key(original, &names)? != *key {
        return Err(AppError::other("아이템 키가 원래 값과 일치하지 않아요."));
    }
    let expressions = if guard_all {
        item_write::update_guarded(original, updated, &names, true)?
    } else {
        item_write::update(original, updated, &names)?
    };
    let mut params = expression_params(expressions)?;
    add(&mut params, "tableName", json!(table.name));
    add(&mut params, "key", key.clone());
    Ok(params)
}

pub fn moved(table: &DynamoTable, original: &Value, updated: &Value) -> Result<Value, AppError> {
    let names = key_names(table);
    if item_write::key(original, &names)? == item_write::key(updated, &names)? {
        return Err(AppError::other("키가 바뀌지 않았어요."));
    }
    let put = put(table, updated)?;
    let mut delete = delete(table, original)?;
    delete.as_object_mut().unwrap().remove("returnValues");
    Ok(json!({"transactItems": [{"put": put}, {"delete": delete}]}))
}

pub fn is_item(change: &DynamoChange) -> bool {
    matches!(change, DynamoChange::PutItem { .. } | DynamoChange::UpdateItem { .. }
        | DynamoChange::MoveItem { .. } | DynamoChange::DeleteItems { .. }
        | DynamoChange::RestoreItems { .. })
}

/// 아이템 변경 하나의 제목, 보낼 호출, diff, 되돌리기
type ItemPlan = (&'static str, Result<Vec<Call>, AppError>, Option<Value>, Option<DynamoChange>);

pub fn preview(table: &DynamoTable, change: &DynamoChange) -> Option<DynamoPreview> {
    if !is_item(change) {
        return None;
    }
    let mut warnings = Vec::new();
    let (title, calls, diff, inverse): ItemPlan = match change {
        DynamoChange::PutItem { item, condition } => (
            "아이템 만들기",
            if condition.is_some() {
                Err(AppError::other("지원하지 않는 아이템 조건이에요."))
            } else {
                put(table, item).map(|params| vec![Call { api: "PutItem".into(), params }])
            },
            Some(json!({"before": null, "after": item})),
            Some(DynamoChange::DeleteItems { items: vec![item.clone()] }),
        ),
        DynamoChange::UpdateItem { key, original, updated, guard_all } => (
            "아이템 편집", update(table, key, original, updated, *guard_all).map(|params| vec![Call { api: "UpdateItem".into(), params }]),
            Some(json!({"before": original, "after": updated})),
            Some(DynamoChange::UpdateItem { key: key.clone(), original: updated.clone(), updated: original.clone(), guard_all: true }),
        ),
        DynamoChange::MoveItem { original, updated } => {
            warnings.push("키를 바꾸면 새 아이템을 만들고 기존 아이템을 삭제하는 트랜잭션을 보내요.".into());
            ("아이템 키 이동", moved(table, original, updated).map(|params| vec![Call { api: "TransactWriteItems".into(), params }]),
                Some(json!({"before": original, "after": updated})),
                Some(DynamoChange::MoveItem { original: updated.clone(), updated: original.clone() }))
        },
        DynamoChange::DeleteItems { items } => (
            "아이템 삭제", if items.is_empty() || items.len() > 1000 { Err(AppError::other("1개 이상 1,000개 이하의 아이템을 선택해 주세요.")) } else {
                items.iter().map(|item| Ok(Call { api: "DeleteItem".into(), params: delete(table, item)? })).collect()
            }, Some(json!({"before": items, "after": null})), Some(DynamoChange::RestoreItems { items: items.clone() }),
        ),
        DynamoChange::RestoreItems { items } => (
            "삭제한 아이템 복원", items.iter().map(|item| Ok(Call { api: "PutItem".into(), params: put(table, item)? })).collect(),
            Some(json!({"before": null, "after": items})), Some(DynamoChange::DeleteItems { items: items.clone() }),
        ),
        _ => unreachable!(),
    };
    let (calls, blocked) = match calls {
        Ok(calls) => (calls, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    let lower = table.name.to_ascii_lowercase();
    let needs_name = lower.contains("prod") || lower.contains("prd")
        || matches!(change, DynamoChange::DeleteItems { items } if items.len() >= 2);
    Some(DynamoPreview {
        title: title.into(), calls, diff, impact: Vec::new(), warnings, blocked,
        confirm_name: needs_name.then(|| table.name.clone()), inverse,
    })
}

#[cfg(test)]
mod tests;
