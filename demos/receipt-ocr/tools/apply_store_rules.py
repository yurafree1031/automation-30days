"""answers.csv に、店別勘定科目のルールを当てたあとの正解（expected_category）を足した CSV を作る。

Code.gs の findStoreCategory_ / normalizeStore_ と同じ考え方で照合する。

使い方:
    python apply_store_rules.py <answers.csv> <store_rules.tsv> <出力CSV>
"""

import csv
import re
import sys
import unicodedata


def normalize(name):
    """表記ゆれ（全角/半角、大文字/小文字、ひらがな/カタカナ、会社の種類、空白・ハイフン・長音・中黒）をそろえる"""
    s = unicodedata.normalize("NFKC", str(name)).lower()
    s = re.sub(r"株式会社|有限会社|合同会社|合資会社|合名会社|\((株|有|同|資|名)\)", "", s)
    s = "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in s)
    return re.sub(r"[\s\-‐－―ー・]", "", s)


def main(answers_path, rules_path, out_path):
    with open(rules_path, encoding="utf-8") as f:
        rows = list(csv.reader(f, delimiter="\t"))[1:]
    # 店名を空白で区切り、言葉がすべて含まれていれば当たる。詳しい（長い）ルールを優先する
    rules = [([p for p in map(normalize, s.split()) if p], c.strip()) for s, c in rows]
    rules = sorted((r for r in rules if r[0] and r[1]), key=lambda r: -len("".join(r[0])))

    with open(answers_path, encoding="utf-8-sig") as f:
        answers = list(csv.DictReader(f))
    for a in answers:
        store = normalize(a["store"])
        hit = next((c for parts, c in rules if all(p in store for p in parts)), None)
        a["expected_category"] = hit or a["category"]
        a["rule_applied"] = "yes" if hit else ""

    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(answers[0].keys()))
        w.writeheader()
        w.writerows(answers)
    print(f"{sum(1 for a in answers if a['rule_applied'])} / {len(answers)} 件にルールが当たります")


if __name__ == "__main__":
    main(*sys.argv[1:4])
