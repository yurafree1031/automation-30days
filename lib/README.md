# 共通部品ライブラリ

同じ処理を2回書いたら、ここへ移す。目標: 1か月目の終わりまでに5個以上。

- `gas/` … GAS用（AI呼び出し、メール送信、エラー通知など）。正本はここに置き、各デモのフォルダにはコピーして使う（直すときはここを直してからコピーし直す）。手元のテストは `gas/tests/`（`node --test gas/tests/AI.test.js`）
- `python/` … Python用（Excel/CSV読み込み、AI呼び出しなど）

## 部品一覧

| 部品 | ファイル | 初出 | 内容 |
|---|---|---|---|
| AIの呼び出し | `gas/AI.gs` | Day 1 | Gemini・Claude・OpenAI を同じ書き方で呼ぶ `askAI_`。APIキーはAIごとの名前のスクリプトプロパティ（`GEMINI_API_KEY`・`CLAUDE_API_KEY`・`OPENAI_API_KEY`）に書き、書いてあるキーのAIを使う。混雑時のやり直し（`deadline` を渡すと、その時刻を過ぎるやり直しはしない）、エラーの振り分け（E01〜E05。利用枠の上限は E05、画像1枚ごとの400系は AIBadRequestError）つき |
| エラーの種類 | `gas/Errors.gs` | Day 1 | UserError（使う人が直す）・RetryLaterError（時間をおけば直る）・AdminError（管理者が直す、番号つき） |
