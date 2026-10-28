use super::*;

// ───────────────────────── 객체 검색 ─────────────────────────

/// 검색 결과를 (종류, 사람이 읽는 이름)으로 줄여 본다
fn found(scene: &Scene, query: &str) -> Vec<(PgObjectKind, String)> {
    search_objects(&scene.cluster, &scene.db, query)
        .into_iter()
        .map(|o| {
            let qualified = match (&o.schema, o.kind) {
                (Some(schema), _) => format!("{schema}.{}", o.name),
                (None, _) => o.name.clone(),
            };
            (o.kind, o.signature.map_or(qualified.clone(), |signature| format!("{qualified}({signature})")))
        })
        .collect()
}

fn search_scene() -> Scene {
    let mut scene = app_scene(PG16);
    scene.cluster.databases.push(database("orders_archive", "app_owner"));
    scene
}

#[test]
fn search_is_a_case_insensitive_substring_of_schema_dot_name_and_of_the_name_for_databases_and_schemas() {
    let scene = search_scene();
    use PgObjectKind::*;
    assert_eq!(
        found(&scene, "ORD"),
        [
            (Database, "orders_archive".into()),
            (Matview, "app.order_summary".into()),
            (View, "app.order_totals".into()),
            (Table, "app.orders".into()),
        ]
    );
    // 스키마와 이름 사이의 점을 넘어 맞춘다
    assert_eq!(found(&scene, "app.ord").len(), 3);
    assert_eq!(found(&scene, "p.cust"), [(Table, "app.customers".into())]);
    // 데이터베이스와 스키마는 이름만 본다: "appdb"에서 점은 없다
    assert_eq!(found(&scene, "b.")[..], []);
    assert_eq!(found(&scene, "nothing like this"), []);
}

#[test]
fn search_sorts_databases_then_schemas_then_relations_then_functions_each_by_name() {
    let scene = search_scene();
    use PgObjectKind::*;
    assert_eq!(
        found(&scene, "app"),
        [
            (Database, "appdb".into()),
            (Schema, "app".into()),
            (Table, "app.customers".into()),
            (Matview, "app.order_summary".into()),
            (View, "app.order_totals".into()),
            (Table, "app.orders".into()),
            (Sequence, "app.ticket_seq".into()),
            (Function, "app.plain(a integer, b text)".into()),
            (Function, "app.touch(order_id integer)".into()),
        ]
    );
    // 함수는 인자 목록을 함께 돌려주고, 관계에는 인자 목록이 없다
    let results = search_objects(&scene.cluster, &scene.db, "touch");
    assert_eq!(results.len(), 1);
    assert_eq!((results[0].kind, results[0].schema.as_deref(), results[0].name.as_str(), results[0].signature.as_deref()), (Function, Some("app"), "touch", Some("order_id integer")));
    let orders = &search_objects(&scene.cluster, &scene.db, "app.orders")[0];
    assert_eq!((orders.kind, orders.schema.as_deref(), orders.signature.as_deref()), (Table, Some("app"), None));
    // 스키마와 데이터베이스는 스키마 칸이 비어 있다
    let schema = &search_objects(&scene.cluster, &scene.db, "scratch")[0];
    assert_eq!((schema.kind, schema.schema.as_deref(), schema.name.as_str()), (Schema, None, "scratch"));
}

#[test]
fn search_returns_at_most_100_results_and_the_databases_come_first() {
    let mut scene = search_scene();
    scene.db.relations = (0..150).map(|i| table("app", &format!("hit_{i:03}"), "app_owner")).collect();
    scene.db.relations.reverse();
    scene.cluster.databases.push(database("hit_db", "app_owner"));
    let results = found(&scene, "hit");
    assert_eq!(results.len(), 100);
    assert_eq!(results[0], (PgObjectKind::Database, "hit_db".into()));
    // 이름순의 앞쪽만 남는다(스냅숏의 순서와 상관없다)
    assert_eq!(results[1], (PgObjectKind::Table, "app.hit_000".into()));
    assert_eq!(results[99], (PgObjectKind::Table, "app.hit_098".into()));
}

#[test]
fn an_empty_query_returns_the_first_100_objects_in_the_same_order() {
    let scene = search_scene();
    use PgObjectKind::*;
    let all = found(&scene, "");
    // 데이터베이스 둘, 스키마 셋, 관계 일곱, 함수 둘
    assert_eq!(all.len(), 2 + 3 + 7 + 2);
    assert_eq!(all.iter().map(|(k, _)| *k).collect::<Vec<_>>()[..5], [Database, Database, Schema, Schema, Schema]);
    assert_eq!(all[0].1, "appdb");
    assert_eq!(all[1].1, "orders_archive");
    assert_eq!(all[2].1, "app");
    assert_eq!(all.last().map(|(k, _)| *k), Some(Function));

    let mut big = search_scene();
    big.db.relations = (0..300).map(|i| table("app", &format!("t{i:03}"), "app_owner")).collect();
    let first = found(&big, "");
    assert_eq!(first.len(), 100);
    assert_eq!(first[5], (Table, "app.t000".into()), "데이터베이스 둘과 스키마 셋 다음에 관계가 이름순으로 온다");
    assert_eq!(first[99], (Table, "app.t094".into()));
}
