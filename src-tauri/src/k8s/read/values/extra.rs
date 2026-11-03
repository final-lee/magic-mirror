//! 추가 내장 리소스의 목록과 상세 요약.
use kube::core::DynamicObject;
use serde_json::Value;
use super::{annotation, condition, int, joined, list, text, Problem, Values};
use crate::k8s::read::quantity;


pub(super) fn builtin(group: &str, kind: &str, obj: &DynamicObject, v: &mut Values) -> bool {
    let d = &obj.data;
    let scalar = |path: &str| d.pointer(path).filter(|x| !x.is_null()).map(|x| {
        x.as_str().map(str::to_owned).unwrap_or_else(|| x.to_string())
    });
    match (group, kind) {
        ("autoscaling", "HorizontalPodAutoscaler") => {
            if let (Some(k), Some(n)) = (text(d, "/spec/scaleTargetRef/kind"), text(d, "/spec/scaleTargetRef/name")) {
                v.put("target", format!("{k}/{n}"));
            }
            v.put("min", int(d, "/spec/minReplicas").unwrap_or(1).to_string());
            for (key, path) in [("max", "/spec/maxReplicas"), ("current", "/status/currentReplicas"), ("desired", "/status/desiredReplicas")] {
                v.put_some(key, scalar(path).as_deref());
            }
            let metrics = scalar("/status/currentMetrics").or_else(|| scalar("/status/currentCPUUtilizationPercentage").map(|s| format!("CPU {s}%")));
            v.put_some("metrics", metrics.as_deref());
            if condition(d, "AbleToScale") == Some("False") || condition(d, "ScalingActive") == Some("False") { v.flag(Problem::ScalingBlocked); }
        }
        ("policy", "PodDisruptionBudget") => {
            for (key, path) in [("minAvailable", "/spec/minAvailable"), ("maxUnavailable", "/spec/maxUnavailable"), ("disruptionsAllowed", "/status/disruptionsAllowed")] {
                v.put_some(key, scalar(path).as_deref());
            }
            if let (Some(current), Some(expected)) = (int(d, "/status/currentHealthy"), int(d, "/status/expectedPods")) { v.put("healthy", format!("{current}/{expected}")); }
            if int(d, "/status/disruptionsAllowed") == Some(0) { v.flag(Problem::NoDisruptions); }
        }
        ("", "ResourceQuota") => {
            if let Some(hard) = d.pointer("/status/hard").and_then(Value::as_object) {
                let used = d.pointer("/status/used").and_then(Value::as_object);
                let summary = joined(hard.iter().map(|(name, limit)| {
                    let limit = limit.as_str().unwrap_or("");
                    let amount = used.and_then(|u| u.get(name)).and_then(Value::as_str).unwrap_or("?");
                    if let (Some(a), Some(b)) = (quantity::cpu_milli(amount), quantity::cpu_milli(limit)) { if a >= b { v.flag(Problem::QuotaExceeded); } }
                    format!("{name}: {amount}/{limit}")
                }));
                v.put_some("quota", summary.as_deref());
            }
        }
        ("", "LimitRange") => {
            let summary = joined(list(d, "/spec/limits").iter().map(|entry| {
                let ty = entry["type"].as_str().unwrap_or("?");
                format!("{ty}: {entry}")
            }));
            v.put_some("limits", summary.as_deref());
        }
        ("rbac.authorization.k8s.io", "Role" | "ClusterRole") => {
            v.put("ruleCount", list(d, "/rules").len().to_string());
            v.put_some("aggregation", scalar("/aggregationRule/clusterRoleSelectors").as_deref());
        }
        ("rbac.authorization.k8s.io", "RoleBinding" | "ClusterRoleBinding") => {
            if let (Some(k), Some(n)) = (text(d, "/roleRef/kind"), text(d, "/roleRef/name")) { v.put("roleRef", format!("{k}/{n}")); }
            let subjects = joined(list(d, "/subjects").iter().map(|s| {
                let prefix = s["kind"].as_str().unwrap_or("?");
                let name = s["name"].as_str().unwrap_or("?");
                match s["namespace"].as_str() { Some(ns) => format!("{prefix}/{ns}/{name}"), None => format!("{prefix}/{name}") }
            }));
            v.put_some("subjects", subjects.as_deref());
        }
        ("apiextensions.k8s.io", "CustomResourceDefinition") => {
            v.put_some("apiGroup", text(d, "/spec/group"));
            let versions = joined(list(d, "/spec/versions").iter().filter_map(|x| x["name"].as_str().map(str::to_owned))).or_else(|| text(d, "/spec/version").map(str::to_owned));
            v.put_some("versions", versions.as_deref());
            v.put_some("scope", text(d, "/spec/scope"));
            v.put_some("established", condition(d, "Established"));
            if condition(d, "Established") != Some("True") { v.flag(Problem::NotEstablished); }
        }
        ("admissionregistration.k8s.io", "MutatingWebhookConfiguration" | "ValidatingWebhookConfiguration") => {
            let hooks = list(d, "/webhooks");
            v.put("webhookCount", hooks.len().to_string());
            v.put_some("failurePolicy", joined(hooks.iter().map(|h| h["failurePolicy"].as_str().unwrap_or("Fail").to_string())).as_deref());
        }
        ("coordination.k8s.io", "Lease") => {
            v.put_some("holder", text(d, "/spec/holderIdentity"));
            v.put_some("renewTime", text(d, "/spec/renewTime"));
        }
        ("discovery.k8s.io", "EndpointSlice") => {
            v.put_some("addressType", text(d, "/addressType"));
            let endpoints = list(d, "/endpoints");
            let ready = endpoints.iter().filter(|e| e.pointer("/conditions/ready").and_then(Value::as_bool) != Some(false)).count();
            v.put("endpointReady", format!("{ready}/{}", endpoints.len()));
            v.put_some("ports", joined(list(d, "/ports").iter().map(|p| format!("{}/{}", p["port"].as_i64().map_or_else(|| "?".to_string(), |n| n.to_string()), p["protocol"].as_str().unwrap_or("TCP")))).as_deref());
        }
        ("networking.k8s.io", "IngressClass") => {
            v.put_some("controller", text(d, "/spec/controller"));
            if annotation(obj, "ingressclass.kubernetes.io/is-default-class") == Some("true") { v.put("default", "true"); }
        }
        ("scheduling.k8s.io", "PriorityClass") => {
            for (key, path) in [("value", "/value"), ("globalDefault", "/globalDefault"), ("preemption", "/preemptionPolicy")] { v.put_some(key, scalar(path).as_deref()); }
        }
        ("node.k8s.io", "RuntimeClass") => v.put_some("handler", text(d, "/handler")),
        _ => return false,
    }
    true
}
