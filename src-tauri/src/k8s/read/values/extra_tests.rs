use serde_json::{json, Value};
use super::{values_of, Problem};
use crate::k8s::rows::KindRef;
use kube::core::DynamicObject;

fn extract(group: &str, kind: &str, mut data: Value) -> super::Values {
    data["apiVersion"] = json!("v1");
    data["kind"] = json!(kind);
    data["metadata"]["name"] = json!("test");
    let obj: DynamicObject = serde_json::from_value(data).unwrap();
    values_of(&KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: "items".into(), namespaced: true }, &obj)
}

#[test]
fn autoscaling_budget_and_quota_report_problems() {
    let hpa = extract("autoscaling", "HorizontalPodAutoscaler", json!({"spec":{"scaleTargetRef":{"kind":"Deployment","name":"web"},"maxReplicas":5},"status":{"currentReplicas":2,"desiredReplicas":3,"conditions":[{"type":"AbleToScale","status":"False"}]}}));
    assert_eq!(hpa.values["target"], "Deployment/web");
    assert_eq!(hpa.values["min"], "1");
    assert!(hpa.problems.contains(&Problem::ScalingBlocked));
    let pdb = extract("policy", "PodDisruptionBudget", json!({"spec":{"minAvailable":"50%"},"status":{"disruptionsAllowed":0,"currentHealthy":2,"expectedPods":3}}));
    assert_eq!(pdb.values["healthy"], "2/3");
    assert!(pdb.problems.contains(&Problem::NoDisruptions));
    let quota = extract("", "ResourceQuota", json!({"status":{"hard":{"requests.cpu":"1"},"used":{"requests.cpu":"1000m"}}}));
    assert_eq!(quota.values["quota"], "requests.cpu: 1000m/1");
    assert!(quota.problems.contains(&Problem::QuotaExceeded));
}

#[test]
fn access_and_configuration_summaries() {
    let limits = extract("", "LimitRange", json!({"spec":{"limits":[{"type":"Container","max":{"cpu":"1"}}]}}));
    assert!(limits.values["limits"].contains("Container"));
    for kind in ["Role", "ClusterRole"] {
        let role = extract("rbac.authorization.k8s.io", kind, json!({"rules":[{}],"aggregationRule":{"clusterRoleSelectors":[{}]}}));
        assert_eq!(role.values["ruleCount"], "1");
        assert!(role.values.contains_key("aggregation"));
    }
    for kind in ["RoleBinding", "ClusterRoleBinding"] {
        let binding = extract("rbac.authorization.k8s.io", kind, json!({"roleRef":{"kind":"ClusterRole","name":"view"},"subjects":[{"kind":"ServiceAccount","namespace":"team","name":"app"}]}));
        assert_eq!(binding.values["roleRef"], "ClusterRole/view");
        assert_eq!(binding.values["subjects"], "ServiceAccount/team/app");
    }
}

#[test]
fn cluster_and_network_summaries() {
    let crd = extract("apiextensions.k8s.io", "CustomResourceDefinition", json!({"spec":{"group":"example.org","scope":"Namespaced","versions":[{"name":"v1"}]},"status":{"conditions":[{"type":"Established","status":"False"}]}}));
    assert_eq!(crd.values["versions"], "v1");
    assert!(crd.problems.contains(&Problem::NotEstablished));
    for kind in ["MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"] {
        let hooks = extract("admissionregistration.k8s.io", kind, json!({"webhooks":[{}, {"failurePolicy":"Ignore"}]}));
        assert_eq!(hooks.values["failurePolicy"], "Fail,Ignore");
    }
    let lease = extract("coordination.k8s.io", "Lease", json!({"spec":{"holderIdentity":"node-a","renewTime":"2026-01-01T00:00:00Z"}}));
    assert_eq!(lease.values["holder"], "node-a");
    let slice = extract("discovery.k8s.io", "EndpointSlice", json!({"addressType":"IPv4","endpoints":[{}, {"conditions":{"ready":false}}],"ports":[{"port":80}]}));
    assert_eq!(slice.values["endpointReady"], "1/2");
    assert_eq!(slice.values["ports"], "80/TCP");
    let ingress = extract("networking.k8s.io", "IngressClass", json!({"metadata":{"annotations":{"ingressclass.kubernetes.io/is-default-class":"true"}},"spec":{"controller":"example/controller"}}));
    assert_eq!(ingress.values["default"], "true");
    let priority = extract("scheduling.k8s.io", "PriorityClass", json!({"value":100,"globalDefault":false,"preemptionPolicy":"Never"}));
    assert_eq!(priority.values["preemption"], "Never");
    let runtime = extract("node.k8s.io", "RuntimeClass", json!({"handler":"runc"}));
    assert_eq!(runtime.values["handler"], "runc");
}
