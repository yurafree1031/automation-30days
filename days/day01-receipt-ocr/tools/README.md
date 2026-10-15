# tools

開発用の道具。お客様には渡さない。

- `make_receipts.py` … テスト用の架空のレシート画像と、正解の一覧（`answers.csv`）を作る。普通の100枚に加えて、例外の領収書（年のない日付・8%と10%の混在・手書き・PDF・日付や金額がない・領収書でない）も作る。使い方はファイルの先頭に書いてある。出力先の `test-receipts/` は `.gitignore` 済み
- `store_rules.tsv` … 「店別勘定科目」シートのテスト用ルール。シートの表の見出し（A7）に貼り付けて使う。半角カナ・部分一致・長い店名の優先を確かめられるようにしてある
- `apply_store_rules.py` … `answers.csv` に、`store_rules.tsv` を当てたあとの正解（`expected_category`）を足した CSV を作る
