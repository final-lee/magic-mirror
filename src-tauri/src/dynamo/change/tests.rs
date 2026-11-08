use super::*;
use crate::dynamo::StreamSpec;

#[test]
fn confirmation_depends_on_name_backup_and_consumers() {
    let change = DynamoChange::DeletionProtection { enabled: false };
    for name in ["production", "my-PROD-table", "PrD-orders"] {
        let table = DynamoTable::fixture(name);
        assert_eq!(preview(&table, &change, false).confirm_name.as_deref(), Some(name));
    }
    let table = DynamoTable::fixture("development");
    assert!(preview(&table, &change, false).confirm_name.is_none());
    let backup = DynamoChange::DeleteBackup { arn: "arn".into() };
    assert!(preview(&table, &backup, false).confirm_name.is_some());
    let stream = DynamoChange::Stream { enabled: false, view_type: None };
    assert!(preview(&table, &stream, true).confirm_name.is_some());
    assert!(preview(&table, &stream, false).confirm_name.is_none());
}

#[test]
fn setting_inverses_restore_original_values() {
    let table = DynamoTable::fixture("test").provisioned(10, 20).with_gsi("gsi", Some((3, 4)));
    let cases = [
        (DynamoChange::Ttl { enabled: true, attribute: "expires".into() },
         DynamoChange::Ttl { enabled: false, attribute: "expires".into() }),
        (DynamoChange::Pitr { enabled: false, days: None },
         DynamoChange::Pitr { enabled: true, days: Some(35) }),
        (DynamoChange::DeletionProtection { enabled: false },
         DynamoChange::DeletionProtection { enabled: true }),
        (DynamoChange::Stream { enabled: true, view_type: Some("KEYS_ONLY".into()) },
         DynamoChange::Stream { enabled: false, view_type: None }),
        (DynamoChange::TableClass { class: "STANDARD_INFREQUENT_ACCESS".into() },
         DynamoChange::TableClass { class: "STANDARD".into() }),
        (DynamoChange::Billing { mode: "onDemand".into(), read: None, write: None, indexes: vec![] },
         DynamoChange::Billing { mode: "provisioned".into(), read: Some(10), write: Some(20),
             indexes: vec![IndexCapacity { name: "gsi".into(), read: 3, write: 4 }] }),
        (DynamoChange::ContributorInsights { enabled: true },
         DynamoChange::ContributorInsights { enabled: false }),
    ];
    for (change, inverse) in cases {
        assert_eq!(preview(&table, &change, false).inverse, Some(inverse));
    }
}

#[test]
fn irreversible_operations_and_stream_disable_have_no_inverse() {
    let mut table = DynamoTable::fixture("test");
    table.stream = Some(StreamSpec { arn: "arn".into(), view_type: "KEYS_ONLY".into() });
    let changes = [
        DynamoChange::Stream { enabled: false, view_type: None },
        DynamoChange::DeleteBackup { arn: "arn".into() },
        DynamoChange::RestoreBackup { arn: "arn".into(), target: "new".into() },
        DynamoChange::RestorePitr { time: None, target: "new".into() },
        DynamoChange::ExportS3 { bucket: "bucket".into(), prefix: "".into(), format: "ION".into(), time: None },
    ];
    for change in changes {
        assert!(preview(&table, &change, false).inverse.is_none());
    }
}

#[test]
fn transitions_and_recovery_period_boundaries_are_checked() {
    let mut table = DynamoTable::fixture("test");
    for days in [0, 36] {
        assert!(preview(&table, &DynamoChange::Pitr { enabled: true, days: Some(days) }, false).blocked.is_some());
    }
    for days in [1, 35] {
        assert!(preview(&table, &DynamoChange::Pitr { enabled: true, days: Some(days) }, false).blocked.is_none());
    }
    let ttl = DynamoChange::Ttl { enabled: true, attribute: "expires".into() };
    assert!(!preview(&table, &ttl, false).warnings.is_empty());
    for status in ["ENABLING", "DISABLING"] {
        table.ttl.as_mut().unwrap().status = status.into();
        assert!(preview(&table, &ttl, false).blocked.is_some());
    }
    table.stream = Some(StreamSpec { arn: "arn".into(), view_type: "KEYS_ONLY".into() });
    let disable = DynamoChange::Stream { enabled: false, view_type: None };
    assert!(!preview(&table, &disable, false).warnings.is_empty());
    let change_view = DynamoChange::Stream { enabled: true, view_type: Some("NEW_IMAGE".into()) };
    assert!(preview(&table, &change_view, false).blocked.is_some());
}

#[test]
fn export_requires_known_enabled_pitr() {
    let mut table = DynamoTable::fixture("test");
    let export = DynamoChange::ExportS3 {
        bucket: "bucket".into(),
        prefix: "".into(),
        format: "ION".into(),
        time: None,
    };
    assert!(preview(&table, &export, false).blocked.is_none());
    table.pitr.as_mut().unwrap().status = "DISABLED".into();
    assert!(preview(&table, &export, false).blocked.is_some());
    table.pitr = None;
    assert!(preview(&table, &export, false).blocked.is_some());
}
