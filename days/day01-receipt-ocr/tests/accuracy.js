// 実際のAIで、読み取りの正確さを確かめる（テストケース N29・N30・N32・E19）。AIを使うので、`node --test` には含めない。
// 確かめ方の考え方は ノウハウ/AIの精度の確かめ方.md（合格の目安・自信度の帯・間違いの種類・記録の残し方）
//
// 使い方（automation-30days フォルダで）:
//   GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js            … 先頭の10枚
//   GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js --limit 30
//   GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js --extras   … 例外の領収書（extra_*）だけ
//   GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js --all      … すべて（100枚＋例外）
//   Claude・OpenAI で試すときは CLAUDE_API_KEY・OPENAI_API_KEY（本番のスクリプトプロパティと同じ名前）
//   AI_MODEL=<モデル名> を付けると、使うモデルを変えられる（付けなければ AI.gs の初期値）
//   PRICE_IN=<ドル> PRICE_OUT=<ドル> で、100万トークンあたりの単価を変えられる（費用の見積もりに使う）
//
// やること: test-receipts/ の画像を、Code.gs の readReceipt_（本番と同じ指示・同じ判定）で読み取り、
//           answers.csv の正解と比べる。結果は tests/accuracy-results/<日時>-<モデル>.md に残す（前の結果は消さない）。
// 合格の条件: 「色が付かずに通った行（緑）」のうち、間違いが 0 件。
//           （間違いは、赤・黄色で人に知らせられればよい。知らせずに通るものを 0 にする）
//           expect 列が red の領収書（日付・金額がない、領収書でない）は、赤になれば正解。
// 終了コード: 0 合格 / 1 不合格 / 2 実行できなかった（キーがない・利用枠の上限など）
// 同じ条件で2回実行し、結果がどれくらいぶれるかも見ておく（ぶれより小さい差は、良くなった・悪くなったと判断しない）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { load, DEMO_DIR } = require('./helper');

// 費用の見積もりに使う単価（100万トークンあたりのドル）。Gemini 3.8 Flash の 2026-10 時点の単価
// （2027-01-01 から上がる予定。本番の前に料金ページで確かめる）
const PRICE_IN = Number(process.env.PRICE_IN || 0.75);
const PRICE_OUT = Number(process.env.PRICE_OUT || 3.75);
const YEN_PER_DOLLAR = Number(process.env.YEN_PER_DOLLAR || 150);
const CATEGORY_TARGET = 0.9; // 勘定科目の合格の目安（9割以上。違っていても、経費表で選び直せる）

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

// 本番と同じ名前（GEMINI_API_KEY など）の環境変数から、スクリプトプロパティの偽物を作る
const KEY_NAMES = ['GEMINI_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY'];
const props = {};
for (const name of [...KEY_NAMES, 'AI_PROVIDER', 'AI_MODEL']) {
  if (process.env[name]) props[name] = process.env[name];
}
if (process.env.ACCURACY_FAKE && !KEY_NAMES.some((n) => props[n])) props.GEMINI_API_KEY = 'FAKE';
if (!KEY_NAMES.some((n) => props[n])) {
  console.error('APIキーが設定されていません。例: GEMINI_API_KEY=<キー> node days/day01-receipt-ocr/tests/accuracy.js');
  process.exit(2);
}

const env = load({ props, realAI: true });
const { ctx } = env;
const model = ctx.getAIConfig_().model;
// プロンプトの版: 本番と同じ readReceipt_ の中身から作る短い印。指示を変えると変わる
const promptVersion = crypto.createHash('sha256').update(ctx.readReceipt_.toString()).digest('hex').slice(0, 8);

// GAS の UrlFetchApp は同期で返すので、curl を同期で呼んで同じ形にする。使ったトークンの量もここで数える
const usage = { input: 0, output: 0, calls: 0 };
ctx.UrlFetchApp.fetch = (url, o) => {
  const a = ['-sS', '-X', (o.method || 'get').toUpperCase(), '-H', `Content-Type: ${o.contentType || 'application/json'}`];
  for (const [k, v] of Object.entries(o.headers || {})) a.push('-H', `${k}: ${v}`);
  a.push('--data-binary', '@-', '-w', '\n%{http_code}', url);
  const r = spawnSync('curl', a, { input: o.payload || '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`curl が失敗しました: ${r.error ? r.error.message : r.stderr}`);
  const i = r.stdout.lastIndexOf('\n');
  const code = Number(r.stdout.slice(i + 1));
  const body = r.stdout.slice(0, i);
  countUsage(body);
  return { getResponseCode: () => code, getContentText: () => body };
};
ctx.Utilities.sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** AIの返事から、使ったトークンの量を足す（Gemini・Claude・OpenAI で書き方が違う。考えた分も出力として数える） */
function countUsage(body) {
  let j;
  try { j = JSON.parse(body); } catch (e) { return; }
  const g = j.usageMetadata;
  const c = j.usage;
  if (g) { usage.input += g.promptTokenCount || 0; usage.output += (g.candidatesTokenCount || 0) + (g.thoughtsTokenCount || 0); }
  else if (c && 'input_tokens' in c) { usage.input += c.input_tokens || 0; usage.output += c.output_tokens || 0; }
  else if (c) { usage.input += c.prompt_tokens || 0; usage.output += c.completion_tokens || 0; }
  else return;
  usage.calls++;
}

// 正解の一覧（先頭の BOM を除く）
const dir = path.join(DEMO_DIR, 'test-receipts');
const rows = fs.readFileSync(path.join(dir, 'answers.csv'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
const head = rows.shift().split(',');
let answers = rows.map((line) => Object.fromEntries(line.split(',').map((v, i) => [head[i], v ?? ''])));
if (flag('--extras')) answers = answers.filter((a) => a.file.startsWith('extra_'));
else if (!flag('--all')) answers = answers.slice(0, Number(opt('--limit', 10)));

const categories = [...ctx.CONFIG.DEFAULT_CATEGORIES];
const today = process.env.TODAY || new Date().toISOString().slice(0, 10);
/** 年のない日付（--MM-DD）は、今日から見て直近の過去の年にする（プロンプトの指示と同じ） */
const resolveDate = (d) => {
  if (!d.startsWith('--')) return d;
  const md = d.slice(2);
  const y = Number(today.slice(0, 4)) - (md > today.slice(5) ? 1 : 0);
  return `${y}-${md}`;
};
answers.forEach((a) => { a.date = resolveDate(a.date); });

if (process.env.ACCURACY_FAKE) {
  // このスクリプト自体の確認用: AIを呼ばず、正解を返す（5枚に1枚は金額を間違え、自信度を高く返す）
  const byName = Object.fromEntries(answers.map((a) => [a.file, a]));
  let n = 0;
  ctx.readReceipt_ = (blob) => {
    const a = byName[blob.getName()];
    n++;
    if (a.expect === 'red') return { date: '', store: a.store, amount: 0, category: a.category || categories[0], confidence: 20 };
    return { date: a.date, store: a.store, amount: n % 5 === 0 ? Number(a.amount) + 1 : Number(a.amount), category: a.category, confidence: n % 7 === 0 ? 70 : 95 };
  };
}
const warnAt = ctx.numberSetting_('CONFIDENCE_WARN', ctx.CONFIG.CONFIDENCE_WARN, 0, 100);
const failAt = ctx.numberSetting_('CONFIDENCE_FAIL', ctx.CONFIG.CONFIDENCE_FAIL, 0, 100);
const norm = (s) => ctx.normalizeStore_(s);
const FIELDS = ['date', 'store', 'amount'];
const isEmpty = (f, v) => (f === 'amount' ? !(Number(v) > 0) : String(v || '').trim() === '');
/** 間違いの種類: 読み違い（値が違う）／空欄（あるのに読めなかった）／作った値（ないのに値を入れた） */
const errorKind = (f, ans, got) => (isEmpty(f, ans) ? '作った値' : isEmpty(f, got) ? '空欄' : '読み違い');

const results = [];
const started = Date.now();
for (const ans of answers) {
  const bytes = fs.readFileSync(path.join(dir, ans.file));
  const type = ans.file.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
  const blob = { getContentType: () => type, getBytes: () => [...bytes], getName: () => ans.file };
  let r;
  let state; // green=色なし / yellow=黄色 / red=赤
  try {
    r = ctx.readReceipt_(blob, categories, today);
    const conf = Number(r.confidence) || 0;
    if (conf < failAt || !ctx.isPlausible_(r)) state = 'red';
    else if (conf < warnAt || ctx.dateWarning_(r.date, today)) state = 'yellow';
    else state = 'green';
  } catch (e) {
    if (e instanceof ctx.AdminError) {
      console.error(`\n[${e.code}] ${e.message}\n${e.detail}`);
      console.error(e.code === 'E05' ? '→ AIの利用枠の上限です。利用枠が戻ってから、もう一度実行してください。' : '→ 管理者向けのエラーで止まりました。');
      process.exit(2);
    }
    if (e instanceof ctx.RetryLaterError) { console.error('\nAIが混雑しています。少し待って、もう一度実行してください。'); process.exit(2); }
    state = 'red';
    r = { date: '', store: '', amount: 0, category: '', confidence: 0 };
  }
  const expectRed = ans.expect === 'red';
  // 店名は、表記ゆれをそろえたうえで完全に一致するか（支店名が抜けたら間違い。店別勘定科目が当たらなくなるため）
  const ok = {
    date: r.date === ans.date,
    store: !!r.store && norm(r.store) === norm(ans.store),
    amount: Number(r.amount) === Number(ans.amount) && !isEmpty('amount', ans.amount),
    category: r.category === ans.category,
  };
  const allOk = expectRed ? state === 'red' : FIELDS.every((f) => ok[f]);
  const wrong = expectRed ? [] : FIELDS.filter((f) => !ok[f]).map((f) => ({ f, kind: errorKind(f, ans[f], r[f]) }));
  // 赤になるべき領収書で、ない項目に値を入れていたら「作った値」として数える
  if (expectRed) FIELDS.filter((f) => isEmpty(f, ans[f]) && !isEmpty(f, r[f])).forEach((f) => wrong.push({ f, kind: '作った値' }));
  results.push({ ans, r, state, ok, allOk, wrong, expectRed, conf: Number(r.confidence) || 0 });
  process.stdout.write(`${state === 'green' ? '○' : state === 'yellow' ? '△' : '×'}${allOk ? '' : '!'}`);
}
const seconds = (Date.now() - started) / 1000;

// 集計
const total = results.length;
const by = (s) => results.filter((x) => x.state === s);
const green = by('green');
const silentErrors = green.filter((x) => !x.allOk); // 色が付かずに、間違って通ったもの
const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '-');
const normal = results.filter((x) => !x.expectRed);
const fieldRate = (f) => pct(normal.filter((x) => x.ok[f]).length, normal.length);
const categoryRate = normal.length ? normal.filter((x) => x.ok.category).length / normal.length : 0;
const qualities = [...new Set(results.map((x) => x.ans.quality))];
const yen = (usd) => `約${Math.round(usd * YEN_PER_DOLLAR * 10) / 10}円`;

const lines = [];
lines.push('# 読み取りの正確さ（実際のAI）', '');
lines.push(`- 実行: ${new Date().toISOString()}（${total}枚、${Math.round(seconds)}秒、1枚あたり ${(seconds / total).toFixed(1)}秒）`);
lines.push(`- モデル: ${model}　プロンプトの版: ${promptVersion}　自信度の基準: 黄色 ${warnAt} 未満／赤 ${failAt} 未満　今日: ${today}`);
if (usage.calls) {
  const usd = (usage.input * PRICE_IN + usage.output * PRICE_OUT) / 1e6;
  lines.push(`- 使った量: 入力 ${usage.input}・出力 ${usage.output} トークン（${usage.calls}回）。費用 ${yen(usd)}、100枚あたり ${yen((usd / usage.calls) * 100)}`
    + `（単価 入力 $${PRICE_IN}・出力 $${PRICE_OUT}／100万トークン、1ドル ${YEN_PER_DOLLAR}円で計算）`);
}
lines.push('', '## 項目ごとの一致率（例外の領収書を除く）', '', '| 日付 | 店名 | 金額 | 勘定科目 |', '|---|---|---|---|');
lines.push(`| ${fieldRate('date')} | ${fieldRate('store')} | ${fieldRate('amount')} | ${fieldRate('category')} |`);
lines.push('', `勘定科目: ${pct(Math.round(categoryRate * normal.length), normal.length)}（目安 ${CATEGORY_TARGET * 100}%以上 → ${categoryRate >= CATEGORY_TARGET ? '達成' : '未達'}）`);
lines.push('', '## 画面での扱い', '', '| 扱い | 枚数 | 割合 | うち、正しい（例外は赤になれば正しい） |', '|---|---|---|---|');
for (const [label, s] of [['色なし（緑）', 'green'], ['黄色（要確認）', 'yellow'], ['赤（読み取れなかった）', 'red']]) {
  const g = by(s);
  lines.push(`| ${label} | ${g.length} | ${pct(g.length, total)} | ${g.filter((x) => x.allOk).length} |`);
}
lines.push('', `**色が付かずに間違って通った行: ${silentErrors.length}件**（合格の条件は 0 件）`);

// 自信度の帯ごと: 黄色・赤の基準を決め直すための材料（ノウハウ/AIの精度の確かめ方.md の 4）
lines.push('', '## 自信度の帯ごと（基準を決め直す材料）', '', '| 自信度 | 枚数 | 正しい | 間違い | 正解率 |', '|---|---|---|---|---|');
for (const [label, lo, hi] of [['90以上', 90, 101], ['70〜89', 70, 90], ['50〜69', 50, 70], ['50未満', 0, 50]]) {
  const g = normal.filter((x) => x.conf >= lo && x.conf < hi);
  const okN = g.filter((x) => x.allOk).length;
  lines.push(`| ${label} | ${g.length} | ${okN} | ${g.length - okN} | ${pct(okN, g.length)} |`);
}
lines.push('', '黄色の基準は、「その値以上で、間違いがほぼ0件」になる一番低い値にする。黄色の割合が増えすぎると、人が確かめる手間が増える。');

if (qualities.length > 1) {
  lines.push('', '## 写真の状態・例外の種類ごと', '', '| 状態 | 枚数 | 正しい | 色なしで間違い |', '|---|---|---|---|');
  for (const q of qualities) {
    const g = results.filter((x) => x.ans.quality === q);
    lines.push(`| ${q} | ${g.length} | ${g.filter((x) => x.allOk).length} | ${g.filter((x) => x.state === 'green' && !x.allOk).length} |`);
  }
}

const kinds = {};
results.forEach((x) => x.wrong.forEach((w) => { kinds[w.kind] = (kinds[w.kind] || 0) + 1; }));
lines.push('', '## 間違いの種類（項目の数）', '', '| 読み違い | 空欄 | 作った値 |', '|---|---|---|');
lines.push(`| ${kinds['読み違い'] || 0} | ${kinds['空欄'] || 0} | ${kinds['作った値'] || 0} |`);
lines.push('', '読み違い・空欄はプロンプトや写真の撮り方、作った値はプロンプトの「推測で埋めない」の指示とプログラムのチェックを見直す。');

if (silentErrors.length) {
  lines.push('', '## 色なしで間違った行', '', '| ファイル | 項目 | 種類 | 正解 | AIの答え | 自信度 |', '|---|---|---|---|---|---|');
  for (const x of silentErrors) {
    for (const w of x.wrong) lines.push(`| ${x.ans.file} | ${w.f} | ${w.kind} | ${x.ans[w.f]} | ${x.r[w.f]} | ${x.r.confidence} |`);
    if (x.expectRed && !x.wrong.length) lines.push(`| ${x.ans.file} | - | 赤になるべきなのに通った | - | ${FIELDS.map((f) => x.r[f]).join(' / ')} | ${x.r.confidence} |`);
  }
}
const text = lines.join('\n');
console.log(`\n\n${text}`);
// 結果は日時とモデルの名前を付けて残す（前の結果と並べて比べられるように）
const outDir = path.join(__dirname, 'accuracy-results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
const outFile = path.join(outDir, `${stamp}-${process.env.ACCURACY_FAKE ? 'fake' : model}.md`);
fs.writeFileSync(outFile, `${text}\n`, 'utf8');
console.log(`\n結果: ${path.relative(process.cwd(), outFile)}`);
process.exit(silentErrors.length === 0 ? 0 : 1);
