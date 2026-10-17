"""テスト用の架空のレシート画像を作る。

店名・住所・登録番号はすべて架空で、レシートの下に「テスト用サンプル」と入れる。
画像と一緒に、正解（日付・店名・金額・勘定科目）を answers.csv に書き出すので、
経費表の読み取り結果と突き合わせて正解率を出せる。

使い方:
    python make_receipts.py <出力フォルダ> [枚数] [--seed N]

画像の状態（quality）は次の3種類をまぜる。
    clean  … 普通に撮った写真（緑の行になってほしい）
    rough  … 少しぼけている・暗い（黄色になってもよい）
    bad    … ひどくぼけている・下が切れている（赤になってほしい）

続けて、例外の領収書（extra_NN_<種類>）を足す。普通の100枚とは別の乱数で作るので、100枚の中身は変わらない。
    noyear      … 日付に年がない（正解の日付は「--MM-DD」。今日から見て直近の過去の年として採点する）
    tax8        … 8%と10%の品目がまざっている
    handwritten … 手書きの領収書（行書体）
    pdf         … PDFの領収書
    nodate      … 日付がない（赤になってほしい）
    nototal     … 金額が書かれていない（赤になってほしい）
    notreceipt  … 領収書ではない（会議のメモ。赤になってほしい）
answers.csv の expect 列が red のものは、「赤になれば正解」として採点する。
"""

import argparse
import csv
import datetime as dt
import math
import os
import random

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

FONT = "C:/Windows/Fonts/msgothic.ttc"  # 等幅。レシートの印字に近い
FONT_BOLD = "C:/Windows/Fonts/BIZ-UDGothicB.ttc"
FONT_HAND = "C:/Windows/Fonts/HGRGY.TTC"  # 行書体。手書きの領収書に使う

# 店の種類ごとに、店名・品目（名前と値段の範囲）・正解の勘定科目
SHOPS = [
    ("ファミリーストア", ["コンビニ"], [("ボールペン", 110, 165), ("ノート", 150, 250), ("乾電池 単3", 300, 450), ("クリアファイル", 100, 200)], "消耗品費"),
    ("カフェ・ミモザ", ["カフェ"], [("ブレンドコーヒー", 380, 480), ("カフェラテ", 450, 560), ("サンドイッチ", 480, 650), ("チーズケーキ", 420, 520)], "会議費"),
    ("みどり書房", ["書店"], [("ビジネス書", 1500, 2200), ("月刊誌", 800, 1200), ("技術書", 2800, 3800)], "新聞図書費"),
    ("居酒屋 たぬき", ["居酒屋"], [("生ビール", 550, 650), ("刺身盛合せ", 1280, 1880), ("焼鳥盛合せ", 880, 1200), ("ウーロン茶", 350, 400)], "接待交際費"),
    ("さくら交通", ["タクシー"], [("運賃", 1200, 4800)], "旅費交通費"),
    ("デンキのマルヤ", ["家電"], [("USBケーブル", 980, 1980), ("マウス", 1980, 3980), ("延長コード", 880, 1480)], "消耗品費"),
    ("ひかり郵便取扱所", ["郵便"], [("切手 110円", 110, 110), ("レターパック", 430, 600), ("はがき", 85, 85)], "通信費"),
]
BRANCHES = ["駅前店", "中央店", "北口店", "本町店", "みなと店", ""]
TOWNS = ["架空市中央1-2-3", "架空市本町4-5-6", "架空市みなと7-8-9", "架空市北町2-4-6"]


def make_receipt(rng, date, year=True, tax8=False, drop=None):
    """レシートの中身（行のリスト）と正解を作る。year・tax8・drop は例外の領収書を作るときだけ使う"""
    name, _, items, category = rng.choice(SHOPS)
    branch = rng.choice(BRANCHES)
    store = f"{name} {branch}".strip()
    lines = [("center_big", name), ("center", branch or "　"), ("center", rng.choice(TOWNS)),
             ("center", f"TEL 000-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}"), ("blank", ""),
             ("center_big", "領　収　書"), ("blank", ""),
             ("left", f"{date:%Y年%m月%d日}({'月火水木金土日'[date.weekday()]}) {rng.randint(9, 21):02d}:{rng.randint(0, 59):02d}"),
             ("left", f"レジ{rng.randint(1, 4):02d}  No.{rng.randint(1000, 9999)}"), ("rule", "")]
    subtotal = 0
    for item, lo, hi in rng.sample(items, k=min(len(items), rng.randint(1, 4))):
        qty = 1 if lo == hi or item == "運賃" else rng.randint(1, 3)
        price = lo if lo == hi else rng.randrange(lo, hi + 1, 10)
        subtotal += price * qty
        lines.append(("item", (item if qty == 1 else f"{item} x{qty}", price * qty)))
    if tax8:  # 食品の持ち帰り（8%）をまぜる
        food = rng.randrange(300, 900, 10)
        lines.append(("item", ("※お弁当（持ち帰り）", food)))
        tax = math.floor(subtotal * 0.1) + math.floor(food * 0.08)
        tax_lines = [("item", ("(10%対象)", subtotal)), ("item", ("(8%対象)", food)), ("item", (" 消費税", tax))]
        subtotal += food
    else:
        tax = math.floor(subtotal * 0.1)
        tax_lines = [("item", ("(10%対象)", subtotal)), ("item", (" 消費税", tax))]
    total = subtotal + tax
    paid = math.ceil(total / 1000) * 1000 + rng.choice([0, 0, 1000])
    lines += [("rule", ""), ("item", ("小計", subtotal)), *tax_lines,
              ("item_big", ("合計", total)), ("item", ("お預り", paid)), ("item", ("お釣り", paid - total)), ("rule", ""),
              ("left", "登録番号 T0000000000000"), ("blank", ""), ("center", "※テスト用サンプル（架空の店舗）")]
    answer = {"date": date.isoformat(), "store": store, "amount": total, "category": category, "expect": ""}
    if not year:
        lines[7] = ("left", f"{date:%m月%d日} {rng.randint(9, 21):02d}:{rng.randint(0, 59):02d}")
        answer["date"] = f"--{date:%m-%d}"
    if drop == "date":
        del lines[7]
        answer.update(date="", expect="red")
    if drop == "total":  # 品目の値段と、小計から下の金額を消す
        lines = [("left", f"{v[0]}") if k == "item" and not v[0].startswith(("小計", "(", " 消費税", "お預り", "お釣り")) else (k, v)
                 for k, v in lines if not (k in ("item", "item_big") and v[0].startswith(("小計", "(", " 消費税", "合計", "お預り", "お釣り")))]
        answer.update(amount="", expect="red")
    return lines, answer


def render_handwritten(rng, date):
    """手書きの領収書（宛名・金額・但し書き・日付・店名を、行書体で書いたもの）と正解を作る"""
    name, _, items, category = rng.choice(SHOPS)
    total = rng.randrange(1000, 30000, 10)
    W, H = 900, 520
    paper = Image.new("RGB", (W, H), (252, 251, 247))
    d = ImageDraw.Draw(paper)
    ink, line = (30, 30, 70), (150, 150, 160)
    title, hand, small = ImageFont.truetype(FONT_BOLD, 40), ImageFont.truetype(FONT_HAND, 40), ImageFont.truetype(FONT, 22)
    d.text((W / 2, 30), "領　収　書", font=title, fill=(40, 40, 40), anchor="ma")
    d.text((560, 100), f"{date.year}年 {date.month}月 {date.day}日", font=hand, fill=ink)
    d.text((60, 150), "株式会社サンプル", font=hand, fill=ink)
    d.line((60, 200, 520, 200), fill=line, width=2)
    d.text((540, 165), "様", font=small, fill=(40, 40, 40))
    d.text((W / 2, 230), f"金 {total:,} 円", font=ImageFont.truetype(FONT_HAND, 60), fill=ink, anchor="ma")  # 行書体には ¥ の字がない
    d.line((200, 305, 700, 305), fill=line, width=2)
    d.text((60, 330), "但し", font=small, fill=(40, 40, 40))
    d.text((130, 320), f"{items[0][0]}代として", font=hand, fill=ink)
    d.text((60, 380), "上記正に領収いたしました", font=small, fill=(40, 40, 40))
    d.text((560, 400), name, font=hand, fill=ink)
    d.text((560, 455), "※テスト用サンプル（架空）", font=small, fill=(90, 90, 90))
    return paper, {"date": date.isoformat(), "store": name, "amount": total, "category": category, "expect": ""}


def render_memo(rng):
    """領収書ではない紙（会議のメモ）。赤になってほしい"""
    W, H = 600, 700
    paper = Image.new("RGB", (W, H), (250, 250, 240))
    d = ImageDraw.Draw(paper)
    hand = ImageFont.truetype(FONT_HAND, 34)
    lines = ["会議メモ", f"{rng.randint(1, 12)}/{rng.randint(1, 28)}　定例", "・新商品の価格を決める", "・来月までに見積もりを2社",
             "・展示会の準備（担当: 田中）", "・次回は第2水曜日"]
    for i, t in enumerate(lines):
        d.text((50, 50 + i * 90), t, font=hand, fill=(30, 30, 80))
        d.line((40, 100 + i * 90, W - 40, 100 + i * 90), fill=(180, 200, 230), width=2)
    return paper, {"date": "", "store": "", "amount": "", "category": "", "expect": "red"}


def render(lines, rng):
    """レシートの紙を描く"""
    W = 576  # 80mmのレシートを 203dpi で印刷したときの幅
    font, big = ImageFont.truetype(FONT, 26), ImageFont.truetype(FONT_BOLD, 36)
    H = 40 + sum(56 if k in ("center_big", "item_big") else 18 if k == "blank" else 36 for k, _ in lines) + 40
    paper = Image.new("RGB", (W, H), (250, 249, 245))
    d = ImageDraw.Draw(paper)
    y, ink = 40, (35, 35, 40)
    for kind, v in lines:
        if kind in ("center", "center_big"):
            f = big if kind == "center_big" else font
            d.text((W / 2, y), v, font=f, fill=ink, anchor="ma")
        elif kind == "left":
            d.text((32, y), v, font=font, fill=ink)
        elif kind == "rule":
            d.text((32, y + 4), "-" * 40, font=font, fill=ink)
        elif kind in ("item", "item_big"):
            f = big if kind == "item_big" else font
            d.text((32, y), v[0], font=f, fill=ink)
            d.text((W - 32, y), f"¥{v[1]:,}", font=f, fill=ink, anchor="ra")
        y += 56 if kind in ("center_big", "item_big") else 18 if kind == "blank" else 36
    return paper


def photograph(paper, rng, quality):
    """机の上に置いたレシートをスマホで撮ったように加工する"""
    if quality == "bad" and rng.random() < 0.5:  # 下が切れている
        paper = paper.crop((0, 0, paper.width, int(paper.height * rng.uniform(0.55, 0.7))))
    angle = rng.uniform(-4, 4) if quality == "clean" else rng.uniform(-10, 10)
    paper = paper.convert("RGBA").rotate(angle, expand=True, resample=Image.BICUBIC)

    bg_color = rng.choice([(120, 92, 66), (90, 90, 95), (160, 150, 135), (60, 70, 80)])
    bg = Image.new("RGB", (paper.width + 240, paper.height + 240), bg_color)
    shadow = Image.new("RGBA", paper.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 110), mask=paper.split()[3])
    bg.paste(shadow.filter(ImageFilter.GaussianBlur(14)), (128, 136), shadow.filter(ImageFilter.GaussianBlur(14)))
    bg.paste(paper, (120, 120), paper)

    # 光のむら（左上が明るい）と、カメラのノイズ
    light = Image.linear_gradient("L").transpose(rng.choice(list(Image.Transpose)[:4])).resize(bg.size)
    bg = Image.composite(ImageEnhance.Brightness(bg).enhance(1.08), ImageEnhance.Brightness(bg).enhance(0.88), light)
    noise = Image.effect_noise(bg.size, 12 if quality == "clean" else 24).convert("RGB")
    bg = Image.blend(bg, noise, 0.04)

    blur = {"clean": rng.uniform(0.3, 0.8), "rough": rng.uniform(1.6, 2.4), "bad": rng.uniform(4.5, 6.5)}[quality]
    bg = bg.filter(ImageFilter.GaussianBlur(blur))
    if quality != "clean":
        bg = ImageEnhance.Brightness(bg).enhance(rng.uniform(0.6, 0.8))
        bg = ImageEnhance.Contrast(bg).enhance(rng.uniform(0.6, 0.8))
    return bg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("count", nargs="?", type=int, default=1)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)

    start = dt.date(2026, 4, 1)
    rows = []
    for i in range(1, args.count + 1):
        quality = rng.choices(["clean", "rough", "bad"], weights=[75, 15, 10])[0]
        date = start + dt.timedelta(days=rng.randint(0, 196))
        lines, answer = make_receipt(rng, date)
        name = f"receipt_{i:03d}.jpg"
        photograph(render(lines, rng), rng, quality).save(os.path.join(args.out, name), quality=85)
        rows.append({"file": name, "quality": quality, **answer})

    # 例外の領収書。普通の100枚とは別の乱数を使う（100枚の中身を変えないため）
    rng2 = random.Random(args.seed + 1000)
    kinds = ["noyear"] * 3 + ["tax8"] * 2 + ["handwritten"] * 3 + ["pdf"] * 2 + ["nodate"] * 2 + ["nototal"] * 2 + ["notreceipt"] * 2
    for i, kind in enumerate(kinds, 1):
        date = start + dt.timedelta(days=rng2.randint(0, 196))
        name = f"extra_{i:02d}_{kind}." + ("pdf" if kind == "pdf" else "jpg")
        path = os.path.join(args.out, name)
        if kind == "handwritten":
            paper, answer = render_handwritten(rng2, date)
            photograph(paper, rng2, "clean").save(path, quality=85)
        elif kind == "notreceipt":
            paper, answer = render_memo(rng2)
            photograph(paper, rng2, "clean").save(path, quality=85)
        else:
            opts = {"noyear": {"year": False}, "tax8": {"tax8": True}, "nodate": {"drop": "date"}, "nototal": {"drop": "total"}}.get(kind, {})
            lines, answer = make_receipt(rng2, date, **opts)
            paper = render(lines, rng2)
            if kind == "pdf":
                paper.save(path, "PDF", resolution=203)  # スキャナやネットで受け取ったPDFの想定（撮った写真ではない）
            else:
                photograph(paper, rng2, "clean").save(path, quality=85)
        rows.append({"file": name, "quality": kind, **answer})

    with open(os.path.join(args.out, "answers.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["file", "quality", "date", "store", "amount", "category", "expect"])
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)}枚（うち例外 {len(kinds)}枚）を {args.out} に作りました")


if __name__ == "__main__":
    main()
