//! AttributeValue ↔ DynamoDB JSON(`{"S": ".."}`, `{"N": "1.50"}`, `{"B": "<base64>"}`, `SS`·`NS`·`BS`·`M`·`L`·`NULL`·`BOOL`).
//! 아이템은 백엔드와 화면 사이를 이 모양으로 오간다. 숫자(N)는 문자열 그대로 둬서 정밀도를 잃지 않고, 바이너리(B)는 base64다.

use std::collections::HashMap;

use aws_sdk_dynamodb::primitives::Blob;
use aws_sdk_dynamodb::types::AttributeValue;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{Map, Value};

use crate::error::AppError;

type Item = HashMap<String, AttributeValue>;

fn bad(what: impl std::fmt::Display) -> AppError {
    AppError::other(format!("DynamoDB JSON을 읽지 못했어요: {what}"))
}

pub fn to_json(value: &AttributeValue) -> Result<Value, AppError> {
    let (tag, inner) = match value {
        AttributeValue::S(s) => ("S", Value::String(s.clone())),
        AttributeValue::N(n) => ("N", Value::String(n.clone())),
        AttributeValue::B(b) => ("B", Value::String(STANDARD.encode(b.as_ref()))),
        AttributeValue::Ss(v) => ("SS", Value::Array(v.iter().cloned().map(Value::String).collect())),
        AttributeValue::Ns(v) => ("NS", Value::Array(v.iter().cloned().map(Value::String).collect())),
        AttributeValue::Bs(v) => ("BS", Value::Array(v.iter().map(|b| Value::String(STANDARD.encode(b.as_ref()))).collect())),
        AttributeValue::M(m) => ("M", item_to_json(m)?),
        AttributeValue::L(l) => ("L", Value::Array(l.iter().map(to_json).collect::<Result<_, _>>()?)),
        AttributeValue::Null(n) => ("NULL", Value::Bool(*n)),
        AttributeValue::Bool(b) => ("BOOL", Value::Bool(*b)),
        _ => return Err(AppError::other("알 수 없는 DynamoDB 값 타입이에요")),
    };
    let mut out = Map::with_capacity(1);
    out.insert(tag.to_string(), inner);
    Ok(Value::Object(out))
}

pub fn item_to_json(item: &Item) -> Result<Value, AppError> {
    let mut out = Map::with_capacity(item.len());
    for (name, value) in item {
        out.insert(name.clone(), to_json(value)?);
    }
    Ok(Value::Object(out))
}

fn strings(tag: &str, value: &Value) -> Result<Vec<String>, AppError> {
    value
        .as_array()
        .ok_or_else(|| bad(format!("{tag}는 문자열 배열이어야 해요")))?
        .iter()
        .map(|v| v.as_str().map(str::to_string).ok_or_else(|| bad(format!("{tag}의 값은 문자열이어야 해요"))))
        .collect()
}

fn blob(tag: &str, text: &str) -> Result<Blob, AppError> {
    STANDARD.decode(text).map(Blob::new).map_err(|_| bad(format!("{tag}가 올바른 base64가 아니에요")))
}

/// DynamoDB가 받는 숫자 모양인가(10진수, 지수 허용). 값은 바꾸지 않고 검사만 한다
fn number(tag: &str, text: &str) -> Result<(), AppError> {
    let ok = text.parse::<f64>().is_ok_and(f64::is_finite) && !text.trim().is_empty() && text == text.trim();
    if ok {
        Ok(())
    } else {
        Err(bad(format!("{tag}의 `{text}`는 숫자가 아니에요")))
    }
}

pub fn from_json(value: &Value) -> Result<AttributeValue, AppError> {
    let object = value.as_object().ok_or_else(|| bad("값은 {\"S\": ..}처럼 타입 이름 하나를 가진 객체여야 해요"))?;
    if object.len() != 1 {
        return Err(bad(format!("타입 이름은 하나여야 해요(지금 {}개)", object.len())));
    }
    let (tag, inner) = object.iter().next().expect("len == 1");
    match tag.as_str() {
        "S" => inner.as_str().map(|s| AttributeValue::S(s.to_string())).ok_or_else(|| bad("S는 문자열이어야 해요")),
        "N" => {
            let text = inner.as_str().ok_or_else(|| bad("N은 숫자를 담은 문자열이어야 해요"))?;
            number("N", text)?;
            Ok(AttributeValue::N(text.to_string()))
        }
        "B" => blob("B", inner.as_str().ok_or_else(|| bad("B는 base64 문자열이어야 해요"))?).map(AttributeValue::B),
        "SS" => strings("SS", inner).map(AttributeValue::Ss),
        "NS" => {
            let numbers = strings("NS", inner)?;
            numbers.iter().try_for_each(|n| number("NS", n))?;
            Ok(AttributeValue::Ns(numbers))
        }
        "BS" => strings("BS", inner)?.iter().map(|s| blob("BS", s)).collect::<Result<_, _>>().map(AttributeValue::Bs),
        "M" => item_from_json(inner).map(AttributeValue::M),
        "L" => inner
            .as_array()
            .ok_or_else(|| bad("L은 배열이어야 해요"))?
            .iter()
            .map(from_json)
            .collect::<Result<_, _>>()
            .map(AttributeValue::L),
        "NULL" => match inner {
            Value::Bool(true) => Ok(AttributeValue::Null(true)),
            _ => Err(bad("NULL의 값은 true여야 해요")),
        },
        "BOOL" => inner.as_bool().map(AttributeValue::Bool).ok_or_else(|| bad("BOOL은 true 또는 false여야 해요")),
        other => Err(bad(format!("알 수 없는 타입 `{other}`이에요"))),
    }
}

pub fn item_from_json(value: &Value) -> Result<Item, AppError> {
    let object = value.as_object().ok_or_else(|| bad("아이템은 속성 이름을 키로 가진 객체여야 해요"))?;
    object.iter().map(|(name, v)| from_json(v).map(|a| (name.clone(), a))).collect()
}

#[cfg(test)]
mod tests;
