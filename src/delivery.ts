import { DurableObject } from "cloudflare:workers";
import { canonicalUrl, collect, select } from "./feeds";
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
