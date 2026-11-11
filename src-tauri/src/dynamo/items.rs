use aws_sdk_dynamodb::{types::ReturnConsumedCapacity, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    dynamo::{attr, expr::{Condition, Expressions}},
    error::{from_sdk, AppError},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ReadRequest {
    Query {
        index: Option<String>,
        is_gsi: bool,
        key_schema: KeySchema,
        pk: Value,
        sk: Option<SortCondition>,
        #[serde(default)] filters: Vec<Condition>,
        #[serde(default)] projection: Vec<String>,
        forward: bool,
        consistent: bool,
        limit: Option<i32>,
        start_key: Option<Value>,
    },
    Scan {
        index: Option<String>,
        is_gsi: bool,
        #[serde(default)] filters: Vec<Condition>,
        #[serde(default)] projection: Vec<String>,
        consistent: bool,
        limit: Option<i32>,
        start_key: Option<Value>,
    },
    Partiql { statement: String, consistent: bool, next_token: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeySchema {
    pub pk: SchemaKey,
    pub sk: Option<SchemaKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaKey {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortCondition {
    pub op: String,
    pub values: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentRequest {
    pub api: String,
    pub params: Value,
    pub cli: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPage {
    pub items: Vec<Value>,
    pub last_key: Option<Value>,
    pub next_token: Option<String>,
    pub count: i32,
    pub scanned_count: i32,
    pub consumed: f64,
    pub request: SentRequest,
}

pub fn select_only(statement: &str) -> bool {
    let mut remaining = statement.trim_start();
    loop {
        if let Some(rest) = remaining.strip_prefix("--") {
            remaining = rest.split_once('\n').map_or("", |(_, rest)| rest).trim_start();
        } else if let Some(rest) = remaining.strip_prefix("/*") {
            let Some((_, rest)) = rest.split_once("*/") else { return false };
            remaining = rest.trim_start();
        } else {
            break;
        }
    }
    let word: String = remaining.chars().take_while(|character| character.is_ascii_alphabetic()).collect();
    word.eq_ignore_ascii_case("select") && remaining[word.len()..].chars().next()
        .is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
}

fn request(api: &str, mut params: Value) -> SentRequest {
    if let Some(map) = params.as_object_mut() {
        map.retain(|_, value| !value.is_null() && value.as_object().is_none_or(|object| !object.is_empty()));
        if api != "query" {
            map.remove("KeyConditionExpression");
            map.remove("ScanIndexForward");
        }
    }
    let cli = format!("aws dynamodb {} --cli-input-json '{}'", api, params.to_string().replace('\'', "'\\''"));
    SentRequest { api: api.into(), cli, params }
}

fn key_type(value: &Value, expected: &str) -> Result<(), AppError> {
    if value.as_object().is_some_and(|object| object.len() == 1 && object.contains_key(expected)) {
        attr::from_json(value)?;
        Ok(())
    } else {
        Err(AppError::other(format!("키 값은 {expected} 타입이어야 해요")))
    }
}

fn key_expression(expr: &mut Expressions, schema: &KeySchema, pk: &Value, sk: &Option<SortCondition>) -> Result<String, AppError> {
    key_type(pk, &schema.pk.kind)?;
    let partition = expr.condition(&Condition {
        attribute: schema.pk.name.clone(), op: "=".into(), values: vec![pk.clone()],
    })?;
    let Some(sort) = sk else { return Ok(partition) };
    let key = schema.sk.as_ref().ok_or_else(|| AppError::other("정렬 키가 없어요"))?;
    if !matches!(sort.op.as_str(), "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with") {
        return Err(AppError::other("정렬 키 연산이 올바르지 않아요"));
    }
    for value in &sort.values { key_type(value, &key.kind)?; }
    let sort_expr = expr.condition(&Condition {
        attribute: key.name.clone(), op: sort.op.clone(), values: sort.values.clone(),
    })?;
    Ok(format!("{partition} AND {sort_expr}"))
}

pub async fn read(cfg: &aws_config::SdkConfig, table: &str, req: ReadRequest) -> Result<ItemPage, AppError> {
    let client = Client::new(cfg);
    if let ReadRequest::Partiql { statement, consistent, next_token } = req {
        if !select_only(&statement) { return Err(AppError::other("PartiQL은 SELECT만 실행할 수 있어요")); }
        let params = json!({"Statement": statement, "ConsistentRead": consistent, "NextToken": next_token, "ReturnConsumedCapacity": "TOTAL"});
        let out = client.execute_statement().statement(statement).consistent_read(consistent)
            .set_next_token(next_token).return_consumed_capacity(ReturnConsumedCapacity::Total)
            .send().await.map_err(|error| from_sdk(error, "dynamodb:PartiQLSelect"))?;
        return Ok(ItemPage {
            items: out.items().iter().map(attr::item_to_json).collect::<Result<_, _>>()?,
            last_key: None, next_token: out.next_token().map(str::to_owned),
            count: out.items().len() as i32, scanned_count: out.items().len() as i32,
            consumed: out.consumed_capacity().and_then(|capacity| capacity.capacity_units()).unwrap_or(0.0),
            request: request("execute-statement", params),
        });
    }
    let (index, is_gsi, filters, projection, consistent, limit, start_key, query) = match req {
        ReadRequest::Query { index, is_gsi, key_schema, pk, sk, filters, projection, forward, consistent, limit, start_key } =>
            (index, is_gsi, filters, projection, consistent, limit, start_key, Some((key_schema, pk, sk, forward))),
        ReadRequest::Scan { index, is_gsi, filters, projection, consistent, limit, start_key } =>
            (index, is_gsi, filters, projection, consistent, limit, start_key, None),
        _ => unreachable!(),
    };
    if consistent && is_gsi {
        return Err(AppError::other("GSI는 강한 일관성을 지원하지 않아요"));
    }
    let mut expr = Expressions::default();
    let key_expr = query.as_ref().map(|(schema, pk, sk, _)| key_expression(&mut expr, schema, pk, sk)).transpose()?;
    let filter = if filters.is_empty() { None } else {
        Some(filters.iter().map(|condition| expr.condition(condition)).collect::<Result<Vec<_>, _>>()?.join(" AND "))
    };
    let projection_expr = expr.projection(&projection)?;
    let params = json!({
        "TableName": table, "IndexName": index, "KeyConditionExpression": key_expr,
        "FilterExpression": filter, "ProjectionExpression": projection_expr,
        "ExpressionAttributeNames": expr.names, "ExpressionAttributeValues": attr::item_to_json(&expr.values)?,
        "ConsistentRead": consistent, "Limit": limit, "ExclusiveStartKey": start_key,
        "ScanIndexForward": query.as_ref().map(|query| query.3), "ReturnConsumedCapacity": "TOTAL"
    });
    let names = if expr.names.is_empty() { None } else { Some(expr.names) };
    let values = if expr.values.is_empty() { None } else { Some(expr.values) };
    let start = start_key.as_ref().map(attr::item_from_json).transpose()?;
    if let Some((_, _, _, forward)) = query {
        let out = client.query().table_name(table).set_index_name(index)
            .set_key_condition_expression(key_expr).set_filter_expression(filter)
            .set_projection_expression(projection_expr).set_expression_attribute_names(names)
            .set_expression_attribute_values(values).consistent_read(consistent).set_limit(limit)
            .set_exclusive_start_key(start).scan_index_forward(forward)
            .return_consumed_capacity(ReturnConsumedCapacity::Total).send().await
            .map_err(|error| from_sdk(error, "dynamodb:Query"))?;
        Ok(ItemPage {
            items: out.items().iter().map(attr::item_to_json).collect::<Result<_, _>>()?,
            last_key: out.last_evaluated_key().filter(|key| !key.is_empty()).map(attr::item_to_json).transpose()?,
            next_token: None, count: out.count(), scanned_count: out.scanned_count(),
            consumed: out.consumed_capacity().and_then(|capacity| capacity.capacity_units()).unwrap_or(0.0),
            request: request("query", params),
        })
    } else {
        let out = client.scan().table_name(table).set_index_name(index).set_filter_expression(filter)
            .set_projection_expression(projection_expr).set_expression_attribute_names(names)
            .set_expression_attribute_values(values).consistent_read(consistent).set_limit(limit)
            .set_exclusive_start_key(start).return_consumed_capacity(ReturnConsumedCapacity::Total)
            .send().await.map_err(|error| from_sdk(error, "dynamodb:Scan"))?;
        Ok(ItemPage {
            items: out.items().iter().map(attr::item_to_json).collect::<Result<_, _>>()?,
            last_key: out.last_evaluated_key().filter(|key| !key.is_empty()).map(attr::item_to_json).transpose()?,
            next_token: None, count: out.count(), scanned_count: out.scanned_count(),
            consumed: out.consumed_capacity().and_then(|capacity| capacity.capacity_units()).unwrap_or(0.0),
            request: request("scan", params),
        })
    }
}

#[cfg(test)]
mod tests;
