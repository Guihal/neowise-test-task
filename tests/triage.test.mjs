import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createTriageServer } from "../server.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(projectDir, "server.mjs");

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const TOPICS = ["delivery", "pricing", "other"];

async function reservePort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server did not start on ${url}`);
}

async function postRaw(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    parsed = null;
  }
  return { statusCode: response.status, body: parsed };
}

function triage(baseUrl, text) {
  return postRaw(baseUrl, JSON.stringify({ text }));
}

async function startInjected(classify) {
  const server = createTriageServer({ classify });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server) {
  server.close();
  await once(server, "close");
}

// --- Настоящий процесс запущен так же, как в README ------------------------

let childProcess;
let baseUrl;

before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  childProcess = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Строки manual_review — ожидаемый вывод сценариев сбоя.
  childProcess.stderr.resume();
  await waitForServer(`${baseUrl}/`);
});

after(() => {
  childProcess?.kill();
});

test("обычный текст возвращает готовую тему и непустой черновик", async () => {
  const { statusCode, body } = await triage(baseUrl, "Здравствуйте! Сколько стоит доставка?");
  assert.equal(statusCode, 200);
  assert.equal(body.status, "ready");
  assert.ok(TOPICS.includes(body.topic), `topic=${body.topic}`);
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim().length > 0);
});

test("[timeout] укладывается в лимит ожидания и уходит в ручной разбор", async () => {
  const startedAt = Date.now();
  const { statusCode, body } = await triage(baseUrl, "[timeout] проверка таймаута");
  const elapsedMs = Date.now() - startedAt;

  assert.equal(statusCode, 200);
  assert.deepEqual(body, MANUAL_REVIEW);
  assert.ok(elapsedMs < 700, `ответ пришёл за ${elapsedMs} мс`);
});

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`${marker} уходит в ручной разбор`, async () => {
    const { statusCode, body } = await triage(baseUrl, `${marker} проверка сбоя`);
    assert.equal(statusCode, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
}

for (const marker of ["[timeout] [error]", "[bad-json] [bad-topic]", "[bad-topic] [empty-draft]"]) {
  test(`комбинированные метки ${marker} не меняют контракт`, async () => {
    const { statusCode, body } = await triage(baseUrl, `${marker} проверка`);
    assert.equal(statusCode, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
}

test("пустая и пробельная строка отклоняются как invalid_input", async () => {
  for (const text of ["", "   \n\t"]) {
    const { statusCode, body } = await triage(baseUrl, text);
    assert.equal(statusCode, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  }
});

test("отсутствующее поле text отклоняется как invalid_input", async () => {
  const { statusCode, body } = await postRaw(baseUrl, JSON.stringify({ message: "привет" }));
  assert.equal(statusCode, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("нестроковый text отклоняется как invalid_input", async () => {
  const { statusCode, body } = await triage(baseUrl, 42);
  assert.equal(statusCode, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("битый JSON отклоняется как invalid_input", async () => {
  const { statusCode, body } = await postRaw(baseUrl, "{not json");
  assert.equal(statusCode, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

for (const payload of [null, [], "x", 5]) {
  test(`JSON-нагрузка ${JSON.stringify(payload)} отклоняется как invalid_input`, async () => {
    const { statusCode, body } = await postRaw(baseUrl, JSON.stringify(payload));
    assert.equal(statusCode, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });
}

test("слишком большое тело отклоняется и не ломает следующий запрос", async () => {
  const oversizedBody = JSON.stringify({ text: "x".repeat(64 * 1024) });
  const oversized = await postRaw(baseUrl, oversizedBody);
  assert.equal(oversized.statusCode, 400);
  assert.deepEqual(oversized.body, { status: "invalid_input" });

  const next = await triage(baseUrl, "Сколько стоит доставка?");
  assert.equal(next.statusCode, 200);
  assert.equal(next.body.status, "ready");
});

test("параллельные запросы получают каждый свой статус", async () => {
  const [readyResult, timeoutResult] = await Promise.all([
    triage(baseUrl, "Сколько стоит доставка?"),
    triage(baseUrl, "[timeout] параллельная проверка"),
  ]);

  assert.equal(readyResult.statusCode, 200);
  assert.equal(readyResult.body.status, "ready");
  assert.deepEqual(timeoutResult.body, MANUAL_REVIEW);
});

// --- Классификатор внедрён напрямую ---------------------------------------

test("жёсткий таймаут не зависит от готовности провайдера отменяться", async () => {
  let calls = 0;
  // Игнорирует AbortSignal и отвечает заметно позже бюджета сервера.
  const slowClassify = () => {
    calls += 1;
    return new Promise((resolve) => {
      setTimeout(() => resolve(JSON.stringify({ topic: "other", draft: "поздний ответ" })), 1200);
    });
  };
  const injected = await startInjected(slowClassify);
  try {
    const startedAt = Date.now();
    const result = await postRaw(injected.baseUrl, JSON.stringify({ text: "медленный провайдер" }));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, MANUAL_REVIEW);
    assert.ok(elapsedMs < 700, `ответ пришёл за ${elapsedMs} мс`);
    assert.equal(calls, 1);

    // Поздний ответ приходит уже после таймаута — второй записи быть не должно.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls, 1);

    const pageResponse = await fetch(`${injected.baseUrl}/`);
    assert.equal(pageResponse.status, 200);
  } finally {
    await stopServer(injected.server);
  }
});

