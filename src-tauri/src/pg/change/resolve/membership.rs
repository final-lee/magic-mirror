//! 구성원 관계 변경(`GRANT role TO`, `REVOKE role FROM`)을 푸는 일

use super::*;

impl Resolver<'_> {
    pub(super) fn membership(&mut self, group: &str, member: &str, add: bool, admin: bool) {
        let group_ok = self.known_role(group);
        let member_ok = self.known_role(member);
        if !(group_ok && member_ok) {
            return;
        }
        if add {
            self.join(group, member, admin);
        } else {
            self.leave(group, member, admin);
        }
    }

    /// 그룹의 구성원 관계를 바꿀 수 있는 역할인가(시스템 그룹은 열린 것만)
    pub(super) fn group_open(&mut self, group: &str) -> bool {
        if is_system_role(group) && !OPEN_SYSTEM_GROUPS.contains(&group) {
            self.block(format!("이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: {group}"));
            return false;
        }
        true
    }

    pub(super) fn join(&mut self, group: &str, member: &str, admin: bool) {
        if !(self.known_role(group) && self.known_role(member) && self.group_open(group) && self.changeable(member)) {
            return;
        }
        let grantor = match self.rights().membership_grantor(group) {
            Ok(grantor) => grantor,
            Err(text) => {
                self.block(text);
                self.login()
            }
        };
        let pair = self.cluster.members.iter().find(|m| m.group == group && m.member == member);
        let done = pair.is_some_and(|pair| {
            if self.version() >= MEMBERSHIP_OPTIONS_SINCE {
                pair.grants.iter().any(|g| g.grantor == grantor && (!admin || g.admin))
            } else {
                !admin || pair.admin
            }
        });
        if done {
            return;
        }
        self.push(Op::GrantRole { group: group.into(), member: member.into(), admin, grantor }, sql_text::grant_role(group, member, admin, false));
    }

    pub(super) fn leave(&mut self, group: &str, member: &str, admin_only: bool) {
        if !(self.group_open(group) && self.changeable(member)) {
            return;
        }
        if let Err(text) = self.rights().membership_authorization(group) {
            self.block(text);
        }
        let revocations = self.rights().revocations(group, member, admin_only);
        if revocations.rows.is_empty() && !revocations.remaining.is_empty() {
            self.block(format!("{member} 역할을 {group} 역할에서 뺄 수 없어요. 이 구성원 관계는 {} 역할이 줬어요", revocations.remaining.join(", ")));
            return;
        }
        if revocations.rows.is_empty() {
            return;
        }
        for grantor in &revocations.remaining {
            if !self.out.memberships_stay.contains(grantor) {
                self.out.memberships_stay.push(grantor.clone());
            }
        }
        let from_16 = self.version() >= MEMBERSHIP_OPTIONS_SINCE;
        if from_16 {
            for grantor in &revocations.rows {
                if self.dependent_membership(group, member, grantor, &revocations.rows) {
                    self.block(format!("{member} 역할이 {group} 역할을 다른 역할에 줬어요. 그 구성원 관계부터 빼야 해요"));
                }
            }
        }
        for grantor in revocations.rows {
            let (granted_by, row_grantor) = if from_16 {
                (Some(grantor.clone()), grantor)
            } else {
                let first = self.cluster.members.iter().find(|m| m.group == group && m.member == member).and_then(|m| m.grants.first());
                (None, first.map(|g| g.grantor.clone()).unwrap_or_default())
            };
            let statement = sql_text::revoke_role(group, member, admin_only, granted_by.as_deref());
            self.push(Op::RevokeRole { group: group.into(), member: member.into(), admin_only, granted_by, row_grantor }, statement);
        }
    }

    /// `member`가 `group`에서 `grantor`가 준 부여를 잃으면, `member`가 준 다른 부여가 근거를 잃는가(서버는 의존하는 부여가 있으면 거둘 수 없다).
    /// 거두는 부여에 ADMIN이 있고, `member`가 같은 그룹의 다른 부여를 준 부여자이고, `member`에게 남는 ADMIN 부여가 없을 때다.
    /// 같은 변경이 함께 거두는 부여(`revoked`, 부여자들)는 남지 않는다: 서버는 문장마다 하나씩 거두니 마지막 문장이 걸린다
    fn dependent_membership(&self, group: &str, member: &str, grantor: &str, revoked: &[String]) -> bool {
        let rows = |m: &&MemberRec| m.group == group;
        let removed_admin = self.cluster.members.iter().filter(rows).any(|m| m.member == member && m.grants.iter().any(|g| g.grantor == grantor && g.admin));
        let grants_others = self.cluster.members.iter().filter(rows).any(|m| m.grants.iter().any(|g| g.grantor == member));
        let keeps_admin = self.cluster.members.iter().filter(rows).any(|m| m.member == member && m.grants.iter().any(|g| !revoked.contains(&g.grantor) && g.admin));
        removed_admin && grants_others && !keeps_admin
    }
}
