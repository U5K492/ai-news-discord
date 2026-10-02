import { collect, select } from "../src/feeds";
import { message } from "../src/discord";

const now = Date.now();
const { articles, failures } = await collect();
const selected = select(articles, new Set(), now, 48, 5);
for (let index = 0; index < selected.length; index++) {
  console.log(message(selected[index], index + 1, selected.length, now, failures) + "\n");
}
if (!selected.length) console.log("新しい対象記事はありません");
if (failures.length) console.error("取得失敗: " + failures.join(", "));
