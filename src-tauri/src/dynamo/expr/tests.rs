use super::*;
use serde_json::json;

fn condition(attribute: &str, op: &str, values: Vec<Value>) -> Condition {
    Condition { attribute: attribute.into(), op: op.into(), values }
}

#[test]
fn placeholders_remain_distinct_across_conditions_and_projection() {
    let mut expr = Expressions::default();
    assert_eq!(expr.condition(&condition("select", "between", vec![json!({"N":"1"}), json!({"N":"2"})])).unwrap(), "#n0 BETWEEN :v0 AND :v1");
    assert_eq!(expr.condition(&condition("select", "in", vec![json!({"S":"a"}), json!({"S":"b"}), json!({"S":"c"})])).unwrap(), "#n1 IN (:v2, :v3, :v4)");
    assert_eq!(expr.projection(&["select".into()]).unwrap().unwrap(), "#n2");
    assert_eq!(expr.names.values().filter(|name| *name == "select").count(), 3);
    assert_eq!(expr.values.len(), 5);
}

#[test]
fn rejects_wrong_number_of_operands() {
    let mut expr = Expressions::default();
    for values in [vec![], vec![json!({"N":"1"})], vec![json!({"N":"1"}); 3]] {
        assert!(expr.condition(&condition("n", "between", values)).is_err());
    }
    assert!(expr.condition(&condition("n", "in", vec![])).is_err());
    assert!(expr.condition(&condition("n", "in", vec![json!({"N":"1"}); 101])).is_err());
}
