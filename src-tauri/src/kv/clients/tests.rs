use super::*;

const LIST: &str = "id=3 addr=10.0.0.5:50612 laddr=10.0.1.1:6379 fd=8 name= age=120 idle=0 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=26 qbuf-free=20448 argv-mem=10 obl=0 oll=0 omem=0 tot-mem=22298 events=r cmd=client|list user=default redir=-1\nid=9 addr=10.0.0.6:50700 laddr=10.0.1.1:6379 fd=9 name=bull:cXVldWU= age=3600 idle=2 flags=b db=1 cmd=bzpopmin user=app redir=-1\n";

#[test]
fn client_lines_are_read_field_by_field() {
    let own: HashSet<String> = ["3".to_string()].into();
    let clients = parse("n1:6379", LIST, &own);
    assert_eq!(clients.len(), 2);
    assert_eq!(
        clients[0],
        KvClient {
            node: "n1:6379".into(),
            id: "3".into(),
            addr: "10.0.0.5:50612".into(),
            name: String::new(),
            user: "default".into(),
            db: 0,
            age: 120,
            idle: 0,
            cmd: "client|list".into(),
            flags: "N".into(),
            own: true,
        }
    );
    assert_eq!((clients[1].name.as_str(), clients[1].db, clients[1].idle, clients[1].flags.as_str(), clients[1].own), ("bull:cXVldWU=", 1, 2, "b", false));
}

#[test]
fn ids_are_per_node_so_own_connections_are_matched_by_the_nodes_own_ids() {
    let only_other: HashSet<String> = ["9".to_string()].into();
    let clients = parse("n2:6379", LIST, &only_other);
    assert_eq!(clients.iter().filter(|c| c.own).map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["9"]);
}

#[test]
fn blank_lines_and_missing_fields_do_not_break_the_list() {
    let clients = parse("n", "\n  \nid=1 addr=a\n", &HashSet::new());
    assert_eq!(clients.len(), 1);
    assert_eq!((clients[0].age, clients[0].cmd.as_str()), (0, ""));
}
