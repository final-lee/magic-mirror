//! 아이템 쓰기 실행과 항목별 충돌 결과.
use std::collections::HashMap;
use aws_sdk_dynamodb::{Client, types::{AttributeValue, Delete, Put, TransactWriteItem}};
use futures::{stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use crate::error::AppError;
use super::{attr, change::DynamoChange, item_change, item_write, DynamoTable};

const CONFLICT: &str = "읽은 뒤 다른 곳에서 바뀌었어요. 다시 읽어 주세요";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub item: Value,
    pub ok: bool,
    pub error: Option<String>,
    pub latest: Option<Value>,
    pub before_image: Option<Value>,
}

fn text<'a>(params: &'a Value, name: &str) -> &'a str {
    params[name].as_str().unwrap_or_default()
}

fn names(params: &Value) -> HashMap<String, String> {
    params["expressionAttributeNames"].as_object().into_iter().flatten()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect()
}

fn values(params: &Value) -> Result<HashMap<String, AttributeValue>, AppError> {
    params["expressionAttributeValues"].as_object().into_iter().flatten()
        .map(|(key, value)| Ok((key.clone(), attr::from_json(value)?)))
        .collect()
}

async fn result(client: &Client, table: &DynamoTable, item: &Value, error: Option<String>) -> ItemResult {
    let conflict = error.as_ref().is_some_and(|message| message.contains("ConditionalCheckFailed"));
    let latest = if conflict {
        if let Ok(key) = item_write::key(item, &item_change::key_names(table)).and_then(|key| attr::item_from_json(&key)) {
            match client.get_item().table_name(&table.name).set_key(Some(key)).consistent_read(true).send().await {
                Ok(output) => output.item().and_then(|item| attr::item_to_json(item).ok()),
                Err(_) => None,
            }
        } else { None }
    } else { None };
    ItemResult { item: item.clone(), ok: error.is_none(), error: error.map(|error| if conflict { CONFLICT.into() } else { error }), latest, before_image: None }
}

async fn put(client: &Client, table: &DynamoTable, item: &Value) -> ItemResult {
    let sent = async {
        let params = item_change::put(table, item)?;
        let output = client.put_item().table_name(&table.name)
            .set_item(Some(attr::item_from_json(item)?))
            .condition_expression(text(&params, "conditionExpression"))
            .set_expression_attribute_names(Some(names(&params)))
            .send().await;
        Ok::<_, AppError>(output.map_err(|error| format!("{error:?}")))
    }.await;
    let error = match sent { Ok(Ok(_)) => None, Ok(Err(error)) => Some(error), Err(error) => Some(error.to_string()) };
    result(client, table, item, error).await
}

async fn delete(client: &Client, table: &DynamoTable, item: &Value) -> ItemResult {
    let sent = async {
        let params = item_change::delete(table, item)?;
        let output = client.delete_item().table_name(&table.name)
            .set_key(Some(attr::item_from_json(&params["key"])?))
            .condition_expression(text(&params, "conditionExpression"))
            .set_expression_attribute_names(Some(names(&params)))
            .set_expression_attribute_values(Some(values(&params)?))
            .return_values(aws_sdk_dynamodb::types::ReturnValue::AllOld)
            .send().await;
        Ok::<_, AppError>(output.map_err(|error| format!("{error:?}")))
    }.await;
    let (error, before_image) = match sent {
        Ok(Ok(output)) => (None, output.attributes().and_then(|attributes| attr::item_to_json(attributes).ok())),
        Ok(Err(error)) => (Some(error), None),
        Err(error) => (Some(error.to_string()), None),
    };
    let mut outcome = result(client, table, item, error).await;
    outcome.before_image = before_image;
    outcome
}

async fn update(client: &Client, table: &DynamoTable, key: &Value, original: &Value, updated: &Value, guard_all: bool) -> ItemResult {
    let sent = async {
        let params = item_change::update(table, key, original, updated, guard_all)?;
        let output = client.update_item().table_name(&table.name)
            .set_key(Some(attr::item_from_json(key)?))
            .update_expression(text(&params, "updateExpression"))
            .condition_expression(text(&params, "conditionExpression"))
            .set_expression_attribute_names(Some(names(&params)))
            .set_expression_attribute_values(Some(values(&params)?))
            .send().await;
        Ok::<_, AppError>(output.map_err(|error| format!("{error:?}")))
    }.await;
    let error = match sent { Ok(Ok(_)) => None, Ok(Err(error)) => Some(error), Err(error) => Some(error.to_string()) };
    result(client, table, original, error).await
}

async fn moved(client: &Client, table: &DynamoTable, original: &Value, updated: &Value) -> ItemResult {
    let sent = async {
        item_change::moved(table, original, updated)?;
        let p = item_change::put(table, updated)?;
        let d = item_change::delete(table, original)?;
        let put = Put::builder().table_name(&table.name).set_item(Some(attr::item_from_json(updated)?))
            .condition_expression(text(&p, "conditionExpression"))
            .set_expression_attribute_names(Some(names(&p))).build().map_err(|error| AppError::other(error.to_string()))?;
        let delete = Delete::builder().table_name(&table.name).set_key(Some(attr::item_from_json(&d["key"])?))
            .condition_expression(text(&d, "conditionExpression"))
            .set_expression_attribute_names(Some(names(&d))).set_expression_attribute_values(Some(values(&d)?))
            .build().map_err(|error| AppError::other(error.to_string()))?;
        let output = client.transact_write_items()
            .transact_items(TransactWriteItem::builder().put(put).build())
            .transact_items(TransactWriteItem::builder().delete(delete).build()).send().await;
        Ok::<_, AppError>(output.map_err(|error| format!("{error:?}")))
    }.await;
    let error = match sent { Ok(Ok(_)) => None, Ok(Err(error)) => Some(error), Err(error) => Some(error.to_string()) };
    result(client, table, original, error).await
}

pub async fn apply(cfg: &aws_config::SdkConfig, table: &DynamoTable, change: &DynamoChange) -> Vec<ItemResult> {
    let client = Client::new(cfg);
    match change {
        DynamoChange::PutItem { item, .. } => vec![put(&client, table, item).await],
        DynamoChange::UpdateItem { key, original, updated, guard_all } => vec![update(&client, table, key, original, updated, *guard_all).await],
        DynamoChange::MoveItem { original, updated } => vec![moved(&client, table, original, updated).await],
        DynamoChange::DeleteItems { items } => {
            let mut results = stream::iter(items.iter().cloned().enumerate().map(|(index, item)| {
                let client = &client;
                async move { (index, delete(client, table, &item).await) }
            })).buffer_unordered(8).collect::<Vec<_>>().await;
            results.sort_by_key(|(index, _)| *index);
            results.into_iter().map(|(_, result)| result).collect()
        },
        DynamoChange::RestoreItems { items } => {
            let mut results = stream::iter(items.iter().cloned().enumerate().map(|(index, item)| {
                let client = &client;
                async move { (index, put(client, table, &item).await) }
            })).buffer_unordered(8).collect::<Vec<_>>().await;
            results.sort_by_key(|(index, _)| *index);
            results.into_iter().map(|(_, result)| result).collect()
        },
        _ => unreachable!(),
    }
}

pub fn inverse(change: &DynamoChange, results: &[ItemResult], planned: Option<DynamoChange>) -> Option<DynamoChange> {
    let successful: Vec<_> = results.iter().filter(|result| result.ok)
        .map(|result| result.before_image.clone().unwrap_or_else(|| result.item.clone())).collect();
    match change {
        DynamoChange::DeleteItems { .. } if !successful.is_empty() => Some(DynamoChange::RestoreItems { items: successful }),
        DynamoChange::RestoreItems { .. } if !successful.is_empty() => Some(DynamoChange::DeleteItems { items: successful }),
        _ if !results.is_empty() && results.iter().all(|result| result.ok) => planned,
        _ => None,
    }
}

#[cfg(test)]
mod tests;
