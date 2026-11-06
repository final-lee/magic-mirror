use super::*;

#[test]
fn partiql_accepts_only_select_after_comments_and_whitespace() {
    for statement in [" SELECT * FROM t", "\n/* comment */ -- line\n sElEcT * FROM t", "select"] {
        assert!(select_only(statement));
    }
    for statement in ["-- comment\nUPDATE t", "DELETE FROM t", "selection", "select_foo", "select1", "/* unfinished", "-- comment"] {
        assert!(!select_only(statement));
    }
}

#[test]
fn key_condition_rejects_wrong_or_malformed_types() {
    let schema = KeySchema {
        pk: SchemaKey { name: "pk".into(), kind: "N".into() },
        sk: Some(SchemaKey { name: "sk".into(), kind: "S".into() }),
    };
    assert!(key_expression(&mut Expressions::default(), &schema, &json!({"N":"1.50"}), &None).is_ok());
    assert!(key_expression(&mut Expressions::default(), &schema, &json!({"S":"1.50"}), &None).is_err());
    assert!(key_expression(&mut Expressions::default(), &schema, &json!({"N":1}), &None).is_err());
    let sort = Some(SortCondition { op: "=".into(), values: vec![json!({"N":"2"})] });
    assert!(key_expression(&mut Expressions::default(), &schema, &json!({"N":"1"}), &sort).is_err());
}
