use super::*;
use crate::dynamo::DynamoTable;

#[test]
fn apply_confirmation_uses_the_current_preview() {
    let table = DynamoTable::fixture("Prod-orders");
    let change = DynamoChange::DeletionProtection { enabled: false };
    let preview = change::preview(&table, &change, false);
    assert!(check_confirmation(&preview, None).is_err());
    assert!(check_confirmation(&preview, Some("prod-orders")).is_err());
    assert!(check_confirmation(&preview, Some("Prod-orders")).is_ok());

    let blocked = change::preview(
        &table,
        &DynamoChange::Pitr { enabled: true, days: Some(0) },
        false,
    );
    assert!(check_confirmation(&blocked, Some("Prod-orders")).is_err());
}

#[test]
fn log_omits_preview_parameters_and_marks_only_successful_undo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let table = DynamoTable::fixture("test");
    let change = DynamoChange::CreateBackup { name: "private-value".into() };
    let preview = change::preview(&table, &change, false);
    let inverse = DynamoChange::DeleteBackup { arn: "backup-arn".into() };
    let original = log_entry(
        "profile".into(), "region".into(), table.name.clone(), &change,
        preview, &Ok(Some(inverse.clone())), None,
    );
    assert_eq!(original.inverse, Some(inverse.clone()));
    append_change(&path, &original).unwrap();
    let serialized = std::fs::read_to_string(&path).unwrap();
    assert!(!serialized.contains("private-value"));
    assert!(serialized.contains("CreateBackup"));

    let failed = log_entry(
        "profile".into(), "region".into(), table.name.clone(), &inverse,
        change::preview(&table, &inverse, false),
        &Err(AppError::other("failed")), Some(original.id.clone()),
    );
    append_change(&path, &failed).unwrap();
    assert!(!jsonl::read_all::<ChangeLogEntry>(&path)[0].undone);

    let undo = log_entry(
        "profile".into(), "region".into(), table.name.clone(), &inverse,
        change::preview(&table, &inverse, false), &Ok(None), Some(original.id.clone()),
    );
    append_change(&path, &undo).unwrap();
    let rows = jsonl::read_all::<ChangeLogEntry>(&path);
    assert!(rows[0].undone);
    assert_eq!(rows[2].undo_of.as_deref(), Some(original.id.as_str()));
}
