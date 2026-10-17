# 共通部品ライブラリ

2回目に出てきた処理は、ここへ移す。

- `gas/` … GAS用（AI呼び出し、メール送信、エラー通知など）。正本はここに置き、各デモのフォルダにはコピーして使う（直すときはここを直してからコピーし直す）。手元のテストは `gas/tests/`（`node --test gas/tests/AI.test.js`）。テスト用のGASの偽物（スプレッドシート・メール・トリガーなど）は `gas/tests/fake-gas.js` にあり、各デモの `tests/helper.js` から読み込む（コピーしない）
- `python/` … Python用（Excel/CSV読み込み、AI呼び出しなど）

## 部品一覧

| 部品 | ファイル | 最初に使ったデモ | 内容 |
|---|---|---|---|
| AIの呼び出し | `gas/AI.gs` | 領収書 | Gemini・Claude・OpenAI を同じ書き方で呼ぶ `askAI_`。APIキーはAIごとの名前のスクリプトプロパティ（`GEMINI_API_KEY`・`CLAUDE_API_KEY`・`OPENAI_API_KEY`）に書き、書いてあるキーのAIを使う。混雑時のやり直し（`deadline` を渡すと、その時刻を過ぎるやり直しはしない）、エラーの振り分け（E01〜E05。利用枠の上限は E05、画像1枚ごとの400系は AIBadRequestError）つき |
| エラーの種類 | `gas/Errors.gs` | 領収書 | UserError（使う人が直す）・RetryLaterError（時間をおけば直る）・AdminError（管理者が直す、番号つき）。`errorText_` で、見る人向けの文にする |
| シートの部品 | `gas/Sheet.gs` | 問い合わせ通知 | 見出しの見た目 `styleHeader_`・見出しの行を文字で探す `findHeaderRow_`・見出し名から列番号 `headerMap_`・見出しの保護 `protectHeader_`。使う側で `HEADER_COLOR`・`PROTECT_NOTE` を決めておく |
| エラーの知らせ | `gas/Alert.gs` | 問い合わせ通知 | トリガーのエラーを、管理者へのメール（同じエラーは1日1通）`sendAdminAlert_` と、シートの上の赤い帯 `setAlertBand_` で知らせる。使う側で `TIME_ZONE`・`ERROR_ROW_COLOR` を決めておく |
