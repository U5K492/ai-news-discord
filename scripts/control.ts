import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";

const [base, action, articleUrl] = process.argv.slice(2);
if (!base || !["preview", "run", "status", "resolve-sent", "resolve-not-sent"].includes(action)) throw new Error("Worker URL と preview / run / status / resolve-sent / resolve-not-sent を指定してください");
const resolve = action.startsWith("resolve-");
if (resolve && !articleUrl) throw new Error("確認結果を記録する記事 URL を指定してください");
const endpoint = new URL(`/${resolve ? "resolve" : action}`, base);
if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") throw new Error("HTTPS の Worker URL を指定してください");
let token = process.env.ADMIN_TOKEN;
if (!token) {
  const path = process.env.AI_NEWS_SECRETS_FILE ?? new NodeURL("../.secrets.json", import.meta.url);
  let secrets: { ADMIN_TOKEN?: unknown };
  try {
    secrets = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("秘密設定を読み込めません。.secrets.json または AI_NEWS_SECRETS_FILE を確認してください");
  }
  if (!secrets || typeof secrets.ADMIN_TOKEN !== "string" || !secrets.ADMIN_TOKEN.trim()) throw new Error("ADMIN_TOKEN が未設定です");
  token = secrets.ADMIN_TOKEN;
}
let response: Response;
try {
  response = await fetch(endpoint, { method: action === "status" ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: resolve ? JSON.stringify({ url: articleUrl, outcome: action === "resolve-sent" ? "sent" : "not_sent" }) : undefined,
    signal: AbortSignal.timeout(300_000) });
} catch {
  throw new Error("Worker の応答を確認できませんでした");
}
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
