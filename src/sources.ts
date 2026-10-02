export const SOURCES = [
  { name: "OpenAI News", url: "https://openai.com/news/rss.xml", priority: 2 },
  { name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", priority: 2 },
  { name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml", priority: 1 },
  { name: "arXiv cs.AI / cs.CL", url: "https://rss.arxiv.org/rss/cs.AI+cs.CL", priority: 0 },
  { name: "Claude Code Releases", url: "https://github.com/anthropics/claude-code/releases.atom", priority: 1 }
] as const;

export type Source = { name: string; url: string; priority: number };
