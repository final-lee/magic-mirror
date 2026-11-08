use super::{DynamoChange, IndexCapacity};
use crate::dynamo::{BillingMode, DynamoTable, IndexKind};

pub(super) fn inverse(table: &DynamoTable, change: &DynamoChange) -> Option<DynamoChange> {
    match change {
        DynamoChange::Ttl { attribute, .. } => table.ttl.as_ref().and_then(|ttl| {
            if ttl.status == "ENABLING" || ttl.status == "DISABLING" {
                None
            } else {
                Some(DynamoChange::Ttl {
                    enabled: ttl.status == "ENABLED",
                    attribute: ttl.attribute.clone().unwrap_or_else(|| attribute.clone()),
                })
            }
        }),
        DynamoChange::Pitr { .. } => table.pitr.as_ref().map(|pitr| DynamoChange::Pitr {
            enabled: pitr.status == "ENABLED",
            days: pitr.days,
        }),
        DynamoChange::DeletionProtection { .. } => Some(DynamoChange::DeletionProtection {
            enabled: table.deletion_protection,
        }),
        DynamoChange::Stream { enabled: true, .. } if table.stream.is_none() => {
            Some(DynamoChange::Stream { enabled: false, view_type: None })
        }
        DynamoChange::TableClass { .. } => Some(DynamoChange::TableClass { class: table.class.clone() }),
        DynamoChange::Billing { .. } => Some(inverse_billing(table)),
        DynamoChange::ContributorInsights { .. } => table.contributor_insights.as_ref().map(|status| {
            DynamoChange::ContributorInsights { enabled: status == "ENABLED" }
        }),
        _ => None,
    }
}

fn inverse_billing(table: &DynamoTable) -> DynamoChange {
    let mode = if table.billing.mode == BillingMode::OnDemand { "onDemand" } else { "provisioned" };
    let indexes = table.indexes.iter()
        .filter(|index| index.kind == IndexKind::Gsi)
        .filter_map(|index| Some(IndexCapacity {
            name: index.name.clone(),
            read: index.read?,
            write: index.write?,
        }))
        .collect();
    DynamoChange::Billing {
        mode: mode.into(),
        read: table.billing.read,
        write: table.billing.write,
        indexes,
    }
}
