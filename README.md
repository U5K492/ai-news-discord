# AI エージェント・LLM の更新を 1 日 3 回 Discord に届ける

Cloudflare Worker が毎日 8:00・16:00・翌 0:00 JST に公開フィードを取得し、各回で新しい対象記事を最大 5 件配信する。
初版は LLM API を使わない。配信見出しは日本語、タイトルと概要は情報源の原文になる。
概要を含まない記事はリンクを案内する。

## 配信する内容と情報源

OpenAI News、Google DeepMind、Hugging Face Blog、arXiv cs.AI / cs.CL、Claude Code Releases を対象にする。
`src/sources.ts` で変更できる。
直近 48 時間の記事を関連キーワードで絞り、技術的なタイトルを優先する。
同じ情報源は最大 2 件、全体では最大 5 件にする。
重要度は単純なキーワードによる順位付けであり、LLM による評価ではない。
arXiv は未査読の研究も含み、更新日時の新しい論文改訂も対象になる。
公開フィードに載らない記事・SNS の投稿を網羅する構成ではない。

## ローカルで配信内容を確かめる

Node.js 22.12 以上と pnpm を使う。`.mise.toml` は Node 24.15.0 を指定している。

```sh
cd ~/Documents/WorkSpace/tools/ai-news-discord
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm install --frozen-lockfile
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm preview
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm test
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm check
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec wrangler deploy --dry-run
```

`pnpm preview` は公開フィードから配信文を表示する。Discord 投稿と履歴更新はしない。
テストは Workers ランタイムと SQLite を使い、外部フィードと Discord を模擬する。
テストの秘密設定は `vitest.config.ts` の模擬値に固定している。

## 配信を開始するための設定

1. Discord のサーバー設定 → 連携サービス → ウェブフックで、配信先チャンネルの Webhook を作成する
2. `~/Documents/WorkSpace/tmp/ai-news-discord_secrets.json` の `DISCORD_WEBHOOK_URL` に URL を保存する
   `ADMIN_TOKEN` は生成済み。どちらの値もチャットや git に載せない
3. Cloudflare にログインして、Worker を配置する

```sh
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec wrangler login
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec wrangler whoami
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm deploy
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec wrangler secret bulk ../../tmp/ai-news-discord_secrets.json
```

Webhook は実際の `https://discord.com/api/webhooks/...` URL を使う。
`DISCORD_WEBHOOK_URL` が空のまま secret bulk を実行しない。
Cron は秘密情報の設定前には投稿できず、実行エラーになる。
ログイン済みアカウントが複数ある場合は `wrangler.jsonc` に本件の `account_id` を指定してから配置する。
秘密設定後に手動のプレビューと配信を確認する。
Cron の変更は伝播に時間がかかることがある。

## 手動確認と配信状態

Worker の公開 URL は `wrangler deploy` の出力で確認できる。
以下の操作は `Authorization: Bearer <ADMIN_TOKEN>` ヘッダーが必要になる。
秘密をコマンド引数に書かず、`scripts/control.ts` を使う。

```sh
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec tsx scripts/control.ts https://ai-news-discord.YOUR-SUBDOMAIN.workers.dev preview
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec tsx scripts/control.ts https://ai-news-discord.YOUR-SUBDOMAIN.workers.dev run
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec tsx scripts/control.ts https://ai-news-discord.YOUR-SUBDOMAIN.workers.dev status
```

`preview` は配信履歴を考慮した内容確認、`run` は実際の投稿、`status` は直近の配信履歴を返す。
`/health` は認証なしで秘密情報の設定有無と実行予定時刻を返す。配信の成功保証ではない。
新しい対象記事がなければ投稿しない。
フィード取得の一部失敗は配信文・実行結果に表示し、全情報源の失敗は実行を失敗として扱う。

## 再通知と応答が不明な投稿

配信履歴は Durable Object の SQLite に保存する。
追跡パラメーターと arXiv のバージョン違いを URL 正規化でまとめ、投稿済み記事の再配信を避ける。
投稿前に `pending`、Discord の保存確認後に `sent` にする。
HTTP 429 は Discord の `retry_after` に従って最大 4 回まで試す。
明確な HTTP 4xx の拒否は `rejected` とし、次の実行で再試行できる。
通信切断・HTTP 5xx・保存確認の欠落は、投稿済みか判断できないので `pending` に残して自動再送しない。
この場合は `status` と Discord のチャンネルを照合する。厳密な一回だけの配送を保証するものではない。

チャンネルと照合して結果が確定した記事だけ、`control.ts` の `resolve-sent` または `resolve-not-sent` で確認結果を記録できる。
`resolve-not-sent` にした記事は、次の `run` または Cron で公開日時の範囲内なら再試行する。
送信済み・拒否済みの履歴はこの操作で変更できない。

```sh
rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec tsx scripts/control.ts https://ai-news-discord.YOUR-SUBDOMAIN.workers.dev resolve-not-sent https://example.org/article
```

ログは `rtk proxy env PATH="$HOME/.local/share/mise/installs/node/24.15.0/bin:$PATH" pnpm exec wrangler tail` または Cloudflare Dashboard の Worker Logs で確認する。
配信履歴を消すと再通知が起きるため、確認せずに Durable Object の移行・削除をしない。

## 設定を変える場所

`wrangler.jsonc` の `ARTICLE_LIMIT`（1–10）、`LOOKBACK_HOURS`（1–168）を変更して配置し直す。
同一情報源の上限は `src/feeds.ts` の `select()` にある。
8:00・16:00・翌 0:00 JST は UTC の 23:00・7:00・15:00 に当たるため、Cron は `0 7,15,23 * * *` にしている。
ローカルランタイムが対応する互換日付として `2026-10-01` を使う。

## 設定と実装の根拠

- [Cloudflare Cron の時刻と設定](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Durable Object の永続状態と外部通信](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Discord Webhook の投稿確認・文字数制限・メンション制御](https://docs.discord.com/developers/resources/webhook)
- [Discord のレート制限](https://docs.discord.com/developers/topics/rate-limits)
