import { COVERAGE_LABEL, OBJECT_KIND_LABEL, ROLE_KIND_LABEL, objectName, unusableText } from "./labels";
import { customersTable, object, ordersIdSeq, touchOrderFn } from "./fixtures";

test("role kinds read as 사용자 and 그룹", () => {
  expect(ROLE_KIND_LABEL).toEqual({ user: "사용자", group: "그룹" });
});

test("every kind of object has a Korean name", () => {
  expect(OBJECT_KIND_LABEL).toEqual({
    database: "데이터베이스",
    schema: "스키마",
    table: "테이블",
    view: "뷰",
    matview: "구체화 뷰",
    partitioned: "파티션 테이블",
    foreign: "외부 테이블",
    sequence: "시퀀스",
    function: "함수",
  });
});

test("table coverage reads as 모든 테이블, 일부 테이블 or 없음", () => {
  expect(COVERAGE_LABEL).toEqual({ all: "모든 테이블", some: "일부 테이블", none: "없음" });
});

test("an unusable privilege says why it cannot be used", () => {
  expect(unusableText("CONNECT 없음")).toBe("권한은 있지만 실제로는 못 써요 (CONNECT 없음)");
  expect(unusableText("USAGE 없음")).toBe("권한은 있지만 실제로는 못 써요 (USAGE 없음)");
});

describe("objectName", () => {
  test("relations and sequences are schema.name", () => {
    expect(objectName(customersTable)).toBe("app.customers");
    expect(objectName(ordersIdSeq)).toBe("app.orders_id_seq");
  });

  test("a function carries its arguments, also when it has none", () => {
    expect(objectName(touchOrderFn)).toBe("app.touch_order(order_id integer)");
    expect(objectName(object("function", "app", "now_utc", ""))).toBe("app.now_utc()");
  });

  test("a database and a schema are just their name, whether or not the schema is repeated", () => {
    expect(objectName(object("database", null, "orders"))).toBe("orders");
    expect(objectName(object("schema", null, "app"))).toBe("app");
    expect(objectName(object("schema", "app", "app"))).toBe("app");
  });

  test("an object without a schema is its name", () => {
    expect(objectName(object("table", null, "orphan"))).toBe("orphan");
  });
});
