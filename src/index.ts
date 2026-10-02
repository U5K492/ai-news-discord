import { DurableObject } from "cloudflare:workers";
import { boundedText, canonicalUrl, collect, select } from "./feeds";
import { DeliveryError, message, post, validateWebhook } from "./discord";

type Delivery = { url: string; state: string; updated: string; message_id: string | null };

export class DigestDelivery extends DurableObject<Env> {
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS deliveries (url TEXT PRIMARY KEY, state TEXT NOT NULL, updated TEXT NOT NULL, message_id TEXT)");
  }

  async status() {
    const deliveries = this.ctx.storage.sql.exec<Delivery>("SELECT * FROM deliveries ORDER BY updated DESC LIMIT 100").toArray();
    const pending = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM deliveries WHERE state = 'pending'").one().count;
    return { running: this.running, pending, deliveries };
  }

  async resolvePending(url: string, outcome: "sent" | "not_sent") {
    if (this.running) throw new Error("配信処理が実行中です");
    const state = outcome === "sent" ? "sent" : "rejected";
    const rows = this.ctx.storage.sql.exec<{ url: string }>("UPDATE deliveries SET state = ?, updated = ? WHERE url = ? AND state = 'pending' RETURNING url",
      state, new Date().toISOString(), canonicalUrl(url)).toArray();
    if (!rows.length) throw new Error("対象記事は確認待ちの状態ではありません");
    return { resolved: rows[0].url, state };
  }

  async run(preview: boolean) {
    if (this.running) throw new Error("配信処理が実行中です");
    this.running = true;
    try {
      const now = Date.now();
      const webhook = preview ? "" : validateWebhook(this.env.DISCORD_WEBHOOK_URL);
      const limit = Number(this.env.ARTICLE_LIMIT), hours = Number(this.env.LOOKBACK_HOURS);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("配信設定が無効です");
      const seen = new Set(this.ctx.storage.sql.exec<{ url: string }>("SELECT url FROM deliveries WHERE state IN ('sent', 'pending')").toArray().map(row => row.url));
      const collected = await collect();
      const articles = select(collected.articles, seen, now, hours, limit);
      const contents = articles.map((article, index) => message(article, index + 1, articles.length, now, collected.failures));
      if (preview) return { preview: true, articles, contents, failures: collected.failures, sent: 0 };
      let sent = 0;
      for (let index = 0; index < articles.length; index++) {
        const article = articles[index];
        this.ctx.storage.sql.exec("INSERT INTO deliveries (url, state, updated) VALUES (?, 'pending', ?) ON CONFLICT(url) DO UPDATE SET state = 'pending', updated = excluded.updated", article.url, new Date(now).toISOString());
        try {
          const id = await post(webhook, contents[index]);
          this.ctx.storage.sql.exec("UPDATE deliveries SET state = 'sent', message_id = ? WHERE url = ?", id, article.url);
          sent++;
        } catch (error) {
          if (error instanceof DeliveryError && error.confirmedRejected) this.ctx.storage.sql.exec("UPDATE deliveries SET state = 'rejected' WHERE url = ?", article.url);
          throw error;
        }
      }
      const pending = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM deliveries WHERE state = 'pending'").one().count;
      const result = { preview: false, sent, articles, failures: collected.failures, pending };
      console.log(JSON.stringify({ event: "digest_completed", sent, failures: collected.failures, pending }));
      return result;
    } finally {
      this.running = false;
    }
  }
}

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
    if (path === "/health" && request.method === "GET") return Response.json({ ok: true, webhookConfigured: !!env.DISCORD_WEBHOOK_URL, schedule: "08:00 Asia/Tokyo" });
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
