# 業務自動化 30日チャレンジ

毎日1つ、「手作業の転記・集計・通知」を自動化するデモを作っています（2026/10/15〜）。
GAS（Google Apps Script）を軸に、Python と生成AI API を組み合わせています。

## デモ一覧

| Day | テーマ | 技術 | フォルダ |
|---|---|---|---|
| 1 | 領収書の写真をAIで読み取り、経費表に自動で記録 | AI画像読み取り, GAS | `days/day01-receipt-ocr` |

## フォルダ構成

- `days/dayNN-<名前>/` … 各日のデモ。中に `README.md`（Before/After・使い方・GIF）とコード
- `lib/gas/` … GASの共通部品（2回目に使った処理をここへ移す）
- `lib/python/` … Pythonの共通部品

## 秘密情報の扱い

APIキーはコードに書かず、GASは「スクリプト プロパティ」、Pythonは `.env`（Git管理外）に保存します。
