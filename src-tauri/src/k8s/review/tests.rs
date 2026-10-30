use super::*;

#[test]
fn rules_of_maps_status() {
    let status: SubjectRulesReviewStatus = serde_json::from_value(serde_json::json!({
        "resourceRules": [{ "verbs": ["get","list"], "apiGroups": [""], "resources": ["pods","pods/log"] },
                          { "verbs": ["*"], "apiGroups": ["apps"], "resources": ["deployments"], "resourceNames": ["web"] }],
        "nonResourceRules": [{ "verbs": ["get"], "nonResourceURLs": ["/healthz"] }],
        "incomplete": true
    }))
    .unwrap();
    let r = rules_of(&status, "ops");
    assert_eq!(r.namespace, "ops");
    assert!(r.incomplete);
    assert_eq!(r.resource_rules[0].api_groups, [""]);
    assert!(r.resource_rules[0].resource_names.is_empty());
    assert_eq!(r.resource_rules[1].resource_names, ["web"]);
    assert_eq!(r.non_resource_rules[0].non_resource_urls, ["/healthz"]);
}

#[test]
fn rules_json_keys_match_the_ts_contract() {
    let status: SubjectRulesReviewStatus = serde_json::from_value(serde_json::json!({
        "resourceRules": [{ "verbs": ["get"], "apiGroups": [""], "resources": ["pods"] }],
        "nonResourceRules": [{ "verbs": ["get"], "nonResourceURLs": ["/healthz"] }],
        "incomplete": false
    }))
    .unwrap();
    let v = serde_json::to_value(rules_of(&status, "ops")).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "namespace": "ops",
            "resourceRules": [{ "verbs": ["get"], "apiGroups": [""], "resources": ["pods"], "resourceNames": [] }],
            "nonResourceRules": [{ "verbs": ["get"], "nonResourceUrls": ["/healthz"] }],
            "incomplete": false
        })
    );
}

#[test]
fn identity_of_reads_user_info_and_arn_extra() {
    let status: SelfSubjectReviewStatus = serde_json::from_value(serde_json::json!({
        "userInfo": { "username": "arn:aws:sts::1:assumed-role/Dev/jane", "groups": ["system:authenticated", "dev"],
                      "extra": { "arn": ["arn:aws:sts::1:assumed-role/Dev/jane"] } }
    }))
    .unwrap();
    let id = identity_of(&status);
    assert_eq!(id.username, "arn:aws:sts::1:assumed-role/Dev/jane");
    assert_eq!(id.groups, ["system:authenticated", "dev"]);
    assert_eq!(id.arn.as_deref(), Some("arn:aws:sts::1:assumed-role/Dev/jane"));
    assert_eq!(id.source, IdentitySource::SelfSubjectReview);
}

#[test]
fn identity_json_keys_match_the_ts_contract() {
    let id = fallback("admin-user");
    assert_eq!(serde_json::to_value(id).unwrap(), serde_json::json!({ "username": "admin-user", "groups": [], "arn": null, "source": "kubeconfig" }));
    let status: SelfSubjectReviewStatus = serde_json::from_value(serde_json::json!({ "userInfo": { "username": "u" } })).unwrap();
    let v = serde_json::to_value(identity_of(&status)).unwrap();
    assert_eq!(v["source"], "selfSubjectReview");
    assert_eq!(v["arn"], serde_json::Value::Null);
}
