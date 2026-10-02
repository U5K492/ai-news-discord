import { XMLParser, XMLValidator } from "fast-xml-parser";
import he from "he";
import { SOURCES, type Source } from "./sources";

export type Article = { title: string; url: string; summary: string; published: string; source: string; priority: number };
const TOPICS = /\b(llms?|language models?|agents?|agentic|transformers?|reasoning|rag|retrieval.augmented|tool.use|function.calling|mcp|claude|gemini|gpt|chatgpt|llama|qwen|deepseek|codex|coding|multimodal|fine.tun\w*|inference|context.window|open.weight|alignment)\b/gi;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  const content = object(value)["#text"];
  return typeof content === "string" ? content : "";
}

export function clean(value: string): string {
  return he.decode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || raw.length > 1000) throw new Error("Invalid article URL");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || ["fbclid", "gclid"].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  if (url.hostname === "arxiv.org") url.pathname = url.pathname.replace(/(\/abs\/\d+\.\d+)v\d+$/, "$1");
  return url.href;
}

export function parseFeed(xml: string, source: Source): Article[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid feed XML");
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(xml);
  const root = object(parsed);
  if (!root.rss && !root.feed && !root.RDF) throw new Error("Not an RSS or Atom feed");
  const entries = list(object(object(root.rss).channel).item).concat(list(object(root.feed).entry), list(object(root.RDF).item));
  const articles: Article[] = [];
  for (const value of entries) {
    const entry = object(value);
    const title = clean(text(entry.title));
    const links = list(entry.link).map(object);
    const link = links.find(link => link["@_href"] && (!link["@_rel"] || link["@_rel"] === "alternate"));
    const rawUrl = text(link?.["@_href"]) || text(entry.link);
    const rawDate = text(entry.published) || text(entry.pubDate) || text(entry.date) || text(entry.updated);
    const date = Date.parse(rawDate);
    if (!title || !rawUrl || !Number.isFinite(date)) continue;
    try {
      articles.push({ title, url: canonicalUrl(rawUrl), published: new Date(date).toISOString(),
        summary: clean(text(entry.summary) || text(entry.description) || text(entry.encoded) || text(entry.content)),
        source: source.name, priority: source.priority });
    } catch {
      continue;
    }
  }
  return articles;
}

export async function boundedText(response: Response, maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("Response exceeds size limit"); }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function collect(): Promise<{ articles: Article[]; failures: string[] }> {
  const results = await Promise.allSettled(SOURCES.map(async source => {
    const response = await fetch(source.url, { headers: { "User-Agent": "ai-news-discord/0.1" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Feed HTTP ${response.status}`); }
    return parseFeed(await boundedText(response), source);
  }));
  const articles: Article[] = [], failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") articles.push(...result.value);
    else failures.push(SOURCES[index].name);
  });
  if (failures.length === SOURCES.length) throw new Error("すべての情報源の取得に失敗しました");
  return { articles, failures };
}

function score(article: Article): number {
  return (article.title.match(TOPICS)?.length ?? 0) * 3 + article.priority
    + (article.title.match(/\b(model|release|launch|sdk|benchmark|research|guide|open.source|evaluation)\b/gi)?.length ?? 0) * 2;
}

export function select(articles: Article[], seen: Set<string>, now: number, hours: number, limit: number): Article[] {
  const selected: Article[] = [];
  const urls = new Set(seen);
  const perSource = new Map<string, number>();
  const ordered = [...articles].sort((a, b) => score(b) - score(a) || Date.parse(b.published) - Date.parse(a.published));
  for (const article of ordered) {
    const date = Date.parse(article.published);
    if (urls.has(article.url) || date < now - hours * 3_600_000 || date > now) continue;
    if (!(article.title + " " + article.summary).match(TOPICS)) continue;
    if ((perSource.get(article.source) ?? 0) >= 2) continue;
    selected.push(article);
    urls.add(article.url);
    perSource.set(article.source, (perSource.get(article.source) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}
