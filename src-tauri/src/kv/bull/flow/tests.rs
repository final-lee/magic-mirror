use super::*;

#[test]
fn job_keys_split_by_the_current_prefix_first() {
    let s = |a: &str, b: &str, c: &str| Some((a.to_string(), b.to_string(), c.to_string()));
    assert_eq!(split_job_key("bull:emails:12", "bull"), s("bull", "emails", "12"));
    // 해시 태그 prefix
    assert_eq!(split_job_key("{bull}:emails:12", "{bull}"), s("{bull}", "emails", "12"));
    // 지금 prefix로 시작하면 큐 이름에 `:`가 있어도 prefix만 뗀다
    assert_eq!(split_job_key("bull:a:b:7", "bull"), s("bull", "a:b", "7"));
    // 다른 prefix의 큐는 마지막 `:`에서 나눈다
    assert_eq!(split_job_key("other:billing:3", "bull"), s("other", "billing", "3"));
    assert_eq!(split_job_key("bullish:billing:3", "bull"), s("bullish", "billing", "3"));
    for bad in ["", "noid:", "justone", "x:1"] {
        assert_eq!(split_job_key(bad, "bull"), None, "{bad:?}");
    }
}

struct Graph(HashMap<String, NodeData>);

#[async_trait]
impl FlowSource for Graph {
    async fn node(&self, key: &str) -> Result<NodeData, AppError> {
        Ok(self.0.get(key).cloned().unwrap_or_else(NodeData::missing))
    }
}

fn node(state: KvBullFlowState, parent: Option<&str>) -> NodeData {
    NodeData { name: "job".into(), state, parent_key: parent.map(str::to_string), ..NodeData::missing() }
}

fn keys(list: &[&str]) -> Vec<String> {
    list.iter().map(|k| k.to_string()).collect()
}

fn flow_graph() -> Graph {
    let mut parent = node(KvBullFlowState::WaitingChildren, None);
    parent.pending = keys(&["bull:child:1"]);
    parent.done = keys(&["bull:child:2", "other:billing:3"]);
    parent.failed = keys(&["bull:child:4"]);
    parent.ignored = keys(&["bull:child:5"]);
    let mut grand = node(KvBullFlowState::Active, Some("bull:parent:p"));
    grand.pending = keys(&["bull:child:6"]);
    Graph(HashMap::from([
        ("bull:parent:p".to_string(), parent),
        ("bull:child:1".to_string(), grand),
        ("bull:child:2".to_string(), node(KvBullFlowState::Completed, Some("bull:parent:p"))),
        ("other:billing:3".to_string(), node(KvBullFlowState::Completed, Some("bull:parent:p"))),
        ("bull:child:4".to_string(), node(KvBullFlowState::Failed, Some("bull:parent:p"))),
        ("bull:child:6".to_string(), node(KvBullFlowState::Wait, Some("bull:child:1"))),
    ]))
}

#[tokio::test]
async fn the_walk_goes_up_to_the_root_and_down_through_every_child_kind() {
    let flow = walk(&flow_graph(), "bull", "bull:child:6").await.unwrap();
    assert_eq!((flow.root.as_str(), flow.focus.as_str(), flow.truncated), ("bull:parent:p", "bull:child:6", false));
    let keys: Vec<&str> = flow.nodes.iter().map(|n| n.key.as_str()).collect();
    assert_eq!(keys, vec!["bull:parent:p", "bull:child:1", "bull:child:2", "other:billing:3", "bull:child:4", "bull:child:5", "bull:child:6"]);
    let status = |child: &str| flow.edges.iter().find(|e| e.child == child).map(|e| (e.parent.as_str(), e.status));
    assert_eq!(status("bull:child:1"), Some(("bull:parent:p", KvBullEdgeStatus::Pending)));
    assert_eq!(status("bull:child:2"), Some(("bull:parent:p", KvBullEdgeStatus::Done)));
    assert_eq!(status("bull:child:4"), Some(("bull:parent:p", KvBullEdgeStatus::Failed)));
    assert_eq!(status("bull:child:5"), Some(("bull:parent:p", KvBullEdgeStatus::Ignored)));
    assert_eq!(status("bull:child:6"), Some(("bull:child:1", KvBullEdgeStatus::Pending)));
    // 다른 큐·다른 prefix의 자식, 그리고 없는 작업
    let billing = flow.nodes.iter().find(|n| n.key == "other:billing:3").unwrap();
    assert_eq!((billing.prefix.as_str(), billing.queue.as_str(), billing.id.as_str()), ("other", "billing", "3"));
    assert_eq!(flow.nodes.iter().find(|n| n.key == "bull:child:5").unwrap().state, KvBullFlowState::Missing);
    let root = &flow.nodes[0];
    assert_eq!((root.pending, root.done, root.failed), (1, 2, 2));
}

#[tokio::test]
async fn a_cycle_of_parents_stops_the_climb() {
    let graph = Graph(HashMap::from([
        ("bull:q:a".to_string(), node(KvBullFlowState::Wait, Some("bull:q:b"))),
        ("bull:q:b".to_string(), node(KvBullFlowState::Wait, Some("bull:q:a"))),
    ]));
    let flow = walk(&graph, "bull", "bull:q:a").await.unwrap();
    assert_eq!(flow.root, "bull:q:b");
    assert_eq!(flow.nodes.len(), 2);
}

#[tokio::test]
async fn a_cycle_of_children_does_not_loop_and_edges_are_not_duplicated() {
    let mut a = node(KvBullFlowState::WaitingChildren, None);
    a.pending = keys(&["bull:q:b"]);
    a.done = keys(&["bull:q:b"]);
    let mut b = node(KvBullFlowState::WaitingChildren, Some("bull:q:a"));
    b.pending = keys(&["bull:q:a"]);
    let flow = walk(&Graph(HashMap::from([("bull:q:a".into(), a), ("bull:q:b".into(), b)])), "bull", "bull:q:b").await.unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(flow.nodes.len(), 2);
    assert_eq!(flow.edges.iter().filter(|e| e.parent == "bull:q:a" && e.child == "bull:q:b").count(), 1);
}

#[tokio::test]
async fn the_climb_stops_after_ten_levels() {
    let mut map = HashMap::new();
    for level in 0..15 {
        map.insert(format!("bull:q:{level}"), node(KvBullFlowState::Wait, Some(&format!("bull:q:{}", level + 1))));
    }
    let flow = walk(&Graph(map), "bull", "bull:q:0").await.unwrap();
    assert_eq!(flow.root, "bull:q:10");
}

#[tokio::test]
async fn a_huge_flow_is_cut_at_300_nodes_and_says_so() {
    let mut root = node(KvBullFlowState::WaitingChildren, None);
    root.pending = (0..500).map(|i| format!("bull:kid:{i}")).collect();
    let mut map: HashMap<String, NodeData> = (0..500).map(|i| (format!("bull:kid:{i}"), node(KvBullFlowState::Wait, Some("bull:root:r")))).collect();
    map.insert("bull:root:r".into(), root);
    let flow = walk(&Graph(map), "bull", "bull:root:r").await.unwrap();
    assert_eq!(flow.nodes.len(), MAX_NODES);
    assert!(flow.truncated);
    assert_eq!(flow.edges.len(), MAX_NODES - 1);
}

#[tokio::test]
async fn a_focus_missing_from_its_parents_lists_is_still_drawn() {
    let graph = Graph(HashMap::from([
        ("bull:p:1".to_string(), node(KvBullFlowState::WaitingChildren, None)),
        ("bull:c:2".to_string(), node(KvBullFlowState::Completed, Some("bull:p:1"))),
    ]));
    let flow = walk(&graph, "bull", "bull:c:2").await.unwrap();
    assert_eq!(flow.nodes.iter().map(|n| n.key.as_str()).collect::<Vec<_>>(), vec!["bull:p:1", "bull:c:2"]);
    assert_eq!(flow.edges, vec![KvBullFlowEdge { parent: "bull:p:1".into(), child: "bull:c:2".into(), status: KvBullEdgeStatus::Done }]);
}

#[test]
fn the_state_lookup_checks_sorted_sets_first_then_lists_and_follows_the_flavor() {
    let bullmq = state_plan(KvBullFlavor::Bullmq);
    assert_eq!(bullmq.iter().map(|p| p.0).collect::<Vec<_>>(), vec![KvBullState::Completed, KvBullState::Failed, KvBullState::Delayed, KvBullState::Prioritized, KvBullState::WaitingChildren, KvBullState::Wait, KvBullState::Active, KvBullState::Paused]);
    assert_eq!(bullmq.iter().filter(|p| p.1 == Probe::LPos).count(), 3);
    assert!(bullmq.iter().take(5).all(|p| p.1 == Probe::ZScore));
    // 옛 Bull의 완료·실패는 셋이다
    let legacy = state_plan(KvBullFlavor::Bull);
    assert_eq!((legacy[0].1, legacy[1].1, legacy[2].1), (Probe::SIsMember, Probe::SIsMember, Probe::ZScore));
}
