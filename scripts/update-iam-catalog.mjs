// IAM 작업 카탈로그(src-tauri/src/iam/catalog.json)를 AWS Service Reference에서 다시 만든다.
// 사용: node scripts/update-iam-catalog.mjs   (Node 20 이상, 외부 의존성 없음, 네트워크 필요)
//
// 출력은 공백 없는 JSON 한 줄이다:
//   {"generated":"YYYY-MM-DD","services":{"<prefix>":{"name":"<서비스 이름>","actions":{"<Action>":"l|r|w|p|t"}}}}
// 접근 수준 코드: p 권한 관리, t 태그, w 쓰기, l 목록, r 읽기. Annotations.Properties를 이 순서로 본다.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_URL = "https://servicereference.us-east-1.amazonaws.com/";
const OUT = fileURLToPath(new URL("../src-tauri/src/iam/catalog.json", import.meta.url));
const CONCURRENCY = 16;
const ATTEMPTS = 5;
const TIMEOUT_MS = 30_000;
/** 이보다 서비스가 적으면 응답 형식이 바뀐 것으로 보고 파일을 쓰지 않는다. */
const MIN_SERVICES = 300;
/** 형식이 바뀌어도 조용히 틀린 카탈로그가 만들어지지 않도록 확인하는 대표 작업. */
const SAMPLES = [
  ["s3", "GetObject", "r"],
  ["s3", "ListBucket", "l"],
  ["s3", "PutObject", "w"],
  ["iam", "AttachUserPolicy", "p"],
  ["ec2", "CreateTags", "t"],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON을 받아 온다. 일시적인 오류(네트워크, 429, 5xx)는 늘려 가며 다시 시도하고, 그 밖의 4xx는 바로 포기한다. */
async function getJson(url) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    if (attempt < ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  throw new Error(`${url}: ${last?.message ?? last}`);
}

/** 동시에 `limit`개까지 실행하고 입력 순서대로 결과를 돌려준다. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function levelCode(props = {}) {
  if (props.IsPermissionManagement) return "p";
  if (props.IsTaggingOnly) return "t";
  if (props.IsWrite) return "w";
  if (props.IsList) return "l";
  return "r";
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 서비스 JSON 하나를 `{ name, actions }`로 줄인다. IAM 작업 이름은 대소문자를 구분하지 않으므로 겹치면 처음 것만 둔다. */
function toService(prefix, doc, warnings) {
  const actions = {};
  const seen = new Map();
  for (const action of doc.Actions ?? []) {
    const lower = action.Name.toLowerCase();
    if (seen.has(lower)) {
      warnings.push(`${prefix}:${action.Name} 는 ${prefix}:${seen.get(lower)} 와 이름이 같아 건너뛰었어요`);
      continue;
    }
    seen.set(lower, action.Name);
    actions[action.Name] = levelCode(action.Annotations?.Properties);
  }
  const sorted = {};
  for (const name of Object.keys(actions).sort(byCodeUnit)) sorted[name] = actions[name];
  return { name: doc.ServiceName || prefix, actions: sorted };
}

const index = await getJson(INDEX_URL);
if (!Array.isArray(index) || index.some((e) => typeof e?.service !== "string" || typeof e?.url !== "string")) {
  throw new Error("서비스 목록 형식이 달라요. 응답은 {service, url} 배열이어야 해요.");
}
console.log(`서비스 ${index.length}개를 내려받아요 (동시 ${CONCURRENCY}개)…`);

const failures = [];
const docs = await mapPool(index, CONCURRENCY, async (entry) => {
  try {
    return await getJson(entry.url);
  } catch (e) {
    failures.push(e.message);
    return null;
  }
});
if (failures.length > 0) {
  console.error(`내려받지 못한 서비스가 ${failures.length}개 있어요. 파일을 쓰지 않았어요.`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

const warnings = [];
const services = {};
index.forEach((entry, i) => {
  const prefix = docs[i].Name || entry.service;
  if (prefix in services) {
    warnings.push(`서비스 ${prefix} 가 두 번 나와 처음 것만 썼어요`);
    return;
  }
  services[prefix] = toService(prefix, docs[i], warnings);
});
const sortedServices = {};
for (const prefix of Object.keys(services).sort(byCodeUnit)) sortedServices[prefix] = services[prefix];

if (Object.keys(sortedServices).length < MIN_SERVICES) {
  throw new Error(`서비스가 ${Object.keys(sortedServices).length}개뿐이에요. 응답 형식을 확인하세요. 파일을 쓰지 않았어요.`);
}
for (const [prefix, action, code] of SAMPLES) {
  const got = sortedServices[prefix]?.actions[action];
  if (got !== code) {
    throw new Error(`${prefix}:${action} 의 접근 수준이 ${got ?? "없음"} 이에요(기대: ${code}). 응답 형식을 확인하세요. 파일을 쓰지 않았어요.`);
  }
}

const catalog = { generated: new Date().toISOString().slice(0, 10), services: sortedServices };
const json = JSON.stringify(catalog);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(`${OUT}.tmp`, json);
await rename(`${OUT}.tmp`, OUT);

const counts = { l: 0, r: 0, w: 0, p: 0, t: 0 };
for (const svc of Object.values(sortedServices)) for (const code of Object.values(svc.actions)) counts[code]++;
const total = Object.values(counts).reduce((a, b) => a + b, 0);
for (const w of warnings) console.warn(`경고: ${w}`);
console.log(`서비스 ${Object.keys(sortedServices).length}개, 작업 ${total}개, ${Buffer.byteLength(json)} 바이트`);
console.log(`수준별: 목록 ${counts.l}, 읽기 ${counts.r}, 쓰기 ${counts.w}, 권한 관리 ${counts.p}, 태그 ${counts.t}`);
console.log(`저장: ${OUT}`);
