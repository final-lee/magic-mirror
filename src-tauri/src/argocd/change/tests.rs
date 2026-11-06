use super::*;
fn target() -> ArgoTarget {
    ArgoTarget {
        namespace: "argocd".into(),
        name: "web".into(),
        project: "default".into(),
        env: None,
    }
}
fn parse(v: Value) -> ArgoChange {
    serde_json::from_value(v).unwrap()
}
#[test]
fn constructs_calls_for_all_changes() {
    let app = json!({"metadata":{"resourceVersion":"7"},"spec":{"syncPolicy":{"automated":{"selfHeal":true}}}});
    let res = json!({"group":"apps","version":"v1","kind":"Deployment","namespace":"demo","name":"web","uid":null});
    let cases=vec![
        (json!({"kind":"refresh","hard":true}),"GET","/api/v1/applications/web?appNamespace=argocd&refresh=hard"),
        (json!({"kind":"sync","prune":true,"dryRun":false,"applyOnly":true,"force":true,"serverSideApply":true,"replace":true,"pruneLast":true,"createNamespace":true,"applyOutOfSyncOnly":true,"respectIgnoreDifferences":true}),"POST","/api/v1/applications/web/sync"),
        (json!({"kind":"terminate"}),"DELETE","/api/v1/applications/web/operation?appNamespace=argocd"),
        (json!({"kind":"resourceAction","res":res,"action":"restart","params":[]}),"POST","/api/v1/applications/web/resource/actions/v2"),
        (json!({"kind":"resourceDelete","res":res,"force":false,"orphan":true}),"DELETE","/api/v1/applications/web/resource?namespace=demo&resourceName=web&version=v1&group=apps&kind=Deployment&appNamespace=argocd&project=default&force=false&orphan=true"),
        (json!({"kind":"resourcePatch","res":res,"patch":"{}","patchType":"merge"}),"POST","/api/v1/applications/web/resource?namespace=demo&resourceName=web&version=v1&group=apps&kind=Deployment&appNamespace=argocd&project=default&patchType=application%2Fmerge-patch%2Bjson"),
        (json!({"kind":"appSpec","yaml":"project: default"}),"PUT","/api/v1/applications/web/spec?appNamespace=argocd"),
        (json!({"kind":"appPatch","patch":{"spec":{"project":"new"}}}),"PATCH","/api/v1/applications/web"),
        (json!({"kind":"appDelete","cascade":true,"propagationPolicy":"foreground"}),"DELETE","/api/v1/applications/web?appNamespace=argocd&cascade=true&propagationPolicy=foreground"),
        (json!({"kind":"appCreate","yaml":"metadata:\n  name: web\n  namespace: argocd","upsert":false}),"POST","/api/v1/applications?upsert=false&validate=true"),
        (json!({"kind":"appSetUpsert","yaml":"metadata:\n  name: web\n  namespace: argocd"}),"POST","/api/v1/applicationsets?upsert=true"),
        (json!({"kind":"appSetDelete","name":"web","namespace":"argocd"}),"DELETE","/api/v1/applicationsets/web?appsetNamespace=argocd"),
    ];
    for (value, verb, path) in cases {
        let p = plan(&target(), &parse(value), Some(&app), None).unwrap();
        assert_eq!(p.calls[0].verb, verb);
        assert_eq!(p.calls[0].path, path);
    }
    let p = plan(
        &target(),
        &parse(json!({"kind":"rollback","id":4,"prune":false,"dryRun":false,"disableAutoSync":true})),
        Some(&app),
        None,
    )
    .unwrap();
    assert_eq!(p.calls.len(), 2);
    assert_eq!(p.calls[0].verb, "PATCH");
    assert_eq!(p.calls[1].body.as_ref().unwrap()["id"], 4);
}
#[test]
fn rules_apply_together_and_block_rollback_with_auto_sync() {
    let app = json!({"metadata":{"resourceVersion":"8","ownerReferences":[{"kind":"ApplicationSet"}],"annotations":{"argocd.argoproj.io/tracking-id":"parent:app"}},"spec":{"syncPolicy":{"automated":{"selfHeal":true}}}});
    let p = plan(
        &target(),
        &parse(json!({"kind":"rollback","id":1,"prune":true,"dryRun":false,"disableAutoSync":false})),
        Some(&app),
        Some(&json!({"canSync":false})),
    )
    .unwrap();
    assert!(p.blocked.is_some());
    assert_eq!(p.confirm_name.as_deref(), Some("web"));
    assert_eq!(p.expected_version, Some(fingerprint(&app)));
    assert_eq!(p.warnings.len(), 2);
    let mut prod = target();
    prod.env = Some("prd".into());
    assert_eq!(plan(&prod, &ArgoChange::Terminate, Some(&app), None).unwrap().confirm_name.as_deref(), Some("web"));
}

#[test]
fn stale_check_ignores_status_only_updates() {
    let app = json!({"metadata":{"resourceVersion":"8","annotations":{"team":"a"}},"spec":{"project":"default"},"status":{"health":{"status":"Progressing"}}});
    let mut status_only = app.clone();
    status_only["metadata"]["resourceVersion"] = json!("9");
    status_only["status"]["health"]["status"] = json!("Healthy");
    status_only["metadata"]["annotations"]["argocd.argoproj.io/refresh"] = json!("normal");
    assert_eq!(fingerprint(&app), fingerprint(&status_only));
    let mut edited = app.clone();
    edited["spec"]["project"] = json!("other");
    assert_ne!(fingerprint(&app), fingerprint(&edited));
    let mut annotated = app.clone();
    annotated["metadata"]["annotations"]["team"] = json!("b");
    assert_ne!(fingerprint(&app), fingerprint(&annotated));
}

#[test]
fn sync_and_patch_bodies_preserve_server_contracts() {
    let app = json!({"metadata":{"resourceVersion":"1"},"spec":{"project":"default"}});
    let resource = json!({"group":"apps","version":"v1","kind":"Deployment","namespace":"demo","name":"web","uid":"u"});
    let c = parse(
        json!({"kind":"sync","revision":"abc","resources":[resource],"prune":true,"dryRun":false,"applyOnly":false,"force":true,"serverSideApply":true,"replace":true,"pruneLast":true,"createNamespace":true,"applyOutOfSyncOnly":true,"respectIgnoreDifferences":true,"retry":{"limit":2,"backoff":{"duration":"5s"}}}),
    );
    let p = plan(&target(), &c, Some(&app), None).unwrap();
    let body = p.calls[0].body.as_ref().unwrap();
    assert_eq!(body["strategy"], json!({"hook":{"syncStrategyApply":{"force":true}}}));
    assert_eq!(body["revision"], "abc");
    assert_eq!(body["resources"], json!([{"group":"apps","kind":"Deployment","namespace":"demo","name":"web"}]));
    assert_eq!(
        body["syncOptions"]["items"],
        json!([
            "ServerSideApply=true",
            "Replace=true",
            "PruneLast=true",
            "CreateNamespace=true",
            "ApplyOutOfSyncOnly=true",
            "RespectIgnoreDifferences=true"
        ])
    );
    assert_eq!(body["retryStrategy"], json!({"limit":2,"backoff":{"duration":"5s"}}));
    let patch = parse(json!({"kind":"appPatch","patch":{"spec":{"project":"new"}}}));
    let p = plan(&target(), &patch, Some(&app), None).unwrap();
    assert_eq!(p.calls[0].body.as_ref().unwrap()["patchType"], "merge");
    assert_eq!(
        serde_json::from_str::<Value>(p.calls[0].body.as_ref().unwrap()["patch"].as_str().unwrap()).unwrap(),
        json!({"spec":{"project":"new"}})
    );
    assert!(p.diff.is_some());
}

#[test]
fn resource_patch_sends_the_media_type_the_server_hands_to_kubernetes() {
    let app = json!({"metadata":{"resourceVersion":"1"}});
    let res = json!({"group":"apps","version":"v1","kind":"Deployment","namespace":"demo","name":"web","uid":null});
    let path = |kind: &str| {
        plan(
            &target(),
            &parse(json!({"kind":"resourcePatch","res":res,"patch":"{\"spec\":{\"replicas\":2}}","patchType":kind})),
            Some(&app),
            None,
        )
        .map(|p| p.calls[0].path.clone())
    };
    assert!(path("strategic").unwrap().ends_with("patchType=application%2Fstrategic-merge-patch%2Bjson"));
    assert!(path("json").unwrap().ends_with("patchType=application%2Fjson-patch%2Bjson"));
    assert!(path("application/merge-patch+json").is_err());
    let bad = plan(
        &target(),
        &parse(json!({"kind":"resourcePatch","res":res,"patch":"{nope","patchType":"merge"})),
        Some(&app),
        None,
    );
    assert!(bad.is_err());
    let p = plan(
        &target(),
        &parse(json!({"kind":"resourcePatch","res":res,"patch":"{\"a\":1}","patchType":"merge"})),
        Some(&app),
        None,
    )
    .unwrap();
    assert_eq!(p.calls[0].body, Some(json!("{\"a\":1}")));
}

#[test]
fn resource_delete_explains_force_and_orphan() {
    let app = json!({"metadata":{"resourceVersion":"1"}});
    let res = json!({"group":"","version":"v1","kind":"Pod","namespace":"demo","name":"web-0","uid":null});
    let plain = plan(&target(), &parse(json!({"kind":"resourceDelete","res":res,"force":false,"orphan":false})), Some(&app), None).unwrap();
    assert_eq!(plain.impact.len(), 1);
    let both = plan(&target(), &parse(json!({"kind":"resourceDelete","res":res,"force":true,"orphan":true})), Some(&app), None).unwrap();
    assert_eq!(both.impact.len(), 3);
    assert!(both.calls[0].path.ends_with("force=true&orphan=true"));
    assert_eq!(both.confirm_name.as_deref(), Some("web"));
}

#[test]
fn audit_records_never_include_request_secrets() {
    let calls = vec![call("POST", &["api", "v1", "applications"], vec![], Some(json!({"password":"private-value"})))];
    let text = serde_json::to_string(&audit_calls(&calls)).unwrap();
    assert!(!text.contains("private-value"));
    assert!(text.contains("[REDACTED]"));
    assert_eq!(calls[0].body.as_ref().unwrap()["password"], "private-value");
}

#[test]
fn namespace_is_required_for_updates_and_filled_for_creation() {
    let existing = json!({"metadata":{"resourceVersion":"1"}});
    for ns in ["", "  namespace: other\n", "  namespace: 42\n"] {
        let yaml = format!("metadata:\n  name: web\n{ns}");
        let change = ArgoChange::AppSetUpsert { yaml };
        assert!(plan(&target(), &change, Some(&existing), None).is_err());
    }
    for kind in ["appCreate", "appSetUpsert"] {
        let change = parse(json!({"kind":kind,"yaml":"metadata:\n  name: web","upsert":false}));
        let p = plan(&target(), &change, None, None).unwrap();
        assert_eq!(p.calls[0].body.as_ref().unwrap()["metadata"]["namespace"], "argocd");
    }
}

#[test]
fn parent_instance_label_warns() {
    let app = json!({"metadata":{"resourceVersion":"1","labels":{"argocd.argoproj.io/instance":"parent"}}});
    assert!(!plan(&target(), &ArgoChange::Terminate, Some(&app), None).unwrap().warnings.is_empty());
}

fn res_ref(kind: &str, name: &str) -> Value {
    json!({"group":"apps","version":"v1","kind":kind,"namespace":"demo","name":name,"uid":null})
}

#[test]
fn batch_action_makes_one_call_per_resource_and_summarises_by_kind() {
    let app = json!({"metadata":{"resourceVersion":"1"}});
    let change = parse(json!({"kind":"resourceActionBatch","action":"restart","params":[{"name":"x","value":"1"}],"resources":[res_ref("Deployment","a"),res_ref("Deployment","b"),res_ref("StatefulSet","c")]}));
    let p = plan(&target(), &change, Some(&app), None).unwrap();
    assert_eq!(p.calls.len(), 3);
    assert!(p.calls.iter().all(|c| c.verb == "POST" && c.path == "/api/v1/applications/web/resource/actions/v2"));
    let body = p.calls[1].body.as_ref().unwrap();
    assert_eq!((body["resourceName"].as_str(), body["action"].as_str(), body["kind"].as_str()), (Some("b"), Some("restart"), Some("Deployment")));
    assert_eq!(body["resourceActionParameters"], json!([{"name":"x","value":"1"}]));
    assert_eq!(p.impact, ["Deployment 2개를 재시작해요", "StatefulSet 1개를 재시작해요"]);
    assert_eq!(p.title, "리소스 작업");
}

#[test]
fn batch_action_uses_the_usual_confirmation_rule_and_refuses_an_empty_list() {
    let app = json!({"metadata":{"resourceVersion":"1"}});
    let change = parse(json!({"kind":"resourceActionBatch","action":"custom","params":[],"resources":[res_ref("Deployment","a")]}));
    let mut prd = target();
    prd.env = Some("prd".into());
    let p = plan(&prd, &change, Some(&app), None).unwrap();
    assert_eq!(p.confirm_name.as_deref(), Some("web"));
    assert_eq!(p.impact, ["Deployment 1개에 custom 액션을 실행해요"]);
    assert!(plan(&target(), &change, Some(&app), None).unwrap().confirm_name.is_none());
    let empty = parse(json!({"kind":"resourceActionBatch","action":"restart","params":[],"resources":[]}));
    assert!(plan(&target(), &empty, Some(&app), None).is_err());
}

#[tokio::test]
async fn batch_keeps_going_after_a_failure_and_names_the_failed_resources() {
    let app = json!({"metadata":{"resourceVersion":"1"}});
    let change = parse(json!({"kind":"resourceActionBatch","action":"restart","params":[],"resources":[res_ref("Deployment","a"),res_ref("Deployment","bad"),res_ref("Deployment","c"),res_ref("Deployment","bad2")]}));
    let calls = plan(&target(), &change, Some(&app), None).unwrap().calls;
    let sent = std::sync::Mutex::new(Vec::new());
    let send = |c: ApiCall| {
        let name = c.body.as_ref().unwrap()["resourceName"].as_str().unwrap().to_owned();
        sent.lock().unwrap().push(name.clone());
        async move { if name.starts_with("bad") { Err(AppError::other("no")) } else { Ok(()) } }
    };
    let error = run_calls(&calls, true, send).await.unwrap_err().to_string();
    assert_eq!(sent.lock().unwrap().len(), 4);
    assert!(error.contains("4개 중 2개") && error.contains("bad, bad2"), "{error}");
    // 일괄이 아닌 변경은 첫 실패에서 멈춘다
    sent.lock().unwrap().clear();
    let send = |c: ApiCall| {
        let name = c.body.as_ref().unwrap()["resourceName"].as_str().unwrap().to_owned();
        sent.lock().unwrap().push(name.clone());
        async move { if name == "bad" { Err(AppError::other("no")) } else { Ok(()) } }
    };
    assert!(run_calls(&calls, false, send).await.is_err());
    assert_eq!(sent.lock().unwrap().len(), 2);
}
