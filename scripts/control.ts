import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";

const [base, action] = process.argv.slice(2);
if (!base || !["preview", "run", "status"].includes(action)) throw new Error("Worker URL と preview / run / status を指定してください");
const endpoint = new URL(`/${action}`, base);
if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") throw new Error("HTTPS の Worker URL を指定してください");
const path = new NodeURL("../../../tmp/ai-news-discord_secrets.json", import.meta.url);
const secrets = JSON.parse(await readFile(path, "utf8")) as { ADMIN_TOKEN?: string };
if (!secrets.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN が未設定です");
let response: Response;
try {
  response = await fetch(endpoint, { method: action === "status" ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${secrets.ADMIN_TOKEN}` }, signal: AbortSignal.timeout(300_000) });
} catch {
  throw new Error("Worker の応答を確認できませんでした");
}
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
