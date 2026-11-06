use aws_sdk_dynamodb::{Client, types::ReturnConsumedCapacity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use crate::{dynamo::{attr, expr::{Condition, Expressions}, read::parse_table}, error::{AppError, from_sdk}};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag="kind", rename_all="camelCase", rename_all_fields="camelCase")]
pub enum ReadRequest {
 Query { index: Option<String>, pk: Value, sk: Option<SortCondition>, #[serde(default)] filters: Vec<Condition>, #[serde(default)] projection: Vec<String>, forward: bool, consistent: bool, limit: Option<i32>, start_key: Option<Value> },
 Scan { index: Option<String>, #[serde(default)] filters: Vec<Condition>, #[serde(default)] projection: Vec<String>, consistent: bool, limit: Option<i32>, start_key: Option<Value> },
 Partiql { statement: String, consistent: bool, next_token: Option<String> },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortCondition { pub op: String, pub values: Vec<Value> }
#[derive(Serialize)] #[serde(rename_all="camelCase")]
pub struct SentRequest { pub api: String, pub params: Value, pub cli: String }
#[derive(Serialize)] #[serde(rename_all="camelCase")]
pub struct ItemPage { pub items: Vec<Value>, pub last_key: Option<Value>, pub next_token: Option<String>, pub count: i32, pub scanned_count: i32, pub consumed: f64, pub request: SentRequest }

pub fn select_only(statement: &str) -> bool {
 let mut s = statement.trim_start();
 loop { if let Some(rest)=s.strip_prefix("--") { s=rest.split_once('\n').map_or("", |(_,r)|r).trim_start(); } else if let Some(rest)=s.strip_prefix("/*") { if let Some((_,r))=rest.split_once("*/") { s=r.trim_start(); } else { return false; } } else { break; } }
 let word: String=s.chars().take_while(|c| c.is_ascii_alphabetic()).collect(); word.eq_ignore_ascii_case("select") && s[word.len()..].chars().next().is_none_or(|c| !c.is_ascii_alphanumeric() && c!='_')
}
fn cli(api: &str, params: &Value) -> String { format!("aws dynamodb {} --cli-input-json '{}'", api, params.to_string().replace('\'', "'\\''")) }
fn request(api: &str, mut params: Value) -> SentRequest { if let Some(map)=params.as_object_mut() { map.retain(|_,v| !v.is_null() && v.as_object().is_none_or(|o| !o.is_empty())); if api != "query" { map.remove("KeyConditionExpression"); map.remove("ScanIndexForward"); } } SentRequest { api: api.into(), cli: cli(api, &params), params } }
fn values_json(e: &Expressions) -> Result<Value, AppError> { attr::item_to_json(&e.values) }
fn key_type(v: &Value, expected: &str) -> Result<(), AppError> { if v.as_object().is_some_and(|o| o.len()==1 && o.contains_key(expected)) { attr::from_json(v)?; Ok(()) } else { Err(AppError::other(format!("키 값은 {expected} 타입이어야 해요"))) } }

pub async fn read(cfg: &aws_config::SdkConfig, table: &str, req: ReadRequest) -> Result<ItemPage, AppError> {
 let client=Client::new(cfg);
 if let ReadRequest::Partiql { statement, consistent, next_token } = req {
  if !select_only(&statement) { return Err(AppError::other("PartiQL은 SELECT만 실행할 수 있어요")); }
  let params=json!({"Statement":statement,"ConsistentRead":consistent,"NextToken":next_token,"ReturnConsumedCapacity":"TOTAL"});
  let out=client.execute_statement().statement(statement).consistent_read(consistent).set_next_token(next_token).return_consumed_capacity(ReturnConsumedCapacity::Total).send().await.map_err(|e|from_sdk(e,"dynamodb:PartiQLSelect"))?;
  return Ok(ItemPage { items: out.items().iter().map(attr::item_to_json).collect::<Result<_,_>>()?, last_key: None, next_token: out.next_token().map(str::to_owned), count: out.items().len() as i32, scanned_count: out.items().len() as i32, consumed: out.consumed_capacity().and_then(|c|c.capacity_units()).unwrap_or(0.0), request: request("execute-statement",params) });
 }
 let desc=client.describe_table().table_name(table).send().await.map_err(|e|from_sdk(e,"dynamodb:DescribeTable"))?;
 let schema=parse_table(desc.table().ok_or_else(||AppError::other("테이블 설명이 없어요"))?);
 let (index, filters, projection, consistent, limit, start_key, query)=match req {
  ReadRequest::Query {index,pk,sk,filters,projection,forward,consistent,limit,start_key} => (index,filters,projection,consistent,limit,start_key,Some((pk,sk,forward))),
  ReadRequest::Scan {index,filters,projection,consistent,limit,start_key} => (index,filters,projection,consistent,limit,start_key,None), _=>unreachable!() };
 let idx=index.as_ref().map(|n| schema.indexes.iter().find(|i| &i.name==n).ok_or_else(||AppError::other("인덱스를 찾지 못했어요"))).transpose()?;
 if consistent && idx.is_some_and(|i| matches!(i.kind, crate::dynamo::IndexKind::Gsi)) { return Err(AppError::other("GSI는 강한 일관성을 지원하지 않아요")); }
 let pk=idx.map(|i|&i.pk).unwrap_or(&schema.keys.pk); let sk=idx.and_then(|i|i.sk.as_ref()).or_else(|| if idx.is_none(){schema.keys.sk.as_ref()}else{None});
 let mut e=Expressions::default();
 let key_expr=if let Some((value,sort,_))=&query { key_type(value,&pk.kind)?; let p=e.condition(&Condition{attribute:pk.name.clone(),op:"=".into(),values:vec![value.clone()]})?; if let Some(s)=sort { let k=sk.ok_or_else(||AppError::other("정렬 키가 없어요"))?; if !matches!(s.op.as_str(),"="|"<"|"<="|">"|">="|"between"|"begins_with") {return Err(AppError::other("정렬 키 연산이 올바르지 않아요"));} for v in &s.values { key_type(v,&k.kind)?; } Some(format!("{p} AND {}",e.condition(&Condition{attribute:k.name.clone(),op:s.op.clone(),values:s.values.clone()})?)) } else {Some(p)} } else {None};
 let filter=if filters.is_empty(){None}else{Some(filters.iter().map(|c|e.condition(c)).collect::<Result<Vec<_>,_>>()?.join(" AND "))}; let projection_expr=e.projection(&projection)?;
 let params=json!({"TableName":table,"IndexName":index,"KeyConditionExpression":key_expr,"FilterExpression":filter,"ProjectionExpression":projection_expr,"ExpressionAttributeNames":e.names,"ExpressionAttributeValues":values_json(&e)?,"ConsistentRead":consistent,"Limit":limit,"ExclusiveStartKey":start_key,"ScanIndexForward":query.as_ref().map(|q|q.2),"ReturnConsumedCapacity":"TOTAL"});
 let names=if e.names.is_empty(){None}else{Some(e.names)}; let values=if e.values.is_empty(){None}else{Some(e.values)}; let start=start_key.as_ref().map(attr::item_from_json).transpose()?;
 if let Some((_,_,forward))=query {
  let out=client.query().table_name(table).set_index_name(index).set_key_condition_expression(key_expr).set_filter_expression(filter).set_projection_expression(projection_expr).set_expression_attribute_names(names).set_expression_attribute_values(values).consistent_read(consistent).set_limit(limit).set_exclusive_start_key(start).scan_index_forward(forward).return_consumed_capacity(ReturnConsumedCapacity::Total).send().await.map_err(|e|from_sdk(e,"dynamodb:Query"))?;
  Ok(ItemPage{items:out.items().iter().map(attr::item_to_json).collect::<Result<_,_>>()?,last_key:out.last_evaluated_key().filter(|k|!k.is_empty()).map(attr::item_to_json).transpose()?,next_token:None,count:out.count(),scanned_count:out.scanned_count(),consumed:out.consumed_capacity().and_then(|c|c.capacity_units()).unwrap_or(0.0),request:request("query",params)})
 } else {
  let out=client.scan().table_name(table).set_index_name(index).set_filter_expression(filter).set_projection_expression(projection_expr).set_expression_attribute_names(names).set_expression_attribute_values(values).consistent_read(consistent).set_limit(limit).set_exclusive_start_key(start).return_consumed_capacity(ReturnConsumedCapacity::Total).send().await.map_err(|e|from_sdk(e,"dynamodb:Scan"))?;
  Ok(ItemPage{items:out.items().iter().map(attr::item_to_json).collect::<Result<_,_>>()?,last_key:out.last_evaluated_key().filter(|k|!k.is_empty()).map(attr::item_to_json).transpose()?,next_token:None,count:out.count(),scanned_count:out.scanned_count(),consumed:out.consumed_capacity().and_then(|c|c.capacity_units()).unwrap_or(0.0),request:request("scan",params)})
 }
}
#[cfg(test)] mod tests { use super::*; #[test] fn only_select() { assert!(select_only(" /* x */ -- hi\n SELECT * FROM t")); assert!(!select_only("-- hi\n UPDATE t")); assert!(!select_only("selection")); assert!(!select_only("/* unterminated")); } #[test] fn key_type_must_match_schema() { assert!(key_type(&json!({"N":"1.50"}),"N").is_ok()); assert!(key_type(&json!({"S":"1.50"}),"N").is_err()); assert!(key_type(&json!({"N":1}),"N").is_err()); } }
