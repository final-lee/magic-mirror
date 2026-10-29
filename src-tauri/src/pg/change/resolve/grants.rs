//! 객체 권한과 기본 권한 변경을 푸는 일

use super::*;

/// 권한 한 건을 풀어 둔 것(스냅숏을 읽기만 해서 만든다)
struct GrantPlan {
    blocks: Vec<String>,
    op: Option<Op>,
    stays: Vec<String>,
}

pub(super) fn is_table_like(kind: RelKind) -> bool {
    kind != RelKind::Sequence
}

/// 객체 종류에 있는 권한 이름. 기본 권한의 `Types`는 USAGE뿐이다
pub(super) fn default_offers(object_type: DefaultObjType, p: Privilege, version: i32) -> bool {
    match object_type {
        DefaultObjType::Tables => offers(PrivKind::Table, p, version),
        DefaultObjType::Sequences => offers(PrivKind::Sequence, p, version),
        DefaultObjType::Functions => offers(PrivKind::Function, p, version),
        DefaultObjType::Schemas => offers(PrivKind::Schema, p, version),
        DefaultObjType::Types => p == Privilege::Usage,
    }
}

pub(super) fn default_label(object_type: DefaultObjType) -> &'static str {
    match object_type {
        DefaultObjType::Tables => "테이블",
        DefaultObjType::Sequences => "시퀀스",
        DefaultObjType::Functions => "함수",
        DefaultObjType::Types => "타입",
        DefaultObjType::Schemas => "스키마",
    }
}

pub(super) fn sorted(privileges: &[Privilege]) -> Vec<Privilege> {
    privileges.iter().copied().collect::<BTreeSet<_>>().into_iter().collect()
}

pub(super) fn lookup<'x>(cluster: &'x ClusterSnapshot, db: &'x DbSnapshot, key: &ObjKey) -> Option<Obj<'x>> {
    match key {
        ObjKey::Database(name) => cluster.databases.iter().find(|d| &d.name == name).map(Obj::Database),
        ObjKey::Schema(name) => db.schemas.iter().find(|s| &s.name == name).map(Obj::Schema),
        ObjKey::Relation(schema, name) => db.relations.iter().find(|r| &r.schema == schema && &r.name == name).map(Obj::Relation),
        ObjKey::Function(schema, name, signature) => db.functions.iter().find(|f| &f.schema == schema && &f.name == name && &f.signature == signature).map(Obj::Function),
    }
}

impl Resolver<'_> {
    pub(super) fn grant(&mut self, grantee: &str, add: bool, items: &[GrantItem]) {
        if items.is_empty() {
            self.block(NO_ITEMS);
            return;
        }
        if !self.grantee_ok(grantee) {
            return;
        }
        for item in items {
            self.grant_item(grantee, add, item);
        }
        if self.db.truncated && items.iter().any(|i| matches!(i.target, GrantTarget::AllTables { .. } | GrantTarget::AllSequences { .. })) {
            self.confirm(TRUNCATED);
        }
    }

    pub(super) fn grant_item(&mut self, grantee: &str, add: bool, item: &GrantItem) {
        let plan = self.plan_grant(grantee, add, item);
        for text in plan.blocks {
            self.block(text);
        }
        self.out.stays.extend(plan.stays);
        self.out.stays.sort();
        self.out.stays.dedup();
        if let Some(op) = plan.op {
            let Op::Privileges { add, on, privileges, grantee, .. } = &op else { return };
            let statement =
                if *add { sql_text::grant_privileges(privileges, &on.clause(), grantee) } else { sql_text::revoke_privileges(privileges, &on.clause(), grantee) };
            self.push(op, statement);
        }
    }

    /// 대상이 가리키는 객체들과 그 객체의 권한 종류. 스냅숏에 없으면 None
    fn locate(&self, target: &GrantTarget) -> Option<(PrivKind, Vec<ObjKey>)> {
        let in_schema = |schema: &str, pick: fn(RelKind) -> bool| -> Option<Vec<ObjKey>> {
            self.db.schemas.iter().any(|s| s.name == schema).then(|| {
                let mut keys: Vec<ObjKey> =
                    self.db.relations.iter().filter(|r| r.schema == schema && pick(r.kind)).map(|r| ObjKey::Relation(r.schema.clone(), r.name.clone())).collect();
                keys.sort();
                keys
            })
        };
        match target {
            GrantTarget::Database { name } => self.cluster.databases.iter().any(|d| &d.name == name).then(|| (PrivKind::Database, vec![ObjKey::Database(name.clone())])),
            GrantTarget::Schema { name } => self.db.schemas.iter().any(|s| &s.name == name).then(|| (PrivKind::Schema, vec![ObjKey::Schema(name.clone())])),
            GrantTarget::Relation { schema, name } => self
                .db
                .relations
                .iter()
                .any(|r| &r.schema == schema && &r.name == name && is_table_like(r.kind))
                .then(|| (PrivKind::Table, vec![ObjKey::Relation(schema.clone(), name.clone())])),
            GrantTarget::Sequence { schema, name } => self
                .db
                .relations
                .iter()
                .any(|r| &r.schema == schema && &r.name == name && r.kind == RelKind::Sequence)
                .then(|| (PrivKind::Sequence, vec![ObjKey::Relation(schema.clone(), name.clone())])),
            GrantTarget::Function { schema, name, signature } => self
                .db
                .functions
                .iter()
                .any(|f| &f.schema == schema && &f.name == name && &f.signature == signature)
                .then(|| (PrivKind::Function, vec![ObjKey::Function(schema.clone(), name.clone(), signature.clone())])),
            GrantTarget::AllTables { schema } => in_schema(schema, is_table_like).map(|keys| (PrivKind::Table, keys)),
            GrantTarget::AllSequences { schema } => in_schema(schema, |kind| kind == RelKind::Sequence).map(|keys| (PrivKind::Sequence, keys)),
        }
    }

    fn plan_grant(&self, grantee: &str, add: bool, item: &GrantItem) -> GrantPlan {
        let mut plan = GrantPlan { blocks: Vec::new(), op: None, stays: Vec::new() };
        let label = target_label(&item.target);
        if item.privileges.is_empty() {
            plan.blocks.push(NO_PRIVILEGES.to_string());
            return plan;
        }
        let Some((kind, keys)) = self.locate(&item.target) else {
            plan.blocks.push(format!("객체를 찾을 수 없어요: {label}"));
            return plan;
        };
        let privileges = sorted(&item.privileges);
        let wrong: Vec<&Privilege> = privileges.iter().filter(|&&p| !offers(kind, p, self.version())).collect();
        for p in &wrong {
            plan.blocks.push(format!("{label}에는 {} 권한이 없어요", p.as_str()));
        }
        if !wrong.is_empty() {
            return plan;
        }

        let rights = self.rights();
        let eval = Eval::new(&Ctx { cluster: &self.cluster, db: &self.db });
        let grantee_name = (grantee != "PUBLIC").then_some(grantee);
        let mut effects = Vec::new();
        let mut cannot: Vec<(String, String)> = Vec::new(); // (객체 이름표, 소유자)
        for key in &keys {
            let Some(obj) = lookup(&self.cluster, &self.db, key) else { continue };
            let grantor = rights.object_grantor(obj, &privileges).unwrap_or_else(|| {
                cannot.push((key.label(), obj.owner().to_string()));
                rights.login().to_string()
            });
            let acl = obj.acl();
            for &privilege in &privileges {
                let held = acl.iter().find(|e| e.grantor == grantor && e.grantee.as_deref() == grantee_name && e.privilege == privilege);
                if add {
                    if held.is_none() {
                        effects.push(AclEffect { object: key.clone(), privilege, grantor: grantor.clone() });
                    }
                    continue;
                }
                for other in acl.iter().filter(|e| e.grantor != grantor && e.grantee.as_deref() == grantee_name && e.privilege == privilege) {
                    plan.stays.push(format!("{} → {} {}", other.grantor, key.label(), privilege.as_str()));
                }
                if let Some(entry) = held {
                    effects.push(AclEffect { object: key.clone(), privilege, grantor: grantor.clone() });
                    if entry.grantable && self.loses_dependents(&eval, obj, entry) {
                        plan.blocks.push(format!(
                            "{} 역할이 {}의 {} 권한을 다른 역할에 다시 줬어요. 그 권한부터 빼야 해요",
                            grantee,
                            key.label(),
                            privilege.as_str()
                        ));
                    }
                }
            }
        }
        if !cannot.is_empty() {
            plan.blocks.push(grant_rights_text(add, &cannot, &privileges));
        }
        plan.stays.sort();
        plan.stays.dedup();
        plan.op = Some(Op::Privileges { add, on: on_target(&item.target), privileges, grantee: grantee.to_string(), effects });
        plan
    }

    /// 거두는 항목이 GRANT OPTION을 가졌고, 받은 쪽이 그 권한을 다른 역할에 다시 줬는데, 다른 길로도 GRANT OPTION을 갖지 못하는가.
    /// 서버는 이때 CASCADE 없이는 거두지 못한다(`aclupdate`와 `recursive_revoke`)
    fn loses_dependents(&self, eval: &Eval, obj: Obj, entry: &AclEntry) -> bool {
        let Some(holder) = entry.grantee.as_deref() else { return false };
        let (owner, acl) = (obj.owner(), obj.acl());
        if holder == owner || !acl.iter().any(|e| e.grantor == holder && e.privilege == entry.privilege) {
            return false;
        }
        let grantable = |e: &&AclEntry, who: Option<&str>| e.grantee.as_deref() == who && e.privilege == entry.privilege && e.grantable;
        let other_entry = acl.iter().any(|e| e.grantor != entry.grantor && (grantable(&e, Some(holder)) || grantable(&e, None)));
        let inherited = eval.privilege_order(holder).iter().skip(1).any(|r| r.role == owner || acl.iter().any(|e| grantable(&e, Some(&r.role))));
        !(other_entry || inherited)
    }

    // ───── 기본 권한 ─────

    pub(super) fn default_privilege(&mut self, creator: &str, schema: Option<&str>, object_type: DefaultObjType, grantee: &str, privileges: &[Privilege], add: bool) {
        if !(self.known_role(creator) && self.changeable(creator)) {
            return;
        }
        if let Some(schema) = schema {
            if object_type == DefaultObjType::Schemas {
                self.block(SCHEMAS_WITH_SCHEMA);
            } else if !self.db.schemas.iter().any(|s| s.name == schema) {
                self.block(format!("객체를 찾을 수 없어요: 스키마 {schema}"));
            }
        }
        if privileges.is_empty() {
            self.block(NO_PRIVILEGES);
            return;
        }
        let wrong: Vec<Privilege> = privileges.iter().copied().filter(|&p| !default_offers(object_type, p, self.version())).collect();
        for p in &wrong {
            self.block(format!("{}에는 {} 권한이 없어요", default_label(object_type), p.as_str()));
        }
        if !wrong.is_empty() || !self.grantee_ok(grantee) {
            return;
        }
        if let Err(text) = self.rights().defaults_for(creator) {
            self.block(text);
        }
        let privileges = sorted(privileges);
        let statement = sql_text::alter_default_privileges(creator, schema, add, &privileges, object_type, grantee);
        self.push(Op::DefaultAcl { creator: creator.into(), schema: schema.map(str::to_string), object_type, privileges, grantee: grantee.into(), add }, statement);
    }
}

fn on_target(target: &GrantTarget) -> OnTarget {
    match target {
        GrantTarget::Database { name } => OnTarget::Database(name.clone()),
        GrantTarget::Schema { name } => OnTarget::Schema(name.clone()),
        GrantTarget::Relation { schema, name } => OnTarget::Relation(schema.clone(), name.clone()),
        GrantTarget::Sequence { schema, name } => OnTarget::Sequence(schema.clone(), name.clone()),
        GrantTarget::Function { schema, name, signature } => OnTarget::Function(schema.clone(), name.clone(), signature.clone()),
        GrantTarget::AllTables { schema } => OnTarget::AllTables(schema.clone()),
        GrantTarget::AllSequences { schema } => OnTarget::AllSequences(schema.clone()),
    }
}

/// 줄 수 없는(뺄 수 없는) 객체들의 글. 하나면 그 객체와 소유자를, 여럿이면 개수와 처음 셋과 소유자들을 말한다
fn grant_rights_text(add: bool, cannot: &[(String, String)], privileges: &[Privilege]) -> String {
    let mut cannot = cannot.to_vec();
    cannot.sort();
    let (particle, verb) = if add { ("에", "줄") } else { ("에서", "뺄") };
    let list = privilege_list(privileges);
    match cannot.as_slice() {
        [(object, owner)] => format!("{object}{particle} {list} 권한을 {verb} 수 없어요. 소유자 {owner} 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요"),
        _ => {
            let sample: Vec<&str> = cannot.iter().take(3).map(|(object, _)| object.as_str()).collect();
            let owners: BTreeSet<&str> = cannot.iter().map(|(_, owner)| owner.as_str()).collect();
            format!(
                "객체 {}개{particle} {list} 권한을 {verb} 수 없어요(예: {}). 소유자({}) 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요",
                cannot.len(),
                sample.join(", "),
                owners.into_iter().collect::<Vec<_>>().join(", ")
            )
        }
    }
}
