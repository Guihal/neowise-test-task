import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as defaultClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;

// Request bodies are untrusted input: memory stays bounded per connection.
export const MAX_BODY_BYTES = 16 * 1024;

// An oversized upload is drained only this far before the socket is dropped,
// so one client cannot keep a connection open forever.
const MAX_DRAIN_BYTES = MAX_BODY_BYTES * 64;

const TOPICS = new Set(["delivery", "pricing", "other"]);

const html = await readFile(new URL("./index.html", import.meta.url));

class BodyTooLargeError extends Error {}
class TimeoutError extends Error {}

function canWrite(response) {
  return !response.writableEnded && !response.destroyed;
}

function json(response, status, body, headers = {}) {
  if (!canWrite(response)) return false;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
  return true;
}

function invalidInput(response, headers) {
  return json(response, 400, { status: "invalid_input" }, headers);
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

// Reads the body with a hard memory bound. Chunks past the limit are dropped
// instead of buffered; the socket is destroyed only for absurd uploads.
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (!oversized && size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      oversized = true;
      if (size > MAX_DRAIN_BYTES) {
        fail(new BodyTooLargeError());
        request.destroy();
      }
    });

    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (oversized) reject(new BodyTooLargeError());
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", fail);
    request.on("aborted", () => fail(new Error("request aborted")));
  });
}

// The request payload is untrusted input: only a JSON object with a non-empty
// string `text` is accepted; everything else is invalid input.
function parseText(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const text = payload.text;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

// The model answer is untrusted input too: only a known topic and a non-empty
// draft are accepted; everything else goes to manual review.
function parseModelAnswer(raw) {
  const answer = JSON.parse(raw);
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new Error("model answer is not an object");
  }
  if (!TOPICS.has(answer.topic)) throw new Error(`unexpected topic: ${answer.topic}`);
  if (typeof answer.draft !== "string" || answer.draft.trim() === "") throw new Error("empty draft");
  return { topic: answer.topic, draft: answer.draft };
}

// A provider may ignore AbortSignal entirely, so the budget is enforced here by
// racing the classifier against a deadline instead of trusting it to stop.
function classifyWithDeadline(classifyFn, text, controller) {
  let timer;
  const deadline = new Promise((_, rejectDeadline) => {
    timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new TimeoutError(`model did not answer within ${MODEL_TIMEOUT_MS} ms`));
    }, MODEL_TIMEOUT_MS);
  });
  const answer = Promise.resolve().then(() => classifyFn(text, { signal: controller.signal }));
  // Promise.race keeps the losing promise handled, so a late rejection after the
  // deadline cannot surface as an unhandled rejection.
  return Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
}

async function handleTriage(request, response, classifyFn) {
  let text;
  try {
    text = parseText(await readBody(request));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      // Close the connection so an oversized attempt cannot poison keep-alive.
      invalidInput(response, { Connection: "close" });
      response.once("finish", () => request.destroy());
      return undefined;
    }
    return invalidInput(response);
  }
  if (text === null) return invalidInput(response);

  const controller = new AbortController();
  try {
    const answer = parseModelAnswer(await classifyWithDeadline(classifyFn, text, controller));
    json(response, 200, { status: "ready", ...answer });
  } catch (error) {
    console.error(`triage manual_review: ${error?.name ?? "Error"}: ${error?.message ?? error}`);
    manualReview(response);
  }
}

export function createTriageServer({ classify = defaultClassify } = {}) {
  return createServer(async (request, response) => {
    // A client may vanish mid-flight; writing then must not crash the process.
    request.on("error", () => {});
    response.on("error", () => {});

    if (request.method === "GET" && request.url === "/") {
      if (!canWrite(response)) return undefined;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return undefined;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, classify);
    } catch (error) {
      console.error(`triage server_error: ${error?.message ?? error}`);
      json(response, 500, { status: "server_error" });
    }
    return undefined;
  });
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  createTriageServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
