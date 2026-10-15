# tests

Day 1 のテスト。お客様には渡さない（`.claspignore` で Apps Script には送らない）。

| ファイル | 内容 | 実行 |
|---|---|---|
| `test-cases.md` | テストケースの一覧（正常・エラー・誤操作・見た目）と、実行結果 | － |
| `logic.test.js` | 店名の照合・日付などの値のチェック・設定の読み取り・配布物の確認 | `node --test` |
| `run.test.js` | 「領収書を読み取る」ボタンの処理（AIの返事は偽物） | `node --test` |
| `sheet.test.js` | 編集したとき・メニュー・ボタンの作成 | `node --test` |
| `helper.js` | GASの部品（スプレッドシート・ドライブなど）の偽物 | － |
| `accuracy.js` | 実際のAIで、100枚の領収書と例外の領収書を読み取り、正解（`test-receipts/answers.csv`）と比べる | 下記 |
| `accuracy-results/` | `accuracy.js` の結果（日時とモデルの名前つき。前の結果と並べて比べる） | － |

## 手元のテスト（AIを使わない）

`automation-30days` フォルダで実行する。

```
node --test "days/day01-receipt-ocr/tests/*.test.js"
node --test lib/gas/tests/AI.test.js
```

## 実際のAIを使うテスト

AIの利用枠を使うので、`node --test` には含めていない。キーは環境変数で渡す（ファイルには書かない）。

```
GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js            # 先頭の10枚
GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js --extras   # 例外の領収書だけ
GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js --all      # 100枚＋例外
```

- 結果は `accuracy-results/<日時>-<モデル>.md` に残る（前の結果は消えない）。合格の条件は「色が付かずに間違って通った行が0件」。
- 結果には、項目ごとの一致率、自信度の帯ごとの正解率（黄色・赤の基準を決め直す材料）、間違いの種類（読み違い／空欄／作った値）、使ったトークンと100枚あたりの費用、プロンプトの版が出る。
- 終了コード: 0 合格 / 1 不合格 / 2 実行できなかった（キーがない・利用枠の上限など）
- `ACCURACY_FAKE=1` を付けると、AIを呼ばずに、スクリプト自体の動作だけを確かめられる。
