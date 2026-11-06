use std::collections::HashMap;
use aws_sdk_dynamodb::types::AttributeValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::{dynamo::attr, error::AppError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition { pub attribute: String, pub op: String, #[serde(default)] pub values: Vec<Value> }

#[derive(Default)]
pub struct Expressions { pub names: HashMap<String, String>, pub values: HashMap<String, AttributeValue>, next_name: usize, next_value: usize }
impl Expressions {
    pub fn name(&mut self, name: &str) -> Result<String, AppError> {
        if name.is_empty() { return Err(AppError::other("속성 이름을 입력해 주세요")); }
        let key = format!("#n{}", self.next_name); self.next_name += 1; self.names.insert(key.clone(), name.to_owned()); Ok(key)
    }
    pub fn value(&mut self, value: &Value) -> Result<String, AppError> {
        let value = attr::from_json(value)?; let key = format!(":v{}", self.next_value); self.next_value += 1; self.values.insert(key.clone(), value); Ok(key)
    }
    pub fn condition(&mut self, c: &Condition) -> Result<String, AppError> {
        let count = match c.op.as_str() { "exists" | "not_exists" => 0, "between" => 2, "in" if !c.values.is_empty() && c.values.len() <= 100 => c.values.len(), "=" | "<>" | "<" | "<=" | ">" | ">=" | "begins_with" | "contains" => 1, _ => return Err(AppError::other("지원하지 않는 조건이에요")) };
        if c.values.len() != count { return Err(AppError::other("조건에 필요한 값의 개수가 맞지 않아요")); }
        let n = self.name(&c.attribute)?;
        let v = c.values.iter().map(|v| self.value(v)).collect::<Result<Vec<_>, _>>()?;
        Ok(match c.op.as_str() { "exists" => format!("attribute_exists({n})"), "not_exists" => format!("attribute_not_exists({n})"), "between" => format!("{n} BETWEEN {} AND {}", v[0], v[1]), "in" => format!("{n} IN ({})", v.join(", ")), "begins_with" | "contains" => format!("{}({n}, {})", c.op, v[0]), _ => format!("{n} {} {}", c.op, v[0]) })
    }
    pub fn projection(&mut self, attrs: &[String]) -> Result<Option<String>, AppError> { if attrs.is_empty() { return Ok(None); } Ok(Some(attrs.iter().map(|s| self.name(s)).collect::<Result<Vec<_>, _>>()?.join(", "))) }
}

#[cfg(test)] mod tests {
 use super::*; use serde_json::json;
 #[test] fn placeholders_and_conditions() { let mut e=Expressions::default(); let c=Condition{attribute:"select".into(),op:"between".into(),values:vec![json!({"N":"1"}),json!({"N":"2"})]}; assert_eq!(e.condition(&c).unwrap(),"#n0 BETWEEN :v0 AND :v1"); assert_eq!(e.condition(&Condition{attribute:"select".into(),op:"in".into(),values:vec![json!({"S":"a"}),json!({"S":"b"})]}).unwrap(),"#n1 IN (:v2, :v3)"); assert!(e.condition(&Condition{values:vec![],..c}).is_err()); }
}
