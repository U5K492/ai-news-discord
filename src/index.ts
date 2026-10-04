import { boundedText } from "./feeds";

export { DigestDelivery } from "./delivery";

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const encoder = new TextEncoder();
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("Authorization") ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.ADMIN_TOKEN}`))
  ]);
  return crypto.subtle.timingSafeEqual(provided, expected);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ ok: true, webhookConfigured: !!env.DISCORD_WEBHOOK_URL, schedule: "08:00, 16:00, 00:00 Asia/Tokyo" });
    if (!await authorized(request, env)) return Response.json({ error: "認証が必要です" }, { status: 401 });
    const digest = env.DIGEST.getByName("daily-discord-channel");
    if (path === "/status" && request.method === "GET") return Response.json(await digest.status());
    if (!["/preview", "/run", "/resolve"].includes(path) || request.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });
    try {
      if (path === "/resolve") {
        const data: unknown = JSON.parse(await boundedText(new Response(request.body), 4096));
        if (!data || typeof data !== "object" || !("url" in data) || typeof data.url !== "string"
          || !("outcome" in data) || (data.outcome !== "sent" && data.outcome !== "not_sent")) return Response.json({ error: "url と outcome (sent / not_sent) が必要です" }, { status: 400 });
        return Response.json(await digest.resolvePending(data.url, data.outcome));
      }
      return Response.json(await digest.run(path === "/preview"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "配信処理に失敗しました";
      console.error(JSON.stringify({ event: "digest_failed", message }));
      return Response.json({ error: message }, { status: 502 });
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(env.DIGEST.getByName("daily-discord-channel").run(false).then(() => undefined));
  }
} satisfies ExportedHandler<Env>;
