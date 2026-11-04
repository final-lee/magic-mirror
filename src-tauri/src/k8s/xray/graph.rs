//! 객체 더미에서 관계 트리를 만든다. 네 묶음(소유·참조·선택·대상)을 차례로 만들고, 노드 수와 가지 수에 한도를 둔다.
use std::collections::{HashMap, HashSet};

use super::model::{Edge, Presence, Section, Xray, XrayNode};
use super::pool::{self, Item, Key, Pool, Spec};
use super::refs::{ingress_services, pod_labels, pod_selector, pod_spec, refs_of, scale_target, selects, slice_pods, slice_service, Ref};

/// 트리 전체의 노드 수 한도
pub const NODES_MAX: usize = 300;
/// 한 부모 아래에 보이는 자식 수 한도
pub const FAN_OUT_MAX: usize = 50;
/// 소유자를 위로 따라가는 단계 한도
const OWNER_DEPTH_MAX: usize = 8;
/// 자식을 아래로 따라가는 단계 한도
const CHILD_DEPTH_MAX: usize = 6;
/// 참조·사용을 이어 따라가는 단계 한도(SC → PV → PVC → Pod)
const REF_DEPTH_MAX: usize = 4;
/// 템플릿 대신 Pod가 따로 가리키는 것(노드·PVC)을 모으려고 훑는 Pod 수 한도
const POD_SCAN_MAX: usize = 500;

fn is(item: &Item, spec: &Spec) -> bool {
    item.kind.group == spec.group && item.kind.kind == spec.kind
}

/// 이름으로 가리키는 종류의 화면 순서
fn rank(kind: &str) -> u8 {
    match kind {
        "ServiceAccount" => 0,
        "ConfigMap" => 1,
        "Secret" => 2,
        "PersistentVolumeClaim" => 3,
        "PersistentVolume" => 4,
        "StorageClass" => 5,
        "Node" => 6,
        "PriorityClass" => 7,
        _ => 8,
    }
}

/// 다른 객체가 이름으로 가리킬 수 있는 종류. 이 종류를 보면 그것을 쓰는 객체도 보여 준다.
fn referable(item: &Item) -> bool {
    [&pool::SERVICE_ACCOUNT, &pool::CONFIG_MAP, &pool::SECRET, &pool::PVC, &pool::PV, &pool::STORAGE_CLASS, &pool::NODE, &pool::PRIORITY_CLASS].iter().any(|s| is(item, s))
}

/// 문제가 있는 것을 먼저, 그다음 종류와 이름 순
fn by_attention(items: &mut [&Item]) {
    items.sort_by(|a, b| (a.problems.is_empty(), &a.kind.kind, &a.name).cmp(&(b.problems.is_empty(), &b.kind.kind, &b.name)));
}

/// 소유자 한 칸: 더미에서 찾았거나, 찾지 못해 ownerReference만 남은 것
type Linked<'a> = Result<&'a Item, Box<Ref>>;

/// 가까운 소유자부터 위로 이어지는 사슬과, 사슬에 들지 않은 다른 소유자
struct OwnerChain<'a> {
    chain: Vec<Linked<'a>>,
    others: Vec<Linked<'a>>,
}

struct Builder<'a> {
    pool: &'a Pool,
    count: usize,
    truncated: bool,
}

impl<'a> Builder<'a> {
    /// 노드 하나를 만들 자리가 있는가. 없으면 줄였다고 적는다.
    fn spend(&mut self) -> bool {
        if self.count >= NODES_MAX {
            self.truncated = true;
            return false;
        }
        self.count += 1;
        true
    }

    /// 한 부모 아래 자식 수를 한도로 줄인다
    fn cap<T>(&mut self, mut v: Vec<T>) -> Vec<T> {
        if v.len() > FAN_OUT_MAX {
            self.truncated = true;
            v.truncate(FAN_OUT_MAX);
        }
        v
    }

    fn node(item: &Item, edge: Edge, roles: Vec<String>) -> XrayNode {
        XrayNode {
            group: item.kind.group.clone(),
            version: item.kind.version.clone(),
            kind: item.kind.kind.clone(),
            namespace: item.namespace.clone(),
            name: item.name.clone(),
            edge,
            roles,
            current: false,
            presence: Presence::Found,
            status: item.status.clone(),
            problems: item.problems.clone(),
            children: vec![],
        }
    }

    /// 가리킨 객체가 더미에 없을 때의 노드: 없는 것인지 알 수 없는 것인지만 적는다
    fn absent(&self, r: &Ref, edge: Edge, roles: Vec<String>) -> XrayNode {
        XrayNode {
            group: r.kind.group.clone(),
            version: r.kind.version.clone(),
            kind: r.kind.kind.clone(),
            namespace: r.namespace.clone(),
            name: r.name.clone(),
            edge,
            roles,
            current: false,
            presence: self.pool.presence(&r.key()),
            status: None,
            problems: vec![],
            children: vec![],
        }
    }

    /// 이름으로 가리킨 객체의 노드(있으면 상태까지, 없으면 없음·알 수 없음). 자리가 없으면 None.
    fn target(&mut self, r: &Ref, edge: Edge, roles: Vec<String>) -> Option<XrayNode> {
        if !self.spend() {
            return None;
        }
        Some(match self.pool.get(&r.key()) {
            Some(item) => Self::node(item, edge, roles),
            None => self.absent(r, edge, roles),
        })
    }

    // ───── 소유 ─────

    /// 소유자 쪽 사슬. 컨트롤러 소유자를 먼저 따라 올라간다(여럿이면 첫 소유자만 사슬이 되고 나머지는 옆에 둔다).
    fn owner_chain(&self, root: &Item) -> OwnerChain<'a> {
        let pool = self.pool;
        let resolve = |child: &Item, o: &pool::OwnerRef| -> Linked<'a> {
            if let Some(found) = pool.by_uid(&o.uid) {
                return Ok(found);
            }
            for namespace in [child.namespace.as_deref(), None] {
                if let Some(found) = pool.get(&Key::new(&o.group, &o.kind, namespace, &o.name)) {
                    return Ok(found);
                }
            }
            let kind = crate::k8s::rows::KindRef { group: o.group.clone(), version: o.version.clone(), kind: o.kind.clone(), plural: String::new(), namespaced: child.namespace.is_some() };
            Err(Box::new(Ref { kind, namespace: child.namespace.clone(), name: o.name.clone(), roles: vec![] }))
        };
        let pick = |item: &Item| -> Option<pool::OwnerRef> { item.owners.iter().find(|o| o.controller).or_else(|| item.owners.first()).cloned() };
        let mut chain = Vec::new();
        let mut seen: HashSet<String> = HashSet::from([root.uid.clone()]);
        let mut current: &Item = root;
        for _ in 0..OWNER_DEPTH_MAX {
            let Some(o) = pick(current) else { break };
            let linked = resolve(current, &o);
            let next = linked.as_ref().ok().copied();
            chain.push(linked);
            match next {
                Some(item) if seen.insert(item.uid.clone()) => current = item,
                _ => break,
            }
        }
        let first = pick(root);
        let others = root.owners.iter().filter(|o| first.as_ref().is_none_or(|f| f.uid != o.uid)).map(|o| resolve(root, o)).collect();
        OwnerChain { chain, others }
    }

    fn descendants(&mut self, item: &Item, depth: usize, seen: &mut HashSet<String>) -> Vec<XrayNode> {
        if depth >= CHILD_DEPTH_MAX {
            return vec![];
        }
        let mut kids: Vec<&Item> = self.pool.children_of(&item.uid).into_iter().filter(|k| seen.insert(k.uid.clone())).collect();
        by_attention(&mut kids);
        let kids = self.cap(kids);
        let mut out = Vec::new();
        for kid in kids {
            if !self.spend() {
                break;
            }
            let mut node = Self::node(kid, Edge::Owner, vec![]);
            node.children = self.descendants(kid, depth + 1, seen);
            out.push(node);
        }
        out
    }

    /// 소유자 → … → 이 객체 → 자식 → … 한 갈래 트리
    fn owners(&mut self, root: &Item) -> Vec<XrayNode> {
        if root.owners.is_empty() && self.pool.children_of(&root.uid).is_empty() {
            return vec![];
        }
        let OwnerChain { chain, others } = self.owner_chain(root);
        let mut current = Self::node(root, Edge::Owner, vec![]);
        current.current = true;
        self.count += 1;
        current.children = self.descendants(root, 0, &mut HashSet::from([root.uid.clone()]));
        let mut top = current;
        for link in chain {
            if !self.spend() {
                break;
            }
            let mut node = match &link {
                Ok(item) => Self::node(item, Edge::Owner, vec![]),
                Err(r) => self.absent(r, Edge::Owner, vec![]),
            };
            node.children = vec![top];
            top = node;
        }
        let mut out = vec![top];
        for link in others {
            if !self.spend() {
                break;
            }
            out.push(match &link {
                Ok(item) => Self::node(item, Edge::Owner, vec![]),
                Err(r) => self.absent(r, Edge::Owner, vec![]),
            });
        }
        out
    }

    // ───── 참조 ─────

    /// 이 객체와 그 아래 Pod가 가리키는 것을 이름 하나에 한 번씩 모은다(역할은 합친다). 종류마다 `FAN_OUT_MAX`개까지만 두고, 줄였으면 둘째 값이 참이다.
    fn forward_refs(&self, root: &Item) -> (Vec<Ref>, bool) {
        let mut sources: Vec<&Item> = vec![root];
        if pod_spec(root).is_some() && !is(root, &pool::POD) {
            let mut stack = vec![root];
            let mut seen = HashSet::from([root.uid.clone()]);
            while let Some(item) = stack.pop() {
                for kid in self.pool.children_of(&item.uid) {
                    if !seen.insert(kid.uid.clone()) {
                        continue;
                    }
                    if is(kid, &pool::POD) && sources.len() < POD_SCAN_MAX {
                        sources.push(kid);
                    }
                    stack.push(kid);
                }
            }
        }
        let mut merged: Vec<Ref> = Vec::new();
        for source in sources {
            for r in refs_of(source) {
                match merged.iter_mut().find(|m| m.key() == r.key()) {
                    Some(m) => {
                        for role in r.roles {
                            if !m.roles.contains(&role) {
                                m.roles.push(role);
                            }
                        }
                    }
                    None => merged.push(r),
                }
            }
        }
        merged.sort_by(|a, b| (rank(&a.kind.kind), &a.name).cmp(&(rank(&b.kind.kind), &b.name)));
        let mut per_kind: HashMap<String, usize> = HashMap::new();
        let before = merged.len();
        merged.retain(|r| {
            let n = per_kind.entry(r.kind.kind.clone()).or_default();
            *n += 1;
            *n <= FAN_OUT_MAX
        });
        let cut = merged.len() < before;
        (merged, cut)
    }

    /// 이름으로 가리킨 객체와, 그 객체가 다시 가리키는 것(PVC → PV → StorageClass)
    fn ref_tree(&mut self, r: &Ref, roles: Vec<String>, depth: usize, seen: &mut HashSet<Key>) -> Option<XrayNode> {
        if !seen.insert(r.key()) {
            return None;
        }
        let mut node = self.target(r, Edge::Reference, roles)?;
        if depth + 1 < REF_DEPTH_MAX {
            if let Some(item) = self.pool.get(&r.key()) {
                let mut nested = refs_of(item);
                nested.sort_by(|a, b| (rank(&a.kind.kind), &a.name).cmp(&(rank(&b.kind.kind), &b.name)));
                for n in nested {
                    if let Some(child) = self.ref_tree(&n, n.roles.clone(), depth + 1, seen) {
                        node.children.push(child);
                    }
                }
            }
        }
        Some(node)
    }

    /// 대상 객체를 이름으로 가리키는 객체들(대상 키 → 가리키는 객체와 그 역할)
    fn usage(&self) -> HashMap<Key, Vec<(&'a Item, Vec<String>)>> {
        let mut map: HashMap<Key, Vec<(&'a Item, Vec<String>)>> = HashMap::new();
        for item in self.pool.items() {
            for r in refs_of(item) {
                map.entry(r.key()).or_default().push((item, r.roles));
            }
        }
        map
    }

    /// 소유자 사슬 위에 같은 객체를 가리키는 것이 있는가
    fn has_user_above(&self, item: &Item, matched: &HashSet<&str>) -> bool {
        let mut current = item;
        for _ in 0..OWNER_DEPTH_MAX {
            if current.owners.iter().any(|o| matched.contains(o.uid.as_str())) {
                return true;
            }
            let Some(next) = current.owners.iter().find_map(|o| self.pool.by_uid(&o.uid)) else { return false };
            current = next;
        }
        false
    }

    /// 이 객체를 가리키는 것들. 소유자도 같은 객체를 가리키면(Pod와 그 ReplicaSet·Deployment) 가장 위 소유자만 보인다.
    fn used_by(&mut self, key: &Key, usage: &HashMap<Key, Vec<(&'a Item, Vec<String>)>>, depth: usize, seen: &mut HashSet<Key>) -> Vec<XrayNode> {
        let Some(users) = usage.get(key) else { return vec![] };
        let matched: HashSet<&str> = users.iter().map(|(i, _)| i.uid.as_str()).collect();
        let mut users: Vec<&(&Item, Vec<String>)> = users.iter().filter(|(i, _)| !self.has_user_above(i, &matched)).collect();
        users.sort_by(|a, b| (rank(&a.0.kind.kind), a.0.problems.is_empty(), &a.0.name).cmp(&(rank(&b.0.kind.kind), b.0.problems.is_empty(), &b.0.name)));
        let users = self.cap(users);
        let mut out = Vec::new();
        for (item, roles) in users {
            if !seen.insert(item.key()) {
                continue;
            }
            if !self.spend() {
                break;
            }
            let mut tagged = vec!["usedBy".to_string()];
            tagged.extend(roles.iter().cloned());
            let mut node = Self::node(item, Edge::Reference, tagged);
            if depth + 1 < REF_DEPTH_MAX && referable(item) {
                node.children = self.used_by(&item.key(), usage, depth + 1, seen);
            }
            out.push(node);
        }
        out
    }

    fn references(&mut self, root: &Item) -> Vec<XrayNode> {
        let mut seen = HashSet::from([root.key()]);
        let mut out = Vec::new();
        let (refs, cut) = self.forward_refs(root);
        self.truncated |= cut;
        for r in refs {
            let roles = r.roles.clone();
            if let Some(node) = self.ref_tree(&r, roles, 0, &mut seen) {
                out.push(node);
            }
        }
        if referable(root) {
            let usage = self.usage();
            out.extend(self.used_by(&root.key(), &usage, 0, &mut seen));
        }
        out
    }

    // ───── 선택 ─────

    /// 같은 네임스페이스에서 이 선택자가 고르는 Pod
    fn selected_pods(&mut self, holder: &Item, edge: Edge) -> Vec<XrayNode> {
        let Some(selector) = pod_selector(holder) else { return vec![] };
        let mut pods: Vec<&Item> = self.pool.of_kind(&pool::POD).filter(|p| p.namespace == holder.namespace && selects(&selector, &p.labels)).collect();
        by_attention(&mut pods);
        let pods = self.cap(pods);
        let mut out = Vec::new();
        for pod in pods {
            if !self.spend() {
                break;
            }
            out.push(Self::node(pod, edge, vec![]));
        }
        out
    }

    /// 이 Service를 대상으로 하는 Ingress와 이 Service의 EndpointSlice
    fn service_targets(&mut self, service: &Item) -> Vec<XrayNode> {
        let mut found: Vec<&Item> = self
            .pool
            .of_kind(&pool::INGRESS)
            .filter(|i| i.namespace == service.namespace && ingress_services(i).contains(&service.name))
            .chain(self.pool.of_kind(&pool::ENDPOINT_SLICE).filter(|s| s.namespace == service.namespace && slice_service(s) == Some(service.name.as_str())))
            .collect();
        found.sort_by(|a, b| (&a.kind.kind, &a.name).cmp(&(&b.kind.kind, &b.name)));
        let found = self.cap(found);
        let mut out = Vec::new();
        for item in found {
            if !self.spend() {
                break;
            }
            out.push(Self::node(item, Edge::Target, vec![]));
        }
        out
    }

    fn selectors(&mut self, root: &Item) -> Vec<XrayNode> {
        if pod_selector(root).is_some() {
            return self.selected_pods(root, Edge::Selector);
        }
        let Some(labels) = pod_labels(root) else { return vec![] };
        let mut holders: Vec<&Item> = [&pool::SERVICE, &pool::PDB, &pool::NETWORK_POLICY]
            .into_iter()
            .flat_map(|spec| self.pool.of_kind(spec))
            .filter(|h| h.namespace == root.namespace && pod_selector(h).is_some_and(|s| selects(&s, &labels)))
            .collect();
        holders.sort_by(|a, b| (&a.kind.kind != "Service", &a.kind.kind, &a.name).cmp(&(&b.kind.kind != "Service", &b.kind.kind, &b.name)));
        let holders = self.cap(holders);
        let mut out = Vec::new();
        for holder in holders {
            if !self.spend() {
                break;
            }
            let mut node = Self::node(holder, Edge::Selector, vec![]);
            if is(holder, &pool::SERVICE) {
                node.children = self.service_targets(holder);
            }
            out.push(node);
        }
        out
    }

    // ───── 대상 ─────

    fn targets(&mut self, root: &Item) -> Vec<XrayNode> {
        let mut out = Vec::new();
        let ns = root.namespace.as_deref();
        let service_ref = |name: &str| Ref { kind: pool::SERVICE.kind_ref(), namespace: ns.map(str::to_string), name: name.to_string(), roles: vec![] };
        if is(root, &pool::SERVICE) {
            out.extend(self.service_targets(root));
        }
        if is(root, &pool::INGRESS) {
            for name in ingress_services(root) {
                let r = service_ref(&name);
                if let Some(mut node) = self.target(&r, Edge::Target, vec![]) {
                    if let Some(service) = self.pool.get(&r.key()) {
                        node.children = self.selected_pods(service, Edge::Selector);
                    }
                    out.push(node);
                }
            }
        }
        if let Some((group, kind, name)) = scale_target(root) {
            let spec_kind = self.pool.items().iter().find(|i| i.kind.group == group && i.kind.kind == kind).map(|i| i.kind.clone());
            let kind_ref = spec_kind.unwrap_or(crate::k8s::rows::KindRef { group, version: String::new(), kind, plural: String::new(), namespaced: true });
            let r = Ref { kind: kind_ref, namespace: ns.map(str::to_string), name, roles: vec![] };
            out.extend(self.target(&r, Edge::Target, vec![]));
        }
        let mut hpas: Vec<&Item> = self
            .pool
            .of_kind(&pool::HPA)
            .filter(|h| h.namespace == root.namespace && scale_target(h).is_some_and(|(g, k, n)| g == root.kind.group && k == root.kind.kind && n == root.name))
            .collect();
        hpas.sort_by(|a, b| a.name.cmp(&b.name));
        let hpas = self.cap(hpas);
        for hpa in hpas {
            if !self.spend() {
                break;
            }
            out.push(Self::node(hpa, Edge::Target, vec![]));
        }
        if let Some(service) = slice_service(root) {
            let r = service_ref(service);
            out.extend(self.target(&r, Edge::Target, vec![]));
        }
        let pods = slice_pods(root);
        let pods = self.cap(pods);
        for pod in pods {
            let r = Ref { kind: pool::POD.kind_ref(), namespace: ns.map(str::to_string), name: pod, roles: vec![] };
            out.extend(self.target(&r, Edge::Target, vec![]));
        }
        out
    }
}

fn count(nodes: &[XrayNode]) -> usize {
    nodes.iter().map(|n| 1 + count(&n.children)).sum()
}

/// 지금 보는 객체(`root`)의 관계 트리. `root`가 더미에 들어 있지 않아도 된다.
pub fn build(root: &Item, pool: &Pool) -> Xray {
    let mut b = Builder { pool, count: 0, truncated: false };
    let mut sections = Vec::new();
    for (edge, nodes) in [(Edge::Owner, b.owners(root)), (Edge::Reference, b.references(root)), (Edge::Selector, b.selectors(root)), (Edge::Target, b.targets(root))] {
        if !nodes.is_empty() {
            sections.push(Section { edge, nodes });
        }
    }
    let nodes = sections.iter().map(|s| count(&s.nodes)).sum();
    let mut partial = pool.partial.clone();
    partial.sort();
    Xray { sections, gaps: pool.gaps.clone(), truncated: b.truncated, partial, nodes }
}

/// 이름으로 읽어야 하는 클러스터 범위 객체 중 더미에 없고 아직 읽어 보지 않은 것(노드, PV, StorageClass, PriorityClass).
/// 참조를 따라 가며 새로 생긴 것도 있어, 읽어 더미에 담은 뒤 다시 부르면 한 단계 더 나아간다.
pub fn unresolved_cluster_refs(root: &Item, pool: &Pool) -> Vec<Ref> {
    let b = Builder { pool, count: 0, truncated: false };
    let mut out: Vec<Ref> = Vec::new();
    let mut stack: Vec<Ref> = b.forward_refs(root).0;
    let mut seen: HashSet<Key> = HashSet::new();
    while let Some(r) = stack.pop() {
        if !seen.insert(r.key()) {
            continue;
        }
        match pool.get(&r.key()) {
            Some(item) => stack.extend(refs_of(item)),
            None if !r.kind.namespaced && !pool.tried(&r.key()) => out.push(r),
            None => {}
        }
    }
    out.sort_by(|a, b| (&a.kind.kind, &a.name).cmp(&(&b.kind.kind, &b.name)));
    out
}
