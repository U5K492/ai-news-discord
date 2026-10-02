import { boundedText, clean, type Article } from "./feeds";

export class DeliveryError extends Error {
  constructor(message: string, public readonly confirmedRejected: boolean) { super(message); }
}

function safeText(value: string, max: number): string {
  return clean(value).replace(/@/g, "＠").replace(/([\\`*_~|<>\[\]])/g, "\\$1").slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

export function message(article: Article, index: number, total: number, now: number, failures: string[]): string {
  const date = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const published = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(Date.parse(article.published));
  let result = `AI エージェント / LLM 更新 — ${date} (${index}/${total})\n\n`;
  result += `${safeText(article.title, 180)}\n${safeText(article.source, 60)} | ${published} JST\n`;
  result += article.summary ? `${safeText(article.summary, 350)}\n` : "概要なし（詳細はリンク先）\n";
  result += `<${article.url}>`;
  if (failures.length) result += "\n\n取得できなかった情報源: " + safeText(failures.join(", "), 180);
  if (result.length > 2000) throw new Error("Discord の文字数制限を超えました");
  return result;
}

export function validateWebhook(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Discord Webhook が未設定です"); }
  if (url.protocol !== "https:" || !["discord.com", "canary.discord.com", "ptb.discord.com"].includes(url.hostname)
    || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.username || url.password) throw new Error("Discord Webhook URL が無効です");
  url.searchParams.set("wait", "true");
  return url.href;
}

export async function post(url: string, content: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 }), signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DeliveryError("Discord の投稿結果が不明です。チャンネルを確認してください", false);
    }
    let body: unknown;
    try { body = JSON.parse(await boundedText(response, 64 * 1024)); } catch { body = {}; }
    const data = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    if (response.ok && typeof data.id === "string") return data.id;
    if (response.status === 429 && attempt < 3) {
      const seconds = Number(data.retry_after ?? response.headers.get("Retry-After") ?? 1);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new DeliveryError("Discord の待機時間が上限を超えました", true);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000 + 100));
      continue;
    }
    throw new DeliveryError(`Discord 投稿に失敗しました (HTTP ${response.status})`, response.status >= 400 && response.status < 500);
  }
  throw new DeliveryError("Discord 投稿に失敗しました", true);
}
