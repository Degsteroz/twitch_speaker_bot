#!/usr/bin/env node
// Local demo stand: real API + worker + dashboard + overlay without Docker, Twitch or Piper.
//
//   pnpm build && node scripts/demo.mjs
//
// - PostgreSQL 16 runs embedded (packages/testing dependency), data lives in a temp dir.
// - Login is faked: http://localhost:5175/login sets a session cookie for a seeded owner.
// - TTS uses macOS `say` (voice Milena) when available, otherwise a short beep.
// - Anthropic is faked unless ANTHROPIC_API_KEY is set (shell or root .env), then real Haiku is called.
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFrom = (pkg) => createRequire(join(root, pkg, "package.json"));
const EmbeddedPostgres = (
  await import(requireFrom("packages/testing").resolve("embedded-postgres"))
).default;
const apiRequire = requireFrom("services/api");
const postgres = (await import(apiRequire.resolve("postgres"))).default;
const { createSigner } = await import(
  createRequire(apiRequire.resolve("@fastify/jwt")).resolve("fast-jwt")
);

const PORTS = { pg: 54400, api: 3000, anthropic: 54401, tts: 54402, login: 5175 };
// Throwaway secrets for this run only; nothing sensitive is stored in the repository.
const SECRETS = {
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  AUDIO_SIGNING_SECRET: randomBytes(48).toString("base64url"),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex")
};
// Only the Anthropic key is taken from the git-ignored root .env, if present.
const rootEnv = join(root, ".env");
const anthropicKey =
  process.env.ANTHROPIC_API_KEY ||
  (existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, "utf8")).ANTHROPIC_API_KEY : undefined) ||
  undefined;
const log = (...args) => console.log("\x1b[36m[demo]\x1b[0m", ...args);
const children = [];
const servers = [];
const tempDir = mkdtempSync(join(tmpdir(), "roastbot-demo-"));

const cluster = new EmbeddedPostgres({
  databaseDir: join(tempDir, "pg"),
  port: PORTS.pg,
  user: "roast",
  password: "roast",
  persistent: false,
  onLog: () => undefined,
  onError: () => undefined
});

async function shutdown() {
  // Each service runs in its own process group so pnpm's vite grandchildren stop too.
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  for (const server of servers) server.close();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await cluster.stop().catch(() => undefined);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await cluster.initialise();
await cluster.start();
await cluster.createDatabase("roast");
const DATABASE_URL = `postgres://roast:roast@127.0.0.1:${PORTS.pg}/roast`;
execFileSync("node", [join(root, "packages/db/dist/migrate.js")], {
  env: { ...process.env, DATABASE_URL }
});
execFileSync("node", [join(root, "packages/db/dist/seed.js")], {
  env: { ...process.env, DATABASE_URL }
});

const sql = postgres(DATABASE_URL, { onnotice: () => undefined });
const [user] = await sql`insert into users(twitch_id,login,display_name,role)
  values('1','demo_streamer','DemoStreamer','owner') returning id`;
const [channel] = await sql`insert into channels(user_id,twitch_login,overlay_token)
  values(${user.id},'demo_streamer','demo-overlay-token') returning id`;
await sql`insert into settings(channel_id) values(${channel.id})`;
await sql`insert into subscriptions(user_id,plan_id) select ${user.id},id from plans where code='free'`;
await sql.end();
const sessionToken = createSigner({ key: SECRETS.SESSION_SECRET, expiresIn: 7 * 86_400_000 })({
  userId: user.id,
  channelId: channel.id,
  role: "owner"
});

// ---- fake Anthropic -------------------------------------------------------------------------
const useRealAnthropic = Boolean(anthropicKey);
if (!useRealAnthropic) {
  const lines = {
    tsundere: [
      "Хм, {v}, это была игра? Не то чтобы мне было интересно, но… ладно, чуть-чуть.",
      "{v}, твой аим — как мои чувства: где-то рядом, но точно не в цели.",
      "Б-бака, {v}! Я не болею за тебя. Просто смотрю. Случайно."
    ],
    yandere: [
      "{v}, я видела каждый твой промах… и запомнила их все. Навсегда.",
      "Ничего, {v}, проигрывай сколько хочешь. Я всё равно никуда тебя не отпущу.",
      "{v}, ты так мило ошибаешься. Я сохранила это себе. Тихонько."
    ]
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body);
      const data = String(payload.messages?.[0]?.content ?? "");
      const system = String(payload.system ?? "");
      const viewer = /<viewer>([^<]*)<\/viewer>/u.exec(data)?.[1] ?? "зритель";
      const tone = system.includes("яндэрэ") ? "yandere" : "tsundere";
      const pool = lines[tone];
      // Both calls carry a system prompt now; the classifier is the one that checks a <reply>.
      const text = data.startsWith("<reply>")
        ? "ALLOW"
        : pool[Math.floor(Math.random() * pool.length)].replace("{v}", viewer);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "msg_demo",
          type: "message",
          role: "assistant",
          model: payload.model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 420, output_tokens: 45 }
        })
      );
    });
  }).listen(PORTS.anthropic);
  servers.push(server);
}

// ---- TTS stand-in ---------------------------------------------------------------------------
function beepWav() {
  const rate = 22050;
  const samples = Math.floor(rate * 0.6);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const hasSay = process.platform === "darwin";
const tts = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    if (request.url === "/health") return response.end('{"ok":true}');
    const { text, voice } = JSON.parse(body);
    const send = (wav) => {
      response.setHeader("content-type", "audio/wav");
      response.end(wav);
    };
    if (!hasSay) return send(beepWav());
    const out = join(tempDir, `say-${Date.now()}.wav`);
    // `say` has one Russian voice; a lower pitch base stands in for the male voice.
    const spoken = voice === "male" ? `[[pbas 28]] ${text}` : text;
    execFile("say", ["-v", "Milena", "-o", out, "--data-format=LEI16@22050", spoken], (error) => {
      if (error) return send(beepWav());
      send(readFileSync(out));
      rmSync(out, { force: true });
    });
  });
}).listen(PORTS.tts);
servers.push(tts);

// ---- fake login: cookies are shared across ports on localhost --------------------------------
const login = createServer((_request, response) => {
  response.writeHead(302, {
    "set-cookie": `roastbot_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    location: "http://localhost:5173/"
  });
  response.end();
}).listen(PORTS.login);
servers.push(login);

// ---- services ---------------------------------------------------------------------------------
const audioDir = join(tempDir, "audio");
const start = (name, command, args, env, cwd = root) => {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { ...process.env, ...SECRETS, DATABASE_URL, ...env }
  });
  const prefix = `\x1b[90m[${name}]\x1b[0m `;
  const relay = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      // Keep the terminal readable: only worker outcomes and anything that looks like an error.
      if (
        name === "worker"
          ? !line.includes("roast.processed") && !/error/iu.test(line)
          : !/error/iu.test(line)
      )
        continue;
      console.log(prefix + line);
    }
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  child.on("exit", (code) => code && log(`${name} exited with ${code}`));
  children.push(child);
};
start("api", "node", [join(root, "services/api/dist/index.js")], {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: String(PORTS.api),
  PUBLIC_URL: `http://localhost:${PORTS.api}`,
  DASHBOARD_URL: "http://localhost:5173",
  TWITCH_CLIENT_ID: "demo",
  TWITCH_CLIENT_SECRET: "demo",
  TWITCH_REDIRECT_URI: `http://localhost:${PORTS.api}/auth/twitch/callback`,
  AUDIO_DIR: audioDir
});
start("worker", "node", [join(root, "services/worker/dist/index.js")], {
  ANTHROPIC_API_KEY: anthropicKey ?? "demo",
  ...(useRealAnthropic ? {} : { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORTS.anthropic}` }),
  TTS_URL: `http://127.0.0.1:${PORTS.tts}`,
  AUDIO_DIR: audioDir
});
start("web", "pnpm", ["--filter", "@roastbot/web", "dev", "--strictPort"], {});
start("overlay", "pnpm", ["--filter", "@roastbot/overlay", "dev", "--strictPort"], {});

for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORTS.api}/ready`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.log(`
\x1b[1mRoastBot demo is running\x1b[0m  (Ctrl+C to stop)

  1. Войти (без Twitch):  http://localhost:${PORTS.login}/login
  2. Панель стримера:     http://localhost:5173/
     Админка:             http://localhost:5173/admin
  3. Оверлей (как в OBS): http://localhost:5174/overlay/?token=demo-overlay-token
     Откройте его во второй вкладке и кликните по странице один раз — браузер
     разрешит автозапуск звука. Затем нажмите «Запустить тест» в панели.

  Генерация: ${useRealAnthropic ? "настоящий Anthropic (ANTHROPIC_API_KEY)" : "фейковые ответы (export ANTHROPIC_API_KEY=… для настоящего Haiku)"}
  Голос:     ${hasSay ? "macOS say / Milena (вместо Piper)" : "звуковой сигнал (вместо Piper)"}
  Twitch-чат и награды в демо не подключены.
`);
