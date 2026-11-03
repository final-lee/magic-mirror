use super::*;

fn t(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

/// 실제 v4.1.6 응답 모양(이름은 바꿨다): cron이 만든 한 단계짜리 Workflow, retryStrategy로 Retry 노드 아래 Pod 하나
fn failed_workflow() -> Value {
    json!({
        "metadata": {
            "name": "nightly-report-1793615400", "namespace": "jobs", "uid": "u-1", "resourceVersion": "42",
            "creationTimestamp": "2026-11-02T10:30:00Z",
            "labels": { "workflows.argoproj.io/completed": "true", "workflows.argoproj.io/cron-workflow": "nightly-report", "workflows.argoproj.io/phase": "Failed" },
            "annotations": { "workflows.argoproj.io/pod-name-format": "v2" },
            "managedFields": [{ "manager": "workflow-controller", "operation": "Update" }]
        },
        "spec": {
            "templates": [{ "name": "job", "activeDeadlineSeconds": 1800, "container": { "image": "example/app:1" } }],
            "entrypoint": "job",
            "arguments": { "parameters": [{ "name": "scheduledFor", "value": "2026-11-02T10:30:00Z" }, { "name": "batch", "value": 50 }] },
            "serviceAccountName": "runner",
            "ttlStrategy": { "secondsAfterSuccess": 2592000 },
            "podGC": { "strategy": "OnPodSuccess" }
        },
        "status": {
            "phase": "Failed", "startedAt": "2026-11-02T10:30:00Z", "finishedAt": "2026-11-02T10:32:45Z", "progress": "0/1",
            "message": "retryStrategy.expression evaluated to false",
            "nodes": {
                "nightly-report-1793615400": {
                    "id": "nightly-report-1793615400", "name": "nightly-report-1793615400", "displayName": "nightly-report-1793615400",
                    "type": "Retry", "templateName": "job", "templateScope": "local/nightly-report-1793615400", "phase": "Failed",
                    "message": "retryStrategy.expression evaluated to false", "startedAt": "2026-11-02T10:30:00Z", "finishedAt": "2026-11-02T10:32:45Z",
                    "resourcesDuration": { "cpu": 3, "memory": 52 }, "outputs": { "exitCode": "2" },
                    "children": ["nightly-report-1793615400-3179159242"]
                },
                "nightly-report-1793615400-3179159242": {
                    "id": "nightly-report-1793615400-3179159242", "name": "nightly-report-1793615400(0)", "displayName": "nightly-report-1793615400(0)",
                    "type": "Pod", "templateName": "job", "phase": "Failed", "message": "main: Error (exit code 2)",
                    "startedAt": "2026-11-02T10:30:00Z", "finishedAt": "2026-11-02T10:31:30Z",
                    "resourcesDuration": { "cpu": 3, "memory": 52 }, "outputs": { "exitCode": "2" }
                }
            },
            "conditions": [{ "type": "PodRunning", "status": "False" }, { "type": "Completed", "status": "True" }],
            "resourcesDuration": { "cpu": 3, "memory": 52 }
        }
    })
}

#[test]
fn list_items_become_rows_with_their_origin_and_an_empty_list_is_fine() {
    let body = json!({ "metadata": {}, "items": [failed_workflow(), {
        "metadata": { "name": "etl-x", "namespace": "data", "labels": { "workflows.argoproj.io/cluster-workflow-template": "etl", "workflows.argoproj.io/creator-email": "dev.at.example.com" } },
        "spec": { "suspend": true },
        "status": { "phase": "Running", "progress": "2/5" }
    }] });
    let rows = wf_rows(&body, false);
    assert_eq!(rows[0].cron.as_deref(), Some("nightly-report"));
    assert_eq!(
        (rows[0].phase.as_str(), rows[0].progress.as_deref(), rows[0].template.as_deref()),
        ("Failed", Some("0/1"), None)
    );
    assert_eq!(
        (rows[1].template.as_deref(), rows[1].cluster_template, rows[1].suspended),
        (Some("etl"), true, true)
    );
    assert_eq!(rows[1].creator.as_deref(), Some("dev.at.example.com"));
    assert!(wf_rows(&json!({ "metadata": {}, "items": null }), true).is_empty());
}

#[test]
fn archive_rows_mixed_into_the_list_are_marked_and_live_copies_win() {
    let live = json!({ "metadata": { "name": "a", "namespace": "n", "uid": "u-a" }, "status": { "phase": "Succeeded" } });
    let persisted = |uid: &str| json!({ "metadata": { "name": "a", "namespace": "n", "uid": uid, "labels": { "workflows.argoproj.io/workflow-archiving-status": "Persisted" } }, "status": { "phase": "Succeeded" } });
    let rows = wf_rows(&json!({ "items": [live, persisted("u-a"), persisted("u-old")] }), false);
    assert_eq!(
        rows.iter().map(|r| (r.uid.as_str(), r.archived)).collect::<Vec<_>>(),
        [("u-a", false), ("u-old", true)]
    );
}

#[test]
fn detail_has_nodes_in_start_order_with_pod_names_and_the_spec_summary() {
    let d = wf_detail(&failed_workflow(), false).unwrap();
    assert_eq!(d.nodes.iter().map(|n| n.kind.as_str()).collect::<Vec<_>>(), ["Retry", "Pod"]);
    let pod = &d.nodes[1];
    assert_eq!(pod.pod_name.as_deref(), Some("nightly-report-1793615400-job-3179159242"));
    assert_eq!(
        (pod.exit_code.as_deref(), pod.message.as_deref()),
        (Some("2"), Some("main: Error (exit code 2)"))
    );
    assert_eq!(d.nodes[0].pod_name, None);
    assert_eq!(d.nodes[0].children, ["nightly-report-1793615400-3179159242"]);
    assert_eq!(
        d.parameters.iter().map(|p| (p.name.as_str(), p.value.as_deref())).collect::<Vec<_>>(),
        [("scheduledFor", Some("2026-11-02T10:30:00Z")), ("batch", Some("50"))]
    );
    assert_eq!(
        (d.service_account.as_deref(), d.pod_gc.as_deref(), d.ttl.as_deref()),
        (Some("runner"), Some("OnPodSuccess"), Some("secondsAfterSuccess=2592000"))
    );
    assert_eq!(d.conditions.len(), 2);
    assert_eq!(d.resources_duration.get("memory"), Some(&52));
    assert!(d.yaml.starts_with("apiVersion: argoproj.io/v1alpha1\nkind: Workflow\n"), "{}", d.yaml);
    assert!(!d.yaml.contains("managedFields"));
    assert_eq!(pod_names_of(&failed_workflow()), ["nightly-report-1793615400-job-3179159242"]);
}

#[test]
fn steps_and_dag_nodes_keep_children_and_template_refs_name_the_pod() {
    let wf = json!({
        "metadata": { "name": "pipe", "namespace": "data" },
        "status": { "phase": "Running", "nodes": {
            "pipe": { "id": "pipe", "name": "pipe", "type": "DAG", "phase": "Running", "startedAt": "2026-11-02T10:00:00Z", "children": ["pipe-1", "pipe-2"] },
            "pipe-2": { "id": "pipe-2", "name": "pipe.load", "displayName": "load", "type": "Pod", "phase": "Pending", "boundaryID": "pipe",
                        "templateRef": { "name": "shared", "template": "loader" } },
            "pipe-1": { "id": "pipe-1", "name": "pipe.extract", "displayName": "extract", "type": "Pod", "phase": "Running", "boundaryID": "pipe",
                        "templateName": "extract", "startedAt": "2026-11-02T10:00:05Z",
                        "inputs": { "parameters": [{ "name": "date", "value": "2026-11-02" }], "artifacts": [{ "name": "seed" }] },
                        "outputs": { "artifacts": [{ "name": "rows.parquet" }] } },
            "pipe-3": { "id": "pipe-3", "name": "pipe.wait", "displayName": "wait", "type": "Suspend", "phase": "Running", "startedAt": "2026-11-02T10:00:06Z" }
        } }
    });
    let d = wf_detail(&wf, false).unwrap();
    // 시작한 순서, 아직 시작하지 않은 노드는 뒤
    assert_eq!(
        d.nodes.iter().map(|n| n.display_name.as_str()).collect::<Vec<_>>(),
        ["pipe", "extract", "wait", "load"]
    );
    assert_eq!(d.nodes[1].pod_name.as_deref(), Some("pipe-extract-1"));
    assert_eq!(
        d.nodes[1].artifacts.iter().map(|a| (a.name.as_str(), a.direction)).collect::<Vec<_>>(),
        [("seed", "input"), ("rows.parquet", "output")]
    );
    assert_eq!(d.nodes[1].boundary_id.as_deref(), Some("pipe"));
    assert_eq!(d.nodes[3].template_name.as_deref(), Some("loader"));
    assert_eq!(d.nodes[3].pod_name.as_deref(), Some("pipe-loader-2"));
    assert_eq!(d.nodes[2].pod_name, None);
    assert!(d.row.suspended, "Suspend 노드에서 기다리면 spec.suspend가 없어도 정지된 것이다");
}

#[test]
fn pod_name_follows_argo_generate_pod_name() {
    assert_eq!(pod_name("wf", "wf.a", Some("t"), "wf-123", true), "wf-123", "v1 uses the node id");
    assert_eq!(pod_name("wf", "wf", Some("t"), "wf", false), "wf", "the root node of a single-pod workflow");
    assert_eq!(pod_name("wf", "wf.a", None, "wf-123", false), "wf-123");
    assert_eq!(pod_name("wf", "wf.a", Some(""), "wf-123", false), "wf-123");
    // node id가 워크플로 이름으로 시작하지 않으면 노드 이름의 fnv32a(Go hash/fnv New32a)
    assert_eq!(fnv32a(""), 2_166_136_261);
    assert_eq!(fnv32a("a"), 3_826_002_220);
    assert_eq!(pod_name("wf", "a", Some("t"), "other-1", false), "wf-t-3826002220");
    // 접두사는 253 - 10 - 1자로 자르고, 해시가 길면 접두사를 더 자른다
    let long = "w".repeat(300);
    let name = pod_name(&long, "n", Some("t"), &format!("{long}-1234567890123"), false);
    assert_eq!(name.len(), 253);
    assert!(name.ends_with("-1234567890123"));
}

#[test]
fn cron_rows_compute_next_runs_missed_and_spec_facts() {
    let body = json!({ "items": [
        {
            "metadata": { "name": "nightly-report", "namespace": "jobs", "creationTimestamp": "2026-10-01T00:00:00Z" },
            "spec": { "schedules": ["30 19 * * *"], "timezone": "Asia/Seoul", "concurrencyPolicy": "Forbid", "startingDeadlineSeconds": 300,
                      "workflowSpec": { "entrypoint": "job", "serviceAccountName": "runner", "templates": [{ "name": "job", "activeDeadlineSeconds": 1800 }] } },
            "status": { "active": [{ "name": "nightly-report-1" }], "lastScheduledTime": "2026-11-01T10:30:00Z", "succeeded": 3, "failed": 1 }
        },
        {
            "metadata": { "name": "weekly", "namespace": "jobs" },
            "spec": { "schedule": "0 9 * * 1", "suspend": true, "workflowSpec": { "workflowTemplateRef": { "name": "report", "clusterScope": true } } },
            "status": {}
        }
    ] });
    let rows = cron_rows(&body, t("2026-11-02T12:00:00Z"));
    let a = &rows[0];
    assert_eq!(a.next_runs.first().map(String::as_str), Some("2026-11-03T10:30:00+00:00"));
    assert_eq!(a.next_runs.len(), 5);
    assert!(a.missed, "11-02 10:30Z 실행이 없다");
    assert_eq!(
        (a.active.clone(), a.succeeded, a.failed),
        (vec!["nightly-report-1".to_string()], Some(3), Some(1))
    );
    assert_eq!(
        (a.service_account.as_deref(), a.has_deadline, a.template.as_deref()),
        (Some("runner"), true, None)
    );
    let b = &rows[1];
    assert_eq!(b.schedules, ["0 9 * * 1"]);
    assert!(b.next_runs.is_empty() && !b.missed, "정지된 Cron은 다음 실행도 놓침도 없다");
    assert_eq!((b.template.as_deref(), b.cluster_template, b.has_deadline), (Some("report"), true, true));
}

#[test]
fn templates_carry_parameters_and_scope() {
    let body = json!({ "items": [{
        "metadata": { "name": "etl", "namespace": "data", "annotations": { "workflows.argoproj.io/description": "적재" } },
        "spec": { "entrypoint": "main", "arguments": { "parameters": [
            { "name": "mode", "value": "full", "enum": ["full", "delta"], "description": "적재 방식" },
            { "name": "date" }
        ] }, "templates": [{ "name": "main" }, { "name": "load" }] }
    }] });
    let ns = template_rows(&body, TemplateKind::WorkflowTemplate);
    assert_eq!(ns[0].namespace.as_deref(), Some("data"));
    assert_eq!(ns[0].description.as_deref(), Some("적재"));
    assert_eq!(ns[0].parameters[0].choices, ["full", "delta"]);
    assert_eq!(
        (ns[0].parameters[1].value.clone(), ns[0].templates.clone(), ns[0].has_deadline),
        (None, vec!["main".to_string(), "load".to_string()], false)
    );
    let cluster = template_rows(&body, TemplateKind::ClusterWorkflowTemplate);
    assert_eq!(cluster[0].namespace, None);
    let detail = template_detail(&body["items"][0], TemplateKind::ClusterWorkflowTemplate).unwrap();
    assert!(detail.yaml.contains("kind: ClusterWorkflowTemplate"));
    assert_eq!(
        serde_json::to_value(TemplateKind::ClusterWorkflowTemplate).unwrap(),
        json!("ClusterWorkflowTemplate")
    );
}

#[test]
fn expanded_rows_and_details_include_artifacts_containers_origins_and_locks() {
    let wf = json!({
        "metadata": {
            "name": "demo", "namespace": "ns", "creationTimestamp": "2026-01-01T00:00:00Z",
            "labels": { "workflows.argoproj.io/cron-workflow": "nightly", "workflows.argoproj.io/resubmitted-from-workflow": "old", "workflows.argoproj.io/workflow-event-binding": "event" },
            "annotations": { "example.test/note": "hello" }
        },
        "spec": { "workflowTemplateRef": {"name": "shared", "clusterScope": true}, "templates": [{
            "name": "run", "container": {"image": "image:v1", "command": ["sh"], "args": ["-c", "echo ok"], "workingDir": "/work", "env": [{"name": "SECRET", "value": "private"}], "resources": {"requests": {"cpu": "100m"}, "limits": {"memory": "1Gi"}}, "volumeMounts": [{"name": "data", "mountPath": "/data"}]},
            "initContainers": [{"name": "setup", "image": "init"}], "sidecars": [{"name": "proxy", "image": "proxy"}]
        }] },
        "status": {
            "estimatedDuration": 120, "outputs": {"parameters": [{"name": "result", "value": 42}]},
            "synchronization": {"mutex": {"holding": [{"mutex": "ns/m", "holder": "demo"}], "waiting": [{"mutex": "ns/m", "holder": "other"}]}, "semaphore": {"waiting": [{"semaphore": "ns/s", "holders": ["a", "b"]}]}},
            "nodes": {"demo": {"id":"demo", "name":"demo", "type":"Pod", "templateName":"run", "hostNodeName":"worker", "estimatedDuration":12,
                "memoizationStatus":{"hit":true,"key":"cache-key","cacheName":"cache"},
                "inputs":{"artifacts":[{"name":"in", "s3":{"key":"input/file"}}]},
                "outputs":{"artifacts":[{"name":"out", "gcs":{"key":"output/file"}},{"name":"plain"}]}
            }}
        }
    });
    let detail = wf_detail(&wf, false).unwrap();
    assert_eq!(detail.row.created_at.as_deref(), Some("2026-01-01T00:00:00Z"));
    assert_eq!(detail.row.annotations.get("example.test/note").map(String::as_str), Some("hello"));
    assert_eq!(detail.row.estimated_duration, Some(120));
    assert_eq!(detail.outputs[0].value.as_deref(), Some("42"));
    assert_eq!(
        detail.created_from.iter().map(|o| (o.kind, o.name.as_str())).collect::<Vec<_>>(),
        [("cron", "nightly"), ("clusterTemplate", "shared"), ("resubmit", "old"), ("event", "event")]
    );
    assert_eq!((detail.synchronization[0].kind, detail.synchronization[0].key.as_str()), ("mutex", "ns/m"));
    assert_eq!(detail.synchronization[0].holding, ["demo"]);
    assert_eq!(detail.synchronization[0].waiting, ["other"]);
    assert_eq!(detail.synchronization[1].waiting, ["a", "b"]);
    let node = &detail.nodes[0];
    assert_eq!(node.host_node_name.as_deref(), Some("worker"));
    assert_eq!(node.estimated_duration, Some(12));
    assert_eq!(
        node.memoization.as_ref().map(|m| (m.hit, m.key.as_str(), m.cache_name.as_str())),
        Some((true, "cache-key", "cache"))
    );
    assert_eq!(
        node.artifacts
            .iter()
            .map(|a| (a.direction, a.repository.as_deref(), a.key.as_deref()))
            .collect::<Vec<_>>(),
        [
            ("input", Some("s3"), Some("input/file")),
            ("output", Some("gcs"), Some("output/file")),
            ("output", None, None)
        ]
    );
    assert_eq!(
        node.containers.iter().map(|c| (c.name.as_str(), c.role)).collect::<Vec<_>>(),
        [("setup", "init"), ("main", "main"), ("proxy", "sidecar")]
    );
    let main = &node.containers[1];
    assert_eq!(main.env, ["SECRET"]);
    assert_eq!(main.requests.get("cpu").map(String::as_str), Some("100m"));
    assert_eq!(main.limits.get("memory").map(String::as_str), Some("1Gi"));
    assert_eq!(main.volume_mounts, ["/data"]);
    assert!(!serde_json::to_string(&main).unwrap().contains("private"));
}

#[test]
fn external_stored_and_script_templates_resolve_without_confusing_local_names() {
    let wf = json!({
        "metadata": {"name":"demo"},
        "spec": {"templates":[{"name":"run","container":{"image":"wrong"}}]},
        "status": {"storedTemplates":{"cluster/shared/run":{"name":"run","script":{"image":"right","command":["python"]}}},
            "nodes":{"demo":{"id":"demo","name":"demo","type":"Pod","templateName":"run","templateRef":{"name":"shared","template":"run","clusterScope":true}}}}
    });
    let detail = wf_detail(&wf, false).unwrap();
    assert_eq!(detail.nodes[0].containers[0].image.as_deref(), Some("right"));
    assert_eq!(detail.nodes[0].containers[0].name, "main");
    assert!(detail.nodes[0].memoization.is_none());
}

#[test]
fn node_parameters_include_definitions_and_omit_absent_metadata() {
    let wf = json!({
        "metadata": {"name":"approval"},
        "spec": {"templates":[{"name":"gate","outputs":{"parameters":[
            {"name":"decision","valueFrom":{"supplied":{},"default":"yes"},"enum":["yes","no"],"description":"승인"},
            {"name":"note"}
        ]}}]},
        "status":{"nodes":{"approval":{"id":"approval","name":"approval","type":"Suspend","templateName":"gate",
            "outputs":{"parameters":[{"name":"decision","value":"no"}]}}}}
    });
    let detail = wf_detail(&wf, false).unwrap();
    let decision = &detail.nodes[0].outputs[0];
    assert_eq!(decision.value.as_deref(), Some("no"));
    assert_eq!(decision.default.as_deref(), Some("yes"));
    assert_eq!(decision.choices.as_deref(), Some(["yes".into(), "no".into()].as_slice()));
    assert_eq!(decision.description.as_deref(), Some("승인"));
    let note = serde_json::to_value(&detail.nodes[0].outputs[1]).unwrap();
    assert_eq!(note, json!({"name":"note","value":null}));
}
