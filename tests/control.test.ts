import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/control-secrets.json", import.meta.url));

function control(args: string[], env: Record<string, string> = {}) {
  return execute(process.execPath, ["--import", "tsx", "scripts/control.ts", ...args], {
    cwd: root,
    env: { ...process.env, ADMIN_TOKEN: "", AI_NEWS_SECRETS_FILE: fixture, ...env },
    timeout: 10_000
  });
}

async function mockWorker(run: (base: string, requests: Array<{ method: string | undefined; path: string | undefined; authorization: string | undefined; body: string }>) => Promise<void>) {
  const requests: Array<{ method: string | undefined; path: string | undefined; authorization: string | undefined; body: string }> = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("環境変数の ADMIN_TOKEN を優先してプレビューを要求する", async () => {
  await mockWorker(async (base, requests) => {
    const { stdout, stderr } = await control([base, "preview"], { ADMIN_TOKEN: "test-env-token", AI_NEWS_SECRETS_FILE: "/not-found.json" });
    assert.deepEqual(requests, [{ method: "POST", path: "/preview", authorization: "Bearer test-env-token", body: "" }]);
    assert.equal(JSON.parse(stdout).ok, true);
    assert.equal(stderr, "");
    assert.ok(!stdout.includes("test-env-token"));
  });
});

test("指定した JSON のトークンで配信履歴を取得する", async () => {
  await mockWorker(async (base, requests) => {
    await control([base, "status"]);
    assert.deepEqual(requests, [{ method: "GET", path: "/status", authorization: "Bearer test-admin-token-from-file", body: "" }]);
  });
});

test("未送信の確認結果を resolve に送る", async () => {
  await mockWorker(async (base, requests) => {
    await control([base, "resolve-not-sent", "https://example.org/article"]);
    assert.equal(requests[0].path, "/resolve");
    assert.equal(requests[0].method, "POST");
    assert.deepEqual(JSON.parse(requests[0].body), { url: "https://example.org/article", outcome: "not_sent" });
  });
});

test("秘密設定がない場合は外部通信前に止める", async () => {
  await assert.rejects(control(["https://example.org", "status"], { AI_NEWS_SECRETS_FILE: "/not-found.json" }), /秘密設定を読み込めません/);
  const empty = fileURLToPath(new URL("../.secrets.example.json", import.meta.url));
  await assert.rejects(control(["https://example.org", "status"], { AI_NEWS_SECRETS_FILE: empty }), /ADMIN_TOKEN が未設定/);
});

test("ローカル以外の HTTP URL にはトークンを送らない", async () => {
  await assert.rejects(control(["http://example.org", "status"], { ADMIN_TOKEN: "test-env-token" }), /HTTPS の Worker URL/);
});
