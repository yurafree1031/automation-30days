// シートの操作（編集したとき・メニュー・ボタンの作成）の手元テスト（node --test で実行）
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const RED = '#f4cccc';
const YELLOW = '#fff2cc';

/** 経費表に、2行目=赤・3行目=黄色・4行目=色なしの行を作る */
function expenseSheet(env) {
  const sheet = env.ss.add('経費表');
  sheet.getRange(1, 1, 1, 7).setValues([[...env.ctx.HEADER]]);
  sheet.getRange(2, 1, 3, 7).setValues([
    ['t', '', '', '', '', 'a.jpg', '読み取れませんでした。手入力するか、撮り直してください'],
    ['t', '2026-10-15', 'A', 100, '雑費', 'b.jpg', '読み取りが不確かです。画像と見比べてください'],
    ['t', '2026-10-16', 'B', 200, '雑費', 'c.jpg', ''],
  ]);
  sheet.getRange(2, 1, 1, 7).setBackground(RED);
  sheet.getRange(3, 1, 1, 7).setBackground(YELLOW);
  return sheet;
}
const bg = (sheet, row) => sheet.bg.get(`${row},1`) || null;

test('N21 確認事項を消すと、その行の色が元に戻る', () => {
  const env = load();
  const sheet = expenseSheet(env);
  sheet.getRange(3, 7).clearContent();
  env.ctx.onEdit({ range: sheet.getRange(3, 7) });
  assert.strictEqual(bg(sheet, 3), null);
  assert.strictEqual(bg(sheet, 2), RED); // ほかの行は変わらない
});

test('N22 確認事項を書き換えただけなら、色は残る', () => {
  const env = load();
  const sheet = expenseSheet(env);
  sheet.getRange(2, 7).setValue('手で直しました');
  env.ctx.onEdit({ range: sheet.getRange(2, 7) });
  assert.strictEqual(bg(sheet, 2), RED);
});

test('N23 複数行をまとめて消した場合: 空になった行だけ色が戻る', () => {
  const env = load();
  const sheet = expenseSheet(env);
  sheet.getRange(2, 7, 2, 1).clearContent();
  sheet.getRange(4, 7).setValue('メモ');
  env.ctx.onEdit({ range: sheet.getRange(2, 7, 3, 1) });
  assert.strictEqual(bg(sheet, 2), null);
  assert.strictEqual(bg(sheet, 3), null);
});

test('M12 誤操作: 確認事項以外の列を編集しても、色は変わらない', () => {
  const env = load();
  const sheet = expenseSheet(env);
  sheet.getRange(2, 4).setValue(500);
  env.ctx.onEdit({ range: sheet.getRange(2, 4) });
  assert.strictEqual(bg(sheet, 2), RED);
});

test('M13 誤操作: 見出し行や、ほかのシートを編集しても何も起きない', () => {
  const env = load();
  const sheet = expenseSheet(env);
  sheet.getRange(1, 7).setValue('');
  env.ctx.onEdit({ range: sheet.getRange(1, 7) });
  assert.strictEqual(bg(sheet, 1), null);
  const other = env.ss.add('設定');
  other.getRange(2, 7).setValue('');
  assert.doesNotThrow(() => env.ctx.onEdit({ range: other.getRange(2, 7) }));
});

test('N24 グラフシート: 表示（C2）を変えたら円グラフの期間（E2）を空に戻す。D2 を変えたらグラフを作り直す', () => {
  const env = load();
  const chart = env.ss.add('グラフ');
  const rebuilt = [];
  env.ctx.applyChartType_ = (s) => rebuilt.push(s.getName());

  chart.getRange('D2').setValue('棒グラフ');
  chart.getRange('E2').setValue('2026-10');
  chart.getRange('C2').setValue('年別');
  env.ctx.onEdit({ range: chart.getRange('C2') });
  assert.strictEqual(chart.getRange('E2').getValue(), '');
  assert.deepStrictEqual(rebuilt, []); // 棒グラフなら作り直さない

  chart.getRange('D2').setValue('円グラフ');
  env.ctx.onEdit({ range: chart.getRange('D2') });
  assert.deepStrictEqual(rebuilt, ['グラフ']);

  chart.getRange('E2').setValue('2026');
  env.ctx.onEdit({ range: chart.getRange('E2') }); // 円グラフのとき、期間を変えたらタイトルのため作り直す
  assert.strictEqual(rebuilt.length, 2);

  chart.getRange('C2').setValue('月別');
  env.ctx.onEdit({ range: chart.getRange('C2') }); // 円グラフのとき、単位を変えたら E2 を空にして作り直す
  assert.strictEqual(chart.getRange('E2').getValue(), '');
  assert.strictEqual(rebuilt.length, 3);
});

test('N25 グラフシート: 棒グラフのとき、期間（E2）を変えてもグラフは作り直さない', () => {
  const env = load();
  const chart = env.ss.add('グラフ');
  let n = 0;
  env.ctx.applyChartType_ = () => { n++; };
  chart.getRange('D2').setValue('棒グラフ');
  env.ctx.onEdit({ range: chart.getRange('E2') });
  assert.strictEqual(n, 0);
});

// ---- 操作メニュー「確認事項を一括クリア」 ----
test('N26 一括クリア: 「はい」で確認事項を消して色を戻す。金額が空の行（赤）は、手入力するまで残す【評価の指摘12】', () => {
  const env = load();
  const sheet = expenseSheet(env);
  env.ss.nextAnswer = 'YES';
  env.ctx.clearAllNotes();
  assert.strictEqual(env.ss.alerts.length, 1);
  for (const r of [3, 4]) {
    assert.strictEqual(sheet.getRange(r, 7).getValue(), '');
    assert.strictEqual(bg(sheet, r), null);
  }
  assert.strictEqual(sheet.getRange(2, 7).getValue(), '読み取れませんでした。手入力するか、撮り直してください');
  assert.strictEqual(bg(sheet, 2), RED);
  assert.strictEqual(sheet.getRange(1, 7).getValue(), '確認事項');
  assert.strictEqual(sheet.getRange(3, 3).getValue(), 'A');
  assert.strictEqual(env.ss.lastToast.message, '確認事項を消しました（金額が空の1件は、手入力するまで残しています）');
});

test('N37 一括クリア: 赤い行がなければ「すべて消しました」', () => {
  const env = load();
  const sheet = expenseSheet(env);
  sheet.getRange(2, 4).setValue(100); // 赤い行を手入力で直した
  env.ss.nextAnswer = 'YES';
  env.ctx.clearAllNotes();
  assert.strictEqual(bg(sheet, 2), null);
  assert.strictEqual(env.ss.lastToast.message, '確認事項をすべて消しました');
});

test('M14 誤操作: 一括クリアで「いいえ」を押したら、何も変えない', () => {
  const env = load();
  const sheet = expenseSheet(env);
  env.ss.nextAnswer = 'NO';
  env.ctx.clearAllNotes();
  assert.strictEqual(sheet.getRange(2, 7).getValue(), '読み取れませんでした。手入力するか、撮り直してください');
  assert.strictEqual(bg(sheet, 2), RED);
  assert.strictEqual(env.ss.toasts.length, 0);
});

test('M15 誤操作: 経費表がない・空のときに一括クリアしても、確認を出さずに案内する', () => {
  const env = load();
  env.ctx.clearAllNotes();
  assert.strictEqual(env.ss.lastToast.message, '経費表にデータがありません');
  env.ss.add('経費表').getRange(1, 1, 1, 7).setValues([[...env.ctx.HEADER]]);
  env.ctx.clearAllNotes();
  assert.strictEqual(env.ss.alerts.length, 0);
});

// ---- スプレッドシートを開いたとき・ボタン ----
test('N27 開いたとき: 操作メニューと、いちばん左の「実行」シート（説明とボタン）ができる', () => {
  const env = load();
  env.ctx.onOpen();
  assert.deepStrictEqual(env.ss.menus.map((m) => [m.title, m.items]), [['操作メニュー', [['確認事項を一括クリア', 'clearAllNotes']]]]);
  const run = env.ss.getSheets()[0];
  assert.strictEqual(run.getName(), '実行');
  assert.deepStrictEqual(run.getRange('B3:B5').getValues().map((r) => r[0]), [
    '1. 領収書の写真を、未処理フォルダに入れる',
    '2. 下のボタンを押す',
    '3. 画面右下に結果が出たら、「経費表」を確認する',
  ]);
  assert.strictEqual(run.getRange('B9').getValue(), '前回の結果');
  assert.strictEqual(run.getRange('B10').getValue(), 'まだ読み取りは実行されていません');
  const guide = run.getRange('B13:B17').getValues().map((r) => r[0]).join('\n');
  for (const word of ['赤い行', '黄色い行', '確認事項', '残り○枚', 'パソコンのブラウザ']) assert.ok(guide.includes(word), word);
  assert.strictEqual(run.images.length, 1);
  assert.strictEqual(run.images[0].script, 'processReceipts'); // 画像を押すと読み取りが動く
  assert.strictEqual(typeof env.ctx.processReceipts, 'function');
});

test('N28 開き直しても、ボタンを増やさない。ボタンだけ消えていたら置き直す', () => {
  const env = load();
  env.ctx.onOpen();
  env.ctx.onOpen();
  const run = env.ss.getSheetByName('実行');
  assert.strictEqual(run.images.length, 1);
  run.images.length = 0; // ボタンを消された
  env.ctx.onOpen();
  assert.strictEqual(run.images.length, 1);
});

test('M16 誤操作: 「実行」シートを消されたら、エディタから ensureRunSheet で作り直せる', () => {
  const env = load();
  env.ctx.onOpen();
  env.ss.sheets = env.ss.sheets.filter((s) => s.getName() !== '実行');
  env.ctx.ensureRunSheet();
  assert.ok(env.ss.getSheetByName('実行'));
  assert.ok(env.ss.getSheetByName('経費表'));
  assert.strictEqual(env.ss.getActiveSheet().getName(), '実行');
});

test('M17 誤操作: ボタンを作れなくても、スプレッドシートは開ける（onOpen は例外を出さない）', () => {
  const env = load();
  env.ctx.ensureRunSheet_ = () => { throw new Error('権限がありません'); };
  assert.doesNotThrow(() => env.ctx.onOpen());
  assert.strictEqual(env.ss.menus.length, 1);
});
