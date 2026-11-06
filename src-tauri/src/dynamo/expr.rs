use std::collections::HashMap;

use aws_sdk_dynamodb::types::AttributeValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{dynamo::attr, error::AppError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub attribute: String,
    pub op: String,
    #[serde(default)]
    pub values: Vec<Value>,
}

#[derive(Default)]
pub struct Expressions {
    pub names: HashMap<String, String>,
    pub values: HashMap<String, AttributeValue>,
    next_name: usize,
    next_value: usize,
}

impl Expressions {
    pub fn name(&mut self, name: &str) -> Result<String, AppError> {
        if name.is_empty() {
            return Err(AppError::other("속성 이름을 입력해 주세요"));
        }
        let key = format!("#n{}", self.next_name);
        self.next_name += 1;
        self.names.insert(key.clone(), name.to_owned());
        Ok(key)
    }

    pub fn value(&mut self, value: &Value) -> Result<String, AppError> {
        let value = attr::from_json(value)?;
        let key = format!(":v{}", self.next_value);
        self.next_value += 1;
        self.values.insert(key.clone(), value);
        Ok(key)
    }

    pub fn condition(&mut self, condition: &Condition) -> Result<String, AppError> {
        let count = match condition.op.as_str() {
            "exists" | "not_exists" => 0,
            "between" => 2,
            "in" if !condition.values.is_empty() && condition.values.len() <= 100 => condition.values.len(),
            "=" | "<>" | "<" | "<=" | ">" | ">=" | "begins_with" | "contains" => 1,
            _ => return Err(AppError::other("지원하지 않는 조건이에요")),
        };
        if condition.values.len() != count {
            return Err(AppError::other("조건에 필요한 값의 개수가 맞지 않아요"));
        }
        let name = self.name(&condition.attribute)?;
        let values = condition.values.iter()
            .map(|value| self.value(value))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(match condition.op.as_str() {
            "exists" => format!("attribute_exists({name})"),
            "not_exists" => format!("attribute_not_exists({name})"),
            "between" => format!("{name} BETWEEN {} AND {}", values[0], values[1]),
            "in" => format!("{name} IN ({})", values.join(", ")),
            "begins_with" | "contains" => format!("{}({name}, {})", condition.op, values[0]),
            _ => format!("{name} {} {}", condition.op, values[0]),
        })
    }

    pub fn projection(&mut self, attrs: &[String]) -> Result<Option<String>, AppError> {
        if attrs.is_empty() {
            return Ok(None);
        }
        let names = attrs.iter().map(|name| self.name(name)).collect::<Result<Vec<_>, _>>()?;
        Ok(Some(names.join(", ")))
    }
}

#[cfg(test)]
mod tests;
