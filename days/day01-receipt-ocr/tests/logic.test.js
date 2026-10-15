// Code.gs・Chart.gs の細かい処理（店名の照合・値のチェック・設定の読み取りなど）の手元テスト（node --test で実行）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { load, plain, DEMO_DIR } = require('./helper');

// ---- 店名の表記ゆれ（T-N06〜T-N09） ----
test('N06 店名の表記ゆれ: 全角/半角・大文字小文字・ひらがな・会社の種類・空白がそろう', () => {
  const { ctx } = load();
  const same = (a, b) => assert.strictEqual(ctx.normalizeStore_(a), ctx.normalizeStore_(b), `${a} と ${b}`);
  same('株式会社スターバックス', 'スターバックス');
  same('ｽﾀｰﾊﾞｯｸｽ', 'スターバックス'); // 半角カナ
  same('すたーばっくす', 'スターバックス'); // ひらがな
  same('(株)セブン-イレブン', 'セブンイレブン');
  same('㈱セブン‐イレブン', 'セブンイレブン');
  same('ＡＢＣ　ストア', 'abc ストア'); // 全角英字・全角空白
  same('スターバックス・コーヒー', 'スターバックスコーヒー');
});

function rulesFor(env, rows) {
  const sheet = env.setStoreRules(rows);
  return env.ctx.getStoreRules_(sheet);
}

test('N07 店別勘定科目: 登録した言葉がすべて含まれていれば当たる（支店名の間に別の言葉があってもよい）', () => {
  const env = load();
  const rules = rulesFor(env, [['スターバックス', '会議費'], ['スターバックス 渋谷店', '接待交際費'], ['JR東日本', '旅費交通費']]);
  const find = (store) => env.ctx.findStoreCategory_(rules, store);
  assert.strictEqual(find('スターバックス コーヒー 新宿店'), '会議費');
  assert.strictEqual(find('スターバックス コーヒー 渋谷店'), '接待交際費'); // 詳しいほうが優先
  assert.strictEqual(find('ｽﾀｰﾊﾞｯｸｽ渋谷店'), '接待交際費'); // 表記ゆれがあっても当たる
  assert.strictEqual(find('東日本旅客鉄道 JR東日本'), '旅費交通費');
});

test('N08 店別勘定科目: 登録がない店・店名が空なら空文字（AIの判断を使う）', () => {
  const env = load();
  const rules = rulesFor(env, [['スターバックス', '会議費']]);
  assert.strictEqual(env.ctx.findStoreCategory_(rules, 'ドトールコーヒー'), '');
  assert.strictEqual(env.ctx.findStoreCategory_(rules, ''), '');
  assert.strictEqual(env.ctx.findStoreCategory_([], 'スターバックス'), '');
});

test('M05 誤操作: 店別勘定科目の空行・勘定科目だけ／店名だけの行は無視される', () => {
  const env = load();
  const rules = rulesFor(env, [['', ''], ['スターバックス', ''], ['', '会議費'], ['ドトール', '会議費']]);
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(env.ctx.findStoreCategory_(rules, 'ドトールコーヒー'), '会議費');
});

test('M06 誤操作: 店別勘定科目の表に何も登録していなくても動く', () => {
  const env = load();
  const sheet = env.ctx.ensureStoreRulesSheet_();
  assert.deepStrictEqual(plain(env.ctx.getStoreRules_(sheet)), []);
});

// ---- 値のチェック（T-E03〜） ----
test('E03 読み取った値のチェック: 正しい形は通り、ありえない値は弾く', () => {
  const { ctx } = load();
  const ok = { date: '2026-10-15', store: 'セブンイレブン', amount: 1280 };
  assert.strictEqual(ctx.isPlausible_(ok), true);
  assert.strictEqual(ctx.isPlausible_({ ...ok, amount: '1280' }), true); // 文字で返ってきても数字なら通る
  const bad = [
    ['日付の形が違う', { ...ok, date: '2026/10/15' }],
    ['日付が空', { ...ok, date: '' }],
    ['月が13', { ...ok, date: '2026-13-01' }],
    ['金額が0', { ...ok, amount: 0 }],
    ['金額がマイナス', { ...ok, amount: -100 }],
    ['金額が数字でない', { ...ok, amount: 'abc' }],
    ['金額が空', { ...ok, amount: '' }],
    ['店名が空', { ...ok, store: '' }],
    ['店名が不明', { ...ok, store: '不明' }],
    ['店名が空白だけ', { ...ok, store: '  ' }],
  ];
  for (const [label, r] of bad) assert.strictEqual(ctx.isPlausible_(r), false, label);
});

test('E04 読み取った値のチェック: 存在しない日付（2月31日）を弾く', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.isPlausible_({ date: '2026-02-31', store: 'A', amount: 100 }), false);
});

test('E05 日付の注意: 今日より先・1年以上前は確認を求める。今日・ちょうど1年前は問題なし', () => {
  const { ctx } = load();
  const w = (d) => ctx.dateWarning_(d, '2026-10-15');
  assert.strictEqual(w('2026-10-15'), '');
  assert.strictEqual(w('2025-10-15'), '');
  assert.strictEqual(w('2026-01-01'), '');
  assert.match(w('2026-10-16'), /今日より先/);
  assert.match(w('2025-10-14'), /1年以上前/);
  assert.match(w('2024-12-31'), /1年以上前/);
});

test('E17 実在する日付だけを通す（うるう年を含む）', () => {
  const { ctx } = load();
  const ok = (date) => ctx.isPlausible_({ date, store: 'A', amount: 100 });
  assert.strictEqual(ok('2024-02-29'), true);
  assert.strictEqual(ok('2025-02-29'), false);
  assert.strictEqual(ok('2026-04-31'), false);
  assert.strictEqual(ok('2026-00-10'), false);
  assert.strictEqual(ok('2026-10-00'), false);
  assert.strictEqual(ok('0026-10-15'), false);
});

// ---- 設定シートの読み取り ----
test('N10 勘定科目の候補: 初回は初期値を書き込み、あとは設定シートD列を使う', () => {
  const env = load();
  const { settings } = env.setup();
  assert.deepStrictEqual(plain(env.ctx.getCategories_(settings)), plain(env.ctx.CONFIG.DEFAULT_CATEGORIES));
  assert.strictEqual(settings.getRange('D1').getValue(), env.ctx.CONFIG.CATEGORY_HEADER);

  // 利用者が候補を書き換える（重複・空行・前後の空白があっても、きれいに読む）
  settings.getRange(2, 4, 8, 1).clearContent();
  settings.getRange(2, 4, 5, 1).setValues([['交通費'], [' 食費 '], [''], ['交通費'], ['備品']]);
  assert.deepStrictEqual(plain(env.ctx.getCategories_(settings)), ['交通費', '食費', '備品']);
});

test('M07 誤操作: 勘定科目の候補を全部消すと、空の一覧になる（run_ 側で案内する）', () => {
  const env = load();
  const { settings } = env.setup();
  env.ctx.getCategories_(settings);
  settings.getRange(2, 4, 8, 1).clearContent();
  assert.deepStrictEqual(plain(env.ctx.getCategories_(settings)), []);
});

test('N11 設定の読み取り: 前後の空白を除く。項目がなければ空文字', () => {
  const env = load();
  const { settings } = env.setup({ inboxUrl: '  https://drive.google.com/drive/folders/INBOX  ' });
  assert.strictEqual(env.ctx.getSetting_(settings, env.ctx.CONFIG.INBOX_LABEL), 'https://drive.google.com/drive/folders/INBOX');
  assert.strictEqual(env.ctx.getSetting_(settings, '存在しない項目'), '');
});

test('N12 フォルダを開く: URLでもIDだけでも開ける', () => {
  const env = load();
  env.setup();
  assert.strictEqual(env.ctx.openFolder_('https://drive.google.com/drive/folders/INBOX?usp=sharing', 'x').getId(), 'INBOX');
  assert.strictEqual(env.ctx.openFolder_('https://drive.google.com/drive/u/0/folders/DONE', 'x').getId(), 'DONE');
  assert.strictEqual(env.ctx.openFolder_('INBOX', 'x').getId(), 'INBOX');
});

test('E06 フォルダを開けないとき: 使用者向けのエラーで、設定シートを開く', () => {
  const env = load();
  env.setup();
  env.ss.getSheetByName('シート1').activate();
  assert.throws(
    () => env.ctx.openFolder_('https://drive.google.com/drive/folders/NOTHING', '未処理フォルダのURL'),
    (e) => e instanceof env.ctx.UserError && e.message.includes('「未処理フォルダのURL」のフォルダを開けません'),
  );
  assert.strictEqual(env.ss.getActiveSheet().getName(), '設定');
});

// ---- 配布物の確認 ----
test('N14 Day 1 の AI.gs・Errors.gs は、lib/gas の部品と同じ内容', () => {
  for (const f of ['AI.gs', 'Errors.gs']) {
    const lib = fs.readFileSync(path.join(DEMO_DIR, '..', '..', 'lib', 'gas', f), 'utf8');
    const demo = fs.readFileSync(path.join(DEMO_DIR, f), 'utf8');
    assert.strictEqual(demo, lib, `${f} が lib/gas と違います。直したほうを両方にそろえてください`);
  }
});

test('N15 clasp: tests・tools・test-receipts・md は Apps Script に送らない', () => {
  const ignore = fs.readFileSync(path.join(DEMO_DIR, '.claspignore'), 'utf8');
  for (const p of ['tests/**', 'tools/**', 'test-receipts/**', '**/*.md']) assert.ok(ignore.includes(p), p);
});

test('N16 appsscript.json: V8 と日本のタイムゾーン', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'appsscript.json'), 'utf8'));
  assert.strictEqual(m.runtimeVersion, 'V8');
  assert.strictEqual(m.timeZone, 'Asia/Tokyo');
});

test('V01 ボタン画像: PNG として読めて、縦横比が表示サイズ（280×60）と合っている', () => {
  const { ctx } = load();
  const bytes = Buffer.from(ctx.RUN_BUTTON_PNG_BASE64, 'base64');
  assert.deepStrictEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  assert.ok(Math.abs(w / h - 280 / 60) < 0.01, `${w}x${h}`);
});

test('M22 誤操作: 設定シートのD1（見出し）を消しても、D2以降の候補は初期値に戻らない【評価の指摘11】', () => {
  const env = load();
  const { settings } = env.setup();
  env.ctx.getCategories_(settings);
  settings.getRange(2, 4, 8, 1).clearContent();
  settings.getRange(2, 4, 2, 1).setValues([['交通費'], ['食費']]);
  settings.getRange('D1').clearContent();
  assert.deepStrictEqual(plain(env.ctx.getCategories_(settings)), ['交通費', '食費']);
  assert.strictEqual(settings.getRange('D1').getValue(), env.ctx.CONFIG.CATEGORY_HEADER);
});

test('M23 誤操作: D列が全部空なら、初期値を書き込み直す', () => {
  const env = load();
  const { settings } = env.setup();
  env.ctx.getCategories_(settings);
  settings.getRange(1, 4, 8, 1).clearContent();
  assert.deepStrictEqual(plain(env.ctx.getCategories_(settings)), plain(env.ctx.CONFIG.DEFAULT_CATEGORIES));
});

test('N36 同じ領収書の見分け: 日付・店名（表記ゆれをそろえる）・金額が同じなら同じキー。日付のセルがDateでも同じ', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.receiptKey_('2026-10-15', '株式会社セブンイレブン', 1280), ctx.receiptKey_('2026-10-15', 'ｾﾌﾞﾝｲﾚﾌﾞﾝ', '1280'));
  assert.notStrictEqual(ctx.receiptKey_('2026-10-15', 'A', 100), ctx.receiptKey_('2026-10-16', 'A', 100));
  const asDate = new Date('2026-10-15T00:00:00Z');
  assert.strictEqual(ctx.receiptKey_(asDate, 'A', 100), ctx.receiptKey_('2026-10-15', 'A', 100));
});
