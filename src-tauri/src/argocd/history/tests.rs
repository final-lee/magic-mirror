use serde_json::json;

use super::*;

fn app() -> Value {
    json!({"status": {"history": [
        {"id": 1, "revision": "aaa", "deployedAt": "2024-01-01T00:00:00Z", "source": {"repoURL": "https://git.test/r.git", "path": "k8s", "targetRevision": "main"}, "initiatedBy": {"username": "kim"}},
        {"id": 3, "revisions": ["bbb", "1.2.3", "oci-rev"], "sources": [
            {"repoURL": "https://git.test/r.git", "targetRevision": "main"},
            {"repoURL": "https://charts.test", "chart": "web", "targetRevision": "1.x"},
            {"repoURL": "oci://registry.test/app"}], "initiatedBy": {"automated": true}},
    ]}})
}

#[test]
fn entries_are_newest_first_with_per_source_details() {
    let entries = entries_of(&app());
    assert_eq!(entries.iter().map(|e| e.id).collect::<Vec<_>>(), [3, 1]);
    assert_eq!(entries[0].initiated_by.as_deref(), Some("automated"));
    assert_eq!(entries[1].initiated_by.as_deref(), Some("kim"));
    let kinds: Vec<_> = jobs_of(&entries).iter().map(|j| (j.version_id, j.source_index, j.kind)).collect();
    assert_eq!(kinds, [(3, 0, Kind::Commit), (3, 1, Kind::Chart), (3, 2, Kind::Oci), (1, 0, Kind::Commit)]);
    assert_eq!(entries[0].revisions[1].chart.as_deref(), Some("web"));
    assert_eq!(entries[1].revisions[0].path.as_deref(), Some("k8s"));
}

#[tokio::test]
async fn one_failed_metadata_call_leaves_only_that_revision_empty() {
    let mut entries = entries_of(&app());
    attach(&mut entries, |job| async move {
        match (job.version_id, job.kind) {
            (3, Kind::Commit) => Err(AppError::other("rpc error")),
            (_, Kind::Commit) => Ok(json!({"author": "kim <kim@test>", "date": "2024-01-01T00:00:00Z", "message": "fix", "tags": ["v1"]})),
            (_, Kind::Chart) => Ok(json!({"description": "web chart", "maintainers": ["a"]})),
            (_, Kind::Oci) => Ok(json!({"version": "9", "sourceUrl": "https://git.test/r"})),
        }
    })
    .await;
    assert!(entries[0].revisions[0].metadata.is_none());
    assert_eq!(entries[0].revisions[1].chart_details.as_ref().unwrap().description.as_deref(), Some("web chart"));
    assert_eq!(entries[0].revisions[2].oci.as_ref().unwrap().version.as_deref(), Some("9"));
    let meta = entries[1].revisions[0].metadata.as_ref().unwrap();
    assert_eq!(
        (meta.author.as_deref(), meta.message.as_deref(), meta.tags.as_slice()),
        (Some("kim <kim@test>"), Some("fix"), ["v1".to_owned()].as_slice())
    );
}
