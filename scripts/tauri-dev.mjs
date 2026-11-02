// `npm run tauri:dev`: 워크트리마다 dev 앱을 동시에 띄울 수 있게 한다. dev 전용이고 릴리스 빌드와 `npm run tauri dev`는 그대로다.
// - 포트: 범위에서 비어 있는 포트를 무작위로 골라 vite와 앱을 그 포트로 띄운다. 범위는 DEV_PORT_RANGE(기본 1421-1499)로 바꾼다.
//   1420은 `npm run dev`(데모·스크린샷)와 `npm run tauri dev`가 그대로 쓰도록 비워 둔다.
// - 데이터 폴더: 앱 식별자를 워크트리마다 다르게 덮어써서 설정, 비용 캐시, IAM·DB 변경 기록을 워크트리마다 따로 둔다.
//   설치한 앱과 다른 워크트리의 파일을 덮어쓰지 않는다. 처음 한 번은 설치한 앱의 settings.json을 복사해 와서 프로필·즐겨찾기를 이어 쓴다.
//   식별자가 바뀌면 앱 크레이트만 다시 컴파일된다(같은 워크트리에서 `tauri dev`와 번갈아 쓸 때도).
// 뒤에 붙인 인자는 `tauri dev`에 넘긴다(예: `npm run tauri:dev -- --release`).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_ID = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).identifier;
const range = process.env.DEV_PORT_RANGE ?? "1421-1499";
const m = /^(\d+)-(\d+)$/.exec(range);
if (!m || Number(m[1]) > Number(m[2])) {
  console.error(`DEV_PORT_RANGE는 "1421-1499"처럼 적어야 해요: ${range}`);
  process.exit(1);
}
const [lo, hi] = [Number(m[1]), Number(m[2])];

/** 이 주소에서 포트를 열 수 있나. 그 주소 체계가 없는 기계(IPv6 없음)면 비어 있다고 본다 */
const freeOn = (port, host) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });

// vite는 localhost(macOS에서는 보통 ::1)에 열고 웹뷰도 localhost로 붙으니 IPv4와 IPv6가 모두 비어 있어야 한다
const free = async (port) => (await freeOn(port, "127.0.0.1")) && (await freeOn(port, "::1"));

const ports = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
for (let i = ports.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [ports[i], ports[j]] = [ports[j], ports[i]];
}
let port = null;
for (const p of ports) {
  if (await free(p)) {
    port = p;
    break;
  }
}
if (port === null) {
  console.error(`${range}에 빈 포트가 없어요. DEV_PORT_RANGE로 범위를 바꿔 주세요`);
  process.exit(1);
}

// 워크트리 폴더 이름 + 경로 해시(이름이 같은 워크트리끼리 겹치지 않게). 식별자에는 영문자, 숫자, `-`, `.`만 쓸 수 있다
const slug = path.basename(ROOT).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
const identifier = `${BASE_ID}.dev-${slug}-${createHash("sha256").update(ROOT).digest("hex").slice(0, 6)}`;
// macOS의 앱 데이터 폴더(Tauri app_data_dir)
const support = path.join(os.homedir(), "Library", "Application Support");
const dataDir = path.join(support, identifier);
const seed = path.join(support, BASE_ID, "settings.json");
if (!fs.existsSync(dataDir) && fs.existsSync(seed)) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(seed, path.join(dataDir, "settings.json"));
  console.log(`설치한 앱의 설정을 복사했어요: ${seed}`);
}

// 고른 뒤 vite가 열기 전에 다른 프로세스가 가져가면 vite의 strictPort가 바로 실패시킨다. 그때는 다시 실행하면 된다
const config = { identifier, build: { devUrl: `http://localhost:${port}`, beforeDevCommand: `npm run dev -- --port ${port}` } };
console.log(`dev 서버 포트: ${port}`);
console.log(`데이터 폴더: ${dataDir}`);
const child = spawn("npx", ["tauri", "dev", "--config", JSON.stringify(config), ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
// 터미널의 Ctrl+C는 자식에게도 바로 간다. 이 스크립트만 끝내는 신호(kill 등)는 넘겨서 vite와 앱이 남지 않게 한다
for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
