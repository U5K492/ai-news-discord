import { env, exports as worker } from "cloudflare:workers";
import { abortAllDurableObjects, createExecutionContext, createScheduledController, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SOURCES } from "../src/sources";
import { message } from "../src/discord";
import { parseFeed, select } from "../src/feeds";
import app from "../src/index";

const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>LLM agent model release</title><link href="https://example.org/agent?utm_source=feed"/><published>${recent}</published><summary>New agent tools</summary></entry>
  <entry><title>Duplicate LLM</title><link href="https://example.org/agent"/><published>${recent}</published></entry>
  <entry><title>Old LLM</title><link href="https://example.org/old"/><published>${old}</published></entry>
  <entry><title>Office furniture</title><link href="https://example.org/furniture"/><published>${recent}</published></entry>
</feed>`;

let failAll = false;
let postCount = 0;
let uncertain = false;
let redirect = false;
beforeEach(async () => {
  await reset();
  failAll = false;
  postCount = 0;
  uncertain = false;
  redirect = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    new Request(input, init);
    const url = String(input);
    if (SOURCES.some(source => source.url === url)) return new Response(feed, { status: failAll ? 503 : 200 });
    if (url === "https://discord.com/api/webhooks/123/test-token?wait=true") {
      postCount++;
      if (uncertain) throw new Error("connection lost");
      if (redirect) return new Response(null, { status: 302, headers: { Location: "https://other.example/" } });
      const payload = JSON.parse(String(init?.body));
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      expect(payload.content.length).toBeLessThanOrEqual(2000);
      return Response.json({ id: "confirmed-message" });
    }
    throw new Error("Unexpected request");
  });
});
afterEach(() => { vi.restoreAllMocks(); });

function call(path: string) {
  return worker.default.fetch(`https://worker.example${path}`, {
    method: path === "/status" ? "GET" : "POST",
    headers: { Authorization: "Bearer test-admin-token" }
  });
}

function resolvePending(outcome: "sent" | "not_sent") {
  return worker.default.fetch("https://worker.example/resolve", {
    method: "POST", headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.org/agent", outcome })
  });
}

it("requires authorization before fetching news or sending a message", async () => {
  const response = await worker.default.fetch("https://worker.example/run", { method: "POST" });
  expect(response.status).toBe(401);
});

it("previews recent relevant unique articles without posting or changing history", async () => {
  const response = await call("/preview");
  expect(response.status).toBe(200);
  const result = await response.json() as { articles: { title: string; url: string }[] };
  expect(result.articles.map(article => article.url)).toEqual(["https://example.org/agent"]);
  const status = await call("/status");
  expect((await status.json() as { deliveries: unknown[] }).deliveries).toEqual([]);
  expect(postCount).toBe(0);
});

it("sends via webhook with mentions disabled and does not resend a confirmed article", async () => {
  const first = await call("/run");
  expect(first.status).toBe(200);
  expect((await first.json() as { sent: number }).sent).toBe(1);
  const second = await call("/run");
  expect(second.status).toBe(200);
  expect((await second.json() as { sent: number }).sent).toBe(0);
  expect(postCount).toBe(1);
});

it("fails visibly when every source fails and does not post", async () => {
  failAll = true;
  const response = await call("/run");
  expect(response.status).toBe(502);
});

it("preserves uncertain delivery and avoids automatic duplicate posts", async () => {
  uncertain = true;
  const first = await call("/run");
  expect(first.status).toBe(502);
  await first.json();
  await abortAllDurableObjects();
  const second = await call("/run");
  expect(second.status).toBe(200);
  const status = await call("/status");
  const result = await status.json() as { deliveries: { state: string }[] };
  expect(result.deliveries[0].state).toBe("pending");
  expect(postCount).toBe(1);
});

it("delivers the daily scheduled digest and persists the result", async () => {
  const ctx = createExecutionContext();
  await app.scheduled(createScheduledController({ cron: "0 7,15,23 * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(postCount).toBe(1);
  const status = await call("/status");
  const result = await status.json() as { deliveries: { state: string }[] };
  expect(result.deliveries[0].state).toBe("sent");
});

it("rejects a redirect without following it and allows retry after fixing the webhook", async () => {
  redirect = true;
  const first = await call("/run");
  expect(first.status).toBe(502);
  expect(postCount).toBe(1);
  const state = await (await call("/status")).json() as { deliveries: { state: string }[] };
  expect(state.deliveries[0].state).toBe("rejected");
  redirect = false;
  const second = await call("/run");
  expect(second.status).toBe(200);
  expect((await second.json() as { sent: number }).sent).toBe(1);
});

it("only retries a pending article after the operator confirms it was not sent", async () => {
  uncertain = true;
  await (await call("/run")).json();
  const resolution = await resolvePending("not_sent");
  expect(resolution.status).toBe(200);
  expect((await resolution.json() as { state: string }).state).toBe("rejected");
  const duplicateResolution = await resolvePending("sent");
  expect(duplicateResolution.status).toBe(502);
  await duplicateResolution.json();
  const status = await (await call("/status")).json() as { deliveries: { state: string }[] };
  expect(status.deliveries[0].state).toBe("rejected");
  uncertain = false;
  expect((await call("/run")).status).toBe(200);
  expect(postCount).toBe(2);
  await (await call("/run")).json();
  expect(postCount).toBe(2);
});

it("keeps a manually confirmed sent article out of retries and refuses to rewrite its history", async () => {
  uncertain = true;
  await (await call("/run")).json();
  const resolution = await resolvePending("sent");
  expect(resolution.status).toBe(200);
  await resolution.json();
  uncertain = false;
  await (await call("/run")).json();
  expect(postCount).toBe(1);
  const rewrite = await resolvePending("not_sent");
  expect(rewrite.status).toBe(502);
  await rewrite.json();
  const status = await (await call("/status")).json() as { deliveries: { state: string }[] };
  expect(status.deliveries[0].state).toBe("sent");
});

it("does not send the same article twice across simultaneous requests", async () => {
  const responses = await Promise.all([call("/run"), call("/run")]);
  expect(responses.some(response => response.status === 200)).toBe(true);
  expect(postCount).toBe(1);
});

it("parses RSS publication dates and HTML abstracts", () => {
  const rss = `<rss><channel><item><title>LLM release</title><link>https://example.org/release?utm_campaign=feed&amp;id=2</link><pubDate>Fri, 02 Oct 2026 09:00:00 GMT</pubDate><description>&lt;p&gt;New &amp;amp; open&lt;/p&gt;</description></item></channel></rss>`;
  const [article] = parseFeed(rss, SOURCES[0]);
  expect(article.url).toBe("https://example.org/release?id=2");
  expect(article.summary).toBe("New & open");
  expect(article.published).toBe("2026-10-02T09:00:00.000Z");
});

it("keeps future and undated items out of the digest", () => {
  const future = new Date(Date.now() + 86400_000).toISOString();
  const xml = `<feed><entry><title>LLM model</title><link href="https://example.org/future"/><published>${future}</published></entry><entry><title>LLM no date</title><link href="https://example.org/no-date"/></entry></feed>`;
  expect(select(parseFeed(xml, SOURCES[0]), new Set(), Date.now(), 48, 5)).toEqual([]);
});

it("keeps very long titles and emoji abstracts within the Discord limit", () => {
  const article = { title: "LLM " + "😀".repeat(500), summary: "😀".repeat(2000), source: "Research", priority: 0, published: recent, url: "https://example.org/" + "a".repeat(950) };
  expect(message(article, 1, 1, Date.now(), ["Unavailable"] ).length).toBeLessThanOrEqual(2000);
});
