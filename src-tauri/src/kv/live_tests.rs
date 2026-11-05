//! 실서버 시험(모두 `#[ignore]`): `scripts/kv-live-test.sh`가 Docker로 Valkey 8을 띄우고 자료를 심은 뒤 이 시험들을 돌린다.
//! 자료는 스크립트가 `valkey-cli`로 심는다(앱 코드는 쓰지 않는다). 서버 주소는 환경 변수로 받는다:
//! `KV_LIVE_PLAIN`(인증 없음), `KV_LIVE_AUTH`(requirepass + ACL 사용자), `KV_LIVE_TLS`와 `KV_LIVE_CA`(CA 파일), `KV_LIVE_CLUSTER`(3샤드의 한 노드). 모두 `포트`다(127.0.0.1).

use std::fs;
use std::sync::atomic::AtomicBool;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use rustls::RootCertStore;

use super::bull::model::{KvBullEdgeStatus, KvBullFlowState, KvBullState};
use super::bull::{events, flow, jobs, queue, topology};
use super::connect::{connect_with, tls_config_with, Auth, Connected, Plan, Secret};
use super::model::{KvKeyName, KvKind, KvMode, KvNode, KvRole, KvTargetInfo, KvType, KvValue};
use super::target::Resolved;
use super::{bigkeys, clients, key, overview, scan, slowlog};
use crate::error::AppError;
use crate::kv::model::KvLoginSaved;

fn port(var: &str) -> u16 {
    std::env::var(var).unwrap_or_else(|_| panic!("{var}가 없어요: scripts/kv-live-test.sh로 돌려 주세요")).parse().unwrap()
}

fn resolved(host: &str, port: u16, tls: bool, cluster: bool) -> Resolved {
    Resolved {
        info: KvTargetInfo {
            arn: "arn:aws:elasticache:ap-northeast-2:111111111111:replicationgroup:live".into(),
            identifier: "live".into(),
            kind: KvKind::ReplicationGroup,
            engine: "valkey".into(),
            engine_version: "8.0.2".into(),
            endpoint: host.into(),
            port,
            reader_endpoint: None,
            tls,
            cluster_mode: cluster,
            serverless: false,
            auth_token_enabled: false,
            user_group_ids: vec![],
            users: None,
            iam_supported: false,
        },
        members: if cluster { vec![] } else { vec![KvNode { id: "live-001".into(), address: format!("{host}:{port}"), role: KvRole::Primary, shard: None, slots: None }] },
    }
}

async fn open(port: u16, auth: Auth, cluster: bool) -> Result<Connected, AppError> {
    connect_with(Plan { resolved: resolved("127.0.0.1", port, false, cluster), auth, database: 0 }, None).await
}

fn user(name: &str, password: &str) -> Auth {
    Auth::User { name: name.into(), password: Secret::new(password) }
}

#[tokio::test]
#[ignore]
async fn auth_modes_against_a_real_server() {
    let p = port("KV_LIVE_AUTH");
    // requirepass: 인증 없이는 거절, 맞는 토큰은 통과, 틀린 토큰은 거절
    assert!(matches!(open(p, Auth::None, false).await.err().unwrap(), AppError::LoginRequired { .. }));
    open(p, Auth::Password(Secret::new("rootpass")), false).await.unwrap().close().await;
    assert!(matches!(open(p, Auth::Password(Secret::new("wrong")), false).await.err().unwrap(), AppError::LoginRequired { .. }));
    // ACL 사용자: 비밀번호가 있는 사용자, 비밀번호가 필요 없는 사용자, 틀린 비밀번호
    open(p, user("reader", "readpw"), false).await.unwrap().close().await;
    open(p, user("guest", ""), false).await.unwrap().close().await;
    assert_eq!(open(p, user("reader", "nope"), false).await.err().unwrap(), AppError::LoginRequired { message: "비밀번호가 맞지 않아요".into() });
    // 권한이 제한된 사용자: TYPE이 막혀 NOPERM 문구가 나온다
    let limited = open(p, user("limited", "limitedpw"), false).await.unwrap();
    let error = key::key_view(&limited, &KvKeyName { text: "str".into(), base64: None }, None).await.unwrap_err();
    assert_eq!(error, AppError::other("사용자 limited에게 TYPE 권한이 없어요"));
    limited.close().await;
}

#[tokio::test]
#[ignore]
async fn reads_every_value_type_and_server_status() {
    let conn = open(port("KV_LIVE_PLAIN"), Auth::None, false).await.unwrap();
    let page = scan::scan(&conn, "*", None, None, 1000).await.unwrap();
    assert!(page.keys.len() >= 8, "{}", page.keys.len());
    let only_hash = scan::scan(&conn, "h:*", Some(KvType::Hash), None, 1000).await.unwrap();
    assert!(only_hash.keys.iter().all(|k| k.kind == KvType::Hash) && !only_hash.keys.is_empty());
    let view = |name: &str| {
        let name = KvKeyName { text: name.into(), base64: None };
        let conn = &conn;
        async move { key::key_view(conn, &name, None).await }
    };
    match view("str").await.unwrap().value {
        KvValue::String { value, .. } => assert_eq!(value.text.as_deref(), Some("hello")),
        other => panic!("{other:?}"),
    }
    let big = view("bighash").await.unwrap();
    assert!(big.next.is_some(), "200개 넘는 해시는 다음 쪽이 있어야 해요");
    let second = key::key_view(&conn, &KvKeyName { text: "bighash".into(), base64: None }, big.next.as_deref()).await.unwrap();
    assert!(matches!(second.value, KvValue::Hash { .. }));
    assert!(matches!(view("lst").await.unwrap().value, KvValue::List { .. }));
    assert!(matches!(view("st").await.unwrap().value, KvValue::Set { .. }));
    assert!(matches!(view("zs").await.unwrap().value, KvValue::Zset { .. }));
    match view("strm").await.unwrap().value {
        KvValue::Stream { summary, entries } => assert!(summary.is_some() && !entries.is_empty()),
        other => panic!("{other:?}"),
    }
    // 바이트 이름의 키(UTF-8이 아님): 스캔이 준 이름으로 그대로 읽힌다
    let binary = page.keys.iter().find(|k| k.name.base64.is_some()).expect("바이너리 키");
    assert!(key::key_view(&conn, &binary.name, None).await.is_ok());
    let o = overview::overview(&conn, KvLoginSaved::default()).await.unwrap();
    assert_eq!(o.mode, KvMode::Standalone);
    assert!(o.dbsize >= 8 && o.info[0].used_memory > 0);
    slowlog::slowlog(&conn).await.unwrap();
    let list = clients::clients(&conn).await.unwrap();
    assert!(list.iter().any(|c| c.own), "앱 자신의 연결이 표시돼야 해요");
    let stop = AtomicBool::new(false);
    match bigkeys::bigkeys(&conn, 5, &stop, |_| {}).await {
        Ok(report) => assert!(!report.keys.is_empty() && !report.stopped),
        Err(e) => panic!("{e:?}"),
    }
    conn.close().await;
}

#[tokio::test]
#[ignore]
async fn tls_with_a_test_ca_verifies_the_host_name() {
    let p = port("KV_LIVE_TLS");
    let pem = fs::read(std::env::var("KV_LIVE_CA").expect("KV_LIVE_CA")).unwrap();
    let mut roots = RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(&pem) {
        roots.add(cert.unwrap()).unwrap();
    }
    let tls = tls_config_with(roots).unwrap();
    let plan = |host: &str| Plan { resolved: resolved(host, p, true, false), auth: Auth::None, database: 0 };
    connect_with(plan("localhost"), Some(tls.clone())).await.unwrap().close().await;
    // 인증서에 없는 이름(127.0.0.1)은 호스트 이름 검증에 걸린다
    let error = connect_with(plan("127.0.0.1"), Some(tls)).await.err().unwrap();
    assert_eq!(error, AppError::Network { message: "서버 인증서를 확인하지 못했어요".into() });
    // 시스템 루트만 믿으면 시험용 CA를 믿지 않는다
    let system = tls_config_with(super::connect::system_roots().unwrap()).unwrap();
    let error = connect_with(plan("localhost"), Some(system)).await.err().unwrap();
    assert_eq!(error, AppError::Network { message: "서버 인증서를 확인하지 못했어요".into() });
}

#[tokio::test]
#[ignore]
async fn a_three_shard_cluster_is_scanned_across_all_primaries() {
    let conn = open(port("KV_LIVE_CLUSTER"), Auth::None, true).await.unwrap();
    assert_eq!(conn.mode(), KvMode::Cluster);
    let primaries: Vec<_> = conn.nodes().iter().filter(|n| n.role == KvRole::Primary).collect();
    assert_eq!(primaries.len(), 3);
    assert!(primaries.iter().all(|n| n.slots.is_some()));
    // 모든 샤드에 걸친 키들을 다 읽는다
    let mut seen = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = scan::scan(&conn, "ck:*", None, cursor.as_deref(), 100).await.unwrap();
        seen.extend(page.keys.iter().map(|k| k.name.text.clone()));
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 300);
    let view = key::key_view(&conn, &KvKeyName { text: "ck:7".into(), base64: None }, None).await.unwrap();
    assert!(matches!(view.value, KvValue::String { .. }));
    let o = overview::overview(&conn, KvLoginSaved::default()).await.unwrap();
    assert_eq!(o.dbsize, 300);
    assert_eq!(o.info.len(), 3);
    assert!(!clients::clients(&conn).await.unwrap().is_empty());
    conn.close().await;
}

#[tokio::test]
#[ignore]
async fn a_bullmq_shaped_dataset_is_drawn_from_plain_keys() {
    let conn = open(port("KV_LIVE_PLAIN"), Auth::None, false).await.unwrap();
    let page = queue::queues(&conn, "bull", None).await.unwrap();
    let emails = page.queues.iter().find(|q| q.name == "emails").expect("emails 큐");
    assert_eq!(emails.counts.wait, 2);
    assert_eq!(emails.counts.completed, 3);
    assert_eq!(emails.counts.failed, 1);
    assert_eq!(emails.counts.delayed, 1);
    assert!(emails.paused);
    assert_eq!(emails.version.as_deref(), Some("5.12.0"));
    let legacy = page.queues.iter().find(|q| q.name == "legacy").expect("legacy 큐");
    assert_eq!(legacy.version, None);
    let view = queue::queue_view(&conn, "bull", "emails").await.unwrap();
    assert!(view.oldest_waiting_at.is_some() && view.next_delayed_at.is_some());
    assert_eq!(view.failed_reasons.first().map(|r| r.reason.as_str()), Some("SMTP timeout"));
    assert!(view.samples >= 1);
    let failed = jobs::jobs_page(&conn, "bull", "emails", KvBullState::Failed, 0, 50).await.unwrap();
    assert_eq!(failed.total, 1);
    let job = jobs::job(&conn, "bull", "emails", &failed.jobs[0].id).await.unwrap();
    assert_eq!(job.row.state, KvBullState::Failed);
    assert!(job.data.contains("to"));
    assert!(!job.stacktrace.is_empty());
    conn.close().await;
}

#[tokio::test]
#[ignore]
async fn a_bullmq_flow_across_two_queues_is_walked_from_any_node() {
    let conn = open(port("KV_LIVE_PLAIN"), Auth::None, false).await.unwrap();
    // 자식에서 열어도 부모(다른 큐)가 뿌리다
    let from_child = flow::flow(&conn, "bull", "fulfil", "c1").await.unwrap();
    assert_eq!((from_child.root.as_str(), from_child.focus.as_str(), from_child.truncated), ("bull:orders:p1", "bull:fulfil:c1", false));
    let state = |key: &str| from_child.nodes.iter().find(|n| n.key == key).map(|n| n.state);
    assert_eq!(state("bull:orders:p1"), Some(KvBullFlowState::WaitingChildren));
    assert_eq!(state("bull:fulfil:c1"), Some(KvBullFlowState::Wait));
    assert_eq!(state("bull:fulfil:c2"), Some(KvBullFlowState::Completed));
    assert_eq!(state("bull:fulfil:c3"), Some(KvBullFlowState::Failed));
    assert_eq!(state("bull:fulfil:c4"), Some(KvBullFlowState::Unknown));
    assert_eq!(from_child.nodes.len(), 5);
    let status = |child: &str| from_child.edges.iter().find(|e| e.child == child).map(|e| e.status);
    assert_eq!(status("bull:fulfil:c1"), Some(KvBullEdgeStatus::Pending));
    assert_eq!(status("bull:fulfil:c2"), Some(KvBullEdgeStatus::Done));
    assert_eq!(status("bull:fulfil:c3"), Some(KvBullEdgeStatus::Failed));
    assert_eq!(status("bull:fulfil:c4"), Some(KvBullEdgeStatus::Ignored));
    let parent = from_child.nodes.iter().find(|n| n.key == "bull:orders:p1").unwrap();
    assert_eq!((parent.pending, parent.done, parent.failed), (1, 1, 2));
    assert_eq!(from_child.nodes.iter().find(|n| n.key == "bull:fulfil:c3").unwrap().failed_reason.as_deref(), Some("no stock"));
    // 부모에서 열어도 같은 그래프다
    let from_parent = flow::flow(&conn, "bull", "orders", "p1").await.unwrap();
    assert_eq!(from_parent.nodes.len(), 5);
    assert_eq!(from_parent.focus, "bull:orders:p1");
    // 없는 작업
    assert!(flow::flow(&conn, "bull", "orders", "nope").await.is_err());
    conn.close().await;
}

#[tokio::test]
#[ignore]
async fn the_events_stream_gives_transition_pairs_and_the_window_cut() {
    let conn = open(port("KV_LIVE_PLAIN"), Auth::None, false).await.unwrap();
    let t = events::transitions(&conn, "bull", "fulfil", 15).await.unwrap();
    assert_eq!((t.events, t.truncated), (7, false));
    assert!(t.first_at.is_some_and(|at| at >= t.from));
    let count = |prev: Option<&str>, event: &str| t.pairs.iter().find(|p| p.prev.as_deref() == prev && p.event == event).map(|p| p.count);
    assert_eq!(count(Some("waiting"), "active"), Some(2));
    assert_eq!(count(Some("active"), "completed"), Some(1));
    assert_eq!(count(Some("active"), "failed"), Some(1));
    assert_eq!(count(None, "added"), Some(1));
    assert_eq!(count(None, "stalled"), Some(1));
    assert_eq!(count(None, "retries-exhausted"), Some(1));
    // 1분 창은 마지막 두 항목만 본다
    let recent = events::transitions(&conn, "bull", "fulfil", 1).await.unwrap();
    assert_eq!(recent.events, 2);
    assert_eq!(recent.pairs.len(), 2);
    // 이벤트를 안 남기는 큐는 빈 결과다
    let none = events::transitions(&conn, "bull", "legacy", 15).await.unwrap();
    assert_eq!((none.events, none.first_at, none.pairs.len()), (0, None, 0));
    conn.close().await;
}

#[tokio::test]
#[ignore]
async fn the_queue_map_links_parent_queues_to_child_queues_and_lists_workers() {
    let conn = open(port("KV_LIVE_PLAIN"), Auth::None, false).await.unwrap();
    let map = topology::topology(&conn, "bull").await.unwrap();
    let names: Vec<&str> = map.queues.iter().map(|q| q.name.as_str()).collect();
    for expected in ["emails", "legacy", "orders", "fulfil"] {
        assert!(names.contains(&expected), "{names:?}");
    }
    assert!(map.sampled >= 3);
    let link = map.links.iter().find(|l| l.from == "orders" && l.to == "fulfil").expect("orders → fulfil");
    assert!(link.jobs >= 2, "{link:?}");
    let workers = map.workers.expect("CLIENT LIST를 쓸 수 있어요");
    let packer = workers.iter().find(|w| w.queue == "fulfil" && w.name == "packer").expect("packer 워커");
    assert!(!packer.host.is_empty() && !packer.host.contains(':'));
    conn.close().await;
}

/// Bull 3은 `completed`·`failed`가 정렬 셋이다: 작업 표·상태·흐름이 셋으로만 가정하면 WRONGTYPE으로 실패했다
#[tokio::test]
#[ignore]
async fn a_bull3_queue_with_sorted_finished_sets_lists_and_locates_jobs() {
    let conn = open(port("KV_LIVE_PLAIN"), Auth::None, false).await.unwrap();
    let completed = jobs::jobs_page(&conn, "bull", "bull3", KvBullState::Completed, 0, 50).await.unwrap();
    assert_eq!((completed.total, completed.jobs.len()), (1, 1));
    assert_eq!(completed.jobs[0].id, "2");
    let failed = jobs::jobs_page(&conn, "bull", "bull3", KvBullState::Failed, 0, 50).await.unwrap();
    assert_eq!(failed.jobs[0].failed_reason.as_deref(), Some("boom"));
    assert_eq!(jobs::job(&conn, "bull", "bull3", "2").await.unwrap().row.state, KvBullState::Completed);
    assert_eq!(jobs::job(&conn, "bull", "bull3", "3").await.unwrap().row.state, KvBullState::Failed);
    let f = flow::flow(&conn, "bull", "bull3", "3").await.unwrap();
    assert_eq!(f.nodes[0].state, KvBullFlowState::Failed);
    // 오래된 Bull의 셋은 그대로 읽힌다
    let set = jobs::jobs_page(&conn, "bull", "legacy", KvBullState::Completed, 0, 50).await.unwrap();
    assert_eq!(set.total, 1);
    conn.close().await;
}
