//! 접근 화면(K4)의 실효 권한 계산을 실제 kind 클러스터와 맞춰 본다. 픽스처는 `scripts/k8s-live/access.sh`가 만든다
//! (Role·ClusterRole(aggregation 포함)·바인딩·aws-auth). 계산 결과를 `SubjectAccessReview`와 `kubectl auth can-i --as`에 동작마다 대조한다.
use std::collections::BTreeMap;
use std::process::Command;

use super::*;
use crate::k8s::access::engine::{evaluate, Evaluation, Query, Via};
use crate::k8s::access::identity::{parse_aws_auth, principals, resolve, AuthMode};
use crate::k8s::access::matrix::{cell_detail, CELLS};
use crate::k8s::access::rbac::Subject;
use crate::k8s::access::read::{read_aws_auth, read_namespaces, read_rbac};
use crate::k8s::access::review::{review, review_non_resource};

const A: &str = "mm-acc-a";
const B: &str = "mm-acc-b";
const OPS: &str = "arn:aws:iam::111122223333:role/mm-ops";
const BOSS: &str = "arn:aws:iam::111122223333:role/mm-boss";

async fn engine(client: &kube::Client) -> Evaluation {
    let rbac = read_rbac(client, PRIVATE).await.expect("rbac");
    let auth = read_aws_auth(client, PRIVATE).await.expect("aws-auth").expect("픽스처의 aws-auth");
    let mappings = resolve(AuthMode::ConfigMap, &[], Some(&auth));
    evaluate(rbac, principals(&mappings))
}

fn subjects() -> Vec<Subject> {
    vec![
        Subject::user("mm-acc-alice"),
        Subject::user("mm-acc-bob"),
        Subject::user("mm-acc-carol"),
        Subject::user("mm-acc-dave"),
        Subject::group("mm-acc-devs"),
        Subject::group("kubeadm:cluster-admins"),
        Subject::group("system:authenticated"),
        Subject::group("system:unauthenticated"),
        Subject::user("system:anonymous"),
        Subject::user("system:kube-scheduler"),
        Subject::service_account(A, "robot"),
        Subject::service_account(B, "worker"),
        Subject::service_account(A, "plain"),
        Subject::iam(OPS),
        Subject::iam(BOSS),
    ]
}

fn queries() -> Vec<Query> {
    let mut out = Vec::new();
    for ns in [None, Some(A), Some(B)] {
        let at = |q: Query| match ns {
            Some(n) => q.ns(n),
            None => q,
        };
        for verb in ["get", "list", "create", "delete"] {
            out.push(at(Query::new(verb, "", "pods")));
            out.push(at(Query::new(verb, "", "secrets")));
            out.push(at(Query::new(verb, "apps", "deployments")));
            out.push(at(Query::new(verb, "mm.example.com", "widgets")));
        }
        out.push(at(Query::new("create", "", "pods").subres("exec")));
        out.push(at(Query::new("get", "", "pods").subres("log")));
        out.push(at(Query::new("get", "", "pods").subres("status")));
        out.push(at(Query::new("get", "", "configmaps").named("cm1")));
        out.push(at(Query::new("get", "", "configmaps").named("cm2")));
        out.push(at(Query::new("get", "", "configmaps")));
        out.push(at(Query::new("list", "", "configmaps")));
        out.push(at(Query::new("create", "rbac.authorization.k8s.io", "rolebindings")));
        out.push(at(Query::new("bind", "rbac.authorization.k8s.io", "clusterroles")));
        out.push(at(Query::new("escalate", "rbac.authorization.k8s.io", "roles")));
        out.push(at(Query::new("impersonate", "", "users")));
        out.push(at(Query::new("create", "", "serviceaccounts").subres("token")));
        out.push(at(Query::new("get", "", "nodes").subres("proxy")));
    }
    out
}

fn describe(s: &Subject, q: &Query) -> String {
    format!("{} {} {}{}{} in {:?} name {:?}", s.key(), q.verb, q.resource, if q.subresource.is_some() { "/" } else { "" }, q.subresource.clone().unwrap_or_default(), q.namespace, q.name)
}

/// IAM 주체는 세션 이름에 따라 달라지는 바인딩(`mm-acc-ops:jane`)을 뺀 계산과 맞춘다: SAR에는 아무 바인딩에도 없는 세션 이름을 쓴다.
fn engine_allows(e: &Evaluation, s: &Subject, q: &Query) -> bool {
    e.can(s, q).grants.iter().any(|g| !g.source.session_dependent)
}

fn sar_identity(e: &Evaluation, s: &Subject) -> (Option<String>, Vec<String>) {
    let (user, groups) = e.identity_of(s);
    let user = user.map(|u| u.replacen("{{SessionName}}", "nobody", usize::MAX));
    // 그룹 주체는 사용자 없이 그룹만 보낸다(SAR은 둘 중 하나가 있으면 된다)
    (user, groups)
}

#[tokio::test]
#[ignore]
async fn the_engine_agrees_with_subject_access_review_on_every_request() {
    let client = admin().await;
    let e = engine(&client).await;
    let mut mismatches = Vec::new();
    let mut checked = 0;
    for s in subjects() {
        let (user, groups) = sar_identity(&e, &s);
        for q in queries() {
            let sar = review(&client, user.as_deref(), &groups, &q, PRIVATE).await.expect("SAR").allowed;
            let mine = engine_allows(&e, &s, &q);
            checked += 1;
            if sar != mine {
                mismatches.push(format!("{}: 클러스터 {sar}, 계산 {mine}", describe(&s, &q)));
            }
        }
    }
    assert!(checked > 2000, "{checked}");
    assert!(mismatches.is_empty(), "{} / {checked}건이 달라요:\n{}", mismatches.len(), mismatches.join("\n"));
}

#[tokio::test]
#[ignore]
async fn non_resource_urls_agree_with_the_cluster() {
    let client = admin().await;
    let e = engine(&client).await;
    for s in subjects() {
        for path in ["/healthz", "/healthz/ping", "/version", "/metrics", "/api", "/apis/apps/v1"] {
            let (user, groups) = sar_identity(&e, &s);
            let sar = review_non_resource(&client, user.as_deref(), &groups, "get", path, PRIVATE).await.expect("SAR").allowed;
            let mine = e.can_non_resource(&s, "get", path).grants.iter().any(|g| !g.source.session_dependent);
            assert_eq!(sar, mine, "{} get {path}", s.key());
        }
    }
}

#[tokio::test]
#[ignore]
async fn matrix_probes_agree_with_the_cluster() {
    let client = admin().await;
    let e = engine(&client).await;
    for s in subjects() {
        let (user, groups) = sar_identity(&e, &s);
        let grants_only = |q: &Query| e.can(&s, q).grants.iter().any(|g| !g.source.session_dependent);
        for ns in [None, Some(A), Some(B)] {
            for cell in CELLS {
                let detail = cell_detail(&e, &s, cell, ns);
                for probe in &detail.probes {
                    let sar = review(&client, user.as_deref(), &groups, &probe.query, PRIVATE).await.expect("SAR").allowed;
                    // 세션 이름 템플릿에 기대는 권한은 제외하고 비교한다
                    let mine = grants_only(&probe.query);
                    assert_eq!(sar, mine, "{} {:?} {:?}: {:?}", s.key(), cell, ns, probe.query);
                }
            }
        }
    }
}

fn can_i(user: &str, groups: &[&str], args: &[&str]) -> bool {
    let mut cmd = Command::new("kubectl");
    cmd.arg("--kubeconfig").arg(kubeconfig_path()).arg("auth").arg("can-i").args(args).arg("--as").arg(user);
    for g in groups {
        cmd.arg("--as-group").arg(g);
    }
    let out = cmd.output().expect("kubectl");
    String::from_utf8_lossy(&out.stdout).trim() == "yes"
}

/// (주체, kubectl `--as` 사용자, `--as-group`들, [(kubectl 인자, 같은 요청)])
type Case<'a> = (Subject, &'a str, Vec<&'a str>, Vec<(Vec<&'a str>, Query)>);

#[tokio::test]
#[ignore]
async fn the_engine_agrees_with_kubectl_auth_can_i() {
    let client = admin().await;
    let e = engine(&client).await;
    let cases: Vec<Case> = vec![
        (
            Subject::user("mm-acc-alice"),
            "mm-acc-alice",
            vec![],
            vec![(vec!["get", "pods", "-n", A], Query::new("get", "", "pods").ns(A)), (vec!["list", "configmaps", "-n", B], Query::new("list", "", "configmaps").ns(B)), (vec!["list", "secrets", "-A"], Query::new("list", "", "secrets"))],
        ),
        (
            Subject::user("mm-acc-bob"),
            "mm-acc-bob",
            vec![],
            vec![(vec!["get", "configmaps/cm1", "-n", A], Query::new("get", "", "configmaps").ns(A).named("cm1")), (vec!["get", "configmaps/cm2", "-n", A], Query::new("get", "", "configmaps").ns(A).named("cm2")), (vec!["get", "configmaps", "-n", A], Query::new("get", "", "configmaps").ns(A))],
        ),
        (
            Subject::service_account(A, "robot"),
            "system:serviceaccount:mm-acc-a:robot",
            vec![],
            vec![(vec!["create", "pods", "-n", A], Query::new("create", "", "pods").ns(A)), (vec!["create", "pods", "-n", B], Query::new("create", "", "pods").ns(B)), (vec!["create", "pods", "--subresource=exec", "-n", A], Query::new("create", "", "pods").subres("exec").ns(A))],
        ),
        (
            Subject::group("mm-acc-devs"),
            "someone",
            vec!["mm-acc-devs"],
            vec![(vec!["get", "deployments.apps", "-n", B], Query::new("get", "apps", "deployments").ns(B)), (vec!["create", "pods", "--subresource=exec", "-n", B], Query::new("create", "", "pods").subres("exec").ns(B))],
        ),
    ];
    for (subject, user, groups, checks) in cases {
        for (args, q) in checks {
            // 그룹 주체는 그 그룹만 가진 사용자로 묻는다: 기본 그룹(system:authenticated)은 kubectl이 더한다
            let sar = can_i(user, &groups, &args);
            let mine = if subject.kind == crate::k8s::access::rbac::SubjectKind::Group { e.can(&Subject::user(user), &q).allowed || e.can(&subject, &q).allowed } else { e.can(&subject, &q).allowed };
            assert_eq!(sar, mine, "{} {args:?}", subject.key());
        }
    }
}

#[tokio::test]
#[ignore]
async fn who_can_lists_exactly_the_subjects_the_cluster_would_allow() {
    let client = admin().await;
    let e = engine(&client).await;
    for q in [Query::new("create", "", "pods").subres("exec").ns(B), Query::new("get", "", "secrets").ns(A), Query::new("bind", "rbac.authorization.k8s.io", "clusterroles"), Query::new("list", "mm.example.com", "widgets").ns(A)] {
        let listed = e.who_can(&q);
        for w in &listed {
            let (user, groups) = sar_identity(&e, &w.subject);
            if w.grants.iter().all(|g| g.source.session_dependent) {
                continue;
            }
            assert!(review(&client, user.as_deref(), &groups, &q, PRIVATE).await.expect("SAR").allowed, "{} should be allowed for {q:?}", w.subject.key());
            assert!(w.grants.iter().all(|g| !matches!(g.source.via, Via::DefaultGroup { .. })));
        }
        // 클러스터가 허용하는데 목록에 없는 주체는 기본 그룹에서 물려받은 것뿐이어야 한다
        for s in subjects() {
            if listed.iter().any(|w| w.subject == s) {
                continue;
            }
            let (user, groups) = sar_identity(&e, &s);
            if review(&client, user.as_deref(), &groups, &q, PRIVATE).await.expect("SAR").allowed {
                assert!(e.can(&s, &q).grants.iter().all(|g| matches!(g.source.via, Via::DefaultGroup { .. }) || g.source.session_dependent), "{} {q:?}", s.key());
            }
        }
    }
}

#[tokio::test]
#[ignore]
async fn aggregation_namespaces_and_aws_auth_read_back_from_the_fixture() {
    let client = admin().await;
    let e = engine(&client).await;
    // aggregationRule이 합친 규칙: 라벨을 단 두 ClusterRole의 규칙이 mm-acc-agg에 모두 들어온다
    let alice = e.rules_of(&Subject::user("mm-acc-alice"));
    let via_agg: Vec<&str> = alice.grants.iter().filter(|g| g.source.role.as_ref().is_some_and(|r| r.name == "mm-acc-agg")).filter_map(|g| g.source.aggregated_from.as_deref()).collect();
    assert!(via_agg.contains(&"mm-acc-part1") && via_agg.contains(&"mm-acc-part2"), "{via_agg:?}");
    // view에 합쳐진 위젯 읽기
    assert!(e.can(&Subject::user("mm-acc-carol"), &Query::new("get", "mm.example.com", "widgets").ns(A)).allowed);
    let names = read_namespaces(&client, PRIVATE).await.unwrap();
    assert!(names.contains(&A.to_string()) && names.contains(&B.to_string()));
    let auth = read_aws_auth(&client, PRIVATE).await.unwrap().unwrap();
    assert_eq!(auth.roles.len(), 2);
    let mut data = BTreeMap::new();
    data.insert("mapRoles".to_string(), "- rolearn: x\n".to_string());
    assert_eq!(parse_aws_auth(&data).roles.len(), 1);
    // 없는 역할을 가리키는 바인딩 보고
    assert!(e.dangling().iter().any(|d| d.binding.name == "mm-acc-dangling"));
}
