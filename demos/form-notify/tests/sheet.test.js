// シートの作り・見た目・誤った操作・ファイルの設定のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, setup, sampleAnswers, findLabel } = require('./helper');

const DIR = path.join(__dirname, '..');
const H = 4;
const list = (t) => t.ss.getSheetByName('問い合わせ一覧');

test('N30 開くと、メニュー（送り直す・始める・止める）と、一覧・担当者シートができる。元のシートのまま', () => {
  const t = load();
  t.ctx.onOpen();
  const menu = t.ss.menus[0];
  assert.equal(menu.title, '問い合わせ管理');
  assert.deepEqual(menu.items.map((i) => i[1]).filter(Boolean), ['resendNotifications', 'startNotifications', 'stopNotifications']);
  assert.equal(t.ss.sheets[0].getName(), '問い合わせ一覧');
  assert.equal(t.ss.sheets[1].getName(), '担当者');
  assert.equal(t.ss.active.getName(), 'フォームの回答 1');
  const h = list(t).header(H);
  assert.deepEqual(h.slice(0, 4), ['受付番号', '受付日時', '状態', '担当者']);
  assert.deepEqual(h.slice(-4), ['メモ', '通知', '確認事項', '回答ID']);
});

test('N31 開き直しても、列やシートは増えない', () => {
  const t = load();
  t.ctx.onOpen();
  const before = list(t).header(H).length;
  t.ctx.onOpen();
  assert.equal(list(t).header(H).length, before);
  assert.equal(t.ss.sheets.length, 3);
  assert.equal(list(t).protections.length, 1);
});

test('V01 見た目：見出しは固定、状態は選択肢（未対応・対応済み）と色、メモは薄い青、回答IDは隠す、受付番号は見出しも右揃え', () => {
  const t = load();
  setup(t);
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const s = list(t);
  assert.equal(s.frozen, H);
  const statusCol = s.col('状態', H);
  const v = s.validations.find((x) => x.col === statusCol && x.row === H + 1);
  assert.deepEqual([...v.rule.list], ['未対応', '対応済み']);
  assert.equal(v.rule.allowInvalid, false);
  assert.deepEqual(s.rules.map((r) => [r.text, r.bg]), [['未対応', '#f4cccc'], ['対応済み', '#d9ead3']]);
  assert.equal(s.bgOf(H + 1, s.col('メモ', H)), t.ctx.INPUT_COLOR);
  assert.ok(s.hidden.includes(s.col('回答ID', H)));
  assert.ok(s.aligns.some((a) => a.col === 1 && a.row === H && a.a === 'right'));
  assert.equal(s.getColumnWidth(s.col('お問い合わせ内容', H)), 360);
  assert.equal(s.getColumnWidth(s.col('確認事項', H)), 320);
});

test('V07 フォームの質問の列は、右の「メモ」の入力の色（薄い青）を引き継がない', () => {
  const t = load();
  t.ctx.onOpen(); // 質問の列がないまま、メモの列に薄い青が付く
  setup(t);
  const s = list(t);
  // 本物と同じく、足した列は右の列の色を引き継ぐ
  const orig = s.insertColumnBefore.bind(s);
  s.insertColumnBefore = (col) => { orig(col); for (let r = H + 1; r <= H + 3; r++) s.bg.set(`${r},${col}`, s.bgOf(r, col + 1)); };
  const { FakeItem, ItemType } = require('./helper');
  t.form.items.push(new FakeItem(6, 'ご希望の日', ItemType.TEXT));
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.equal(s.bgOf(H + 1, s.col('ご希望の日', H)), null);
  assert.equal(s.bgOf(H + 1, s.col('メモ', H)), t.ctx.INPUT_COLOR);
});

test('V02状態の色を付け直しても、使う人が足した条件付き書式は残る', () => {
  const t = load();
  t.ctx.onOpen();
  const s = list(t);
  s.rules.push({ text: 'mine', getBooleanCondition: () => ({ getCriteriaType: () => 'TEXT_CONTAINS', getCriteriaValues: () => ['至急'] }) });
  t.ctx.onOpen();
  assert.equal(s.rules.length, 3);
  assert.equal(s.rules[0].text, 'mine');
});

test('V03 使う人が変えた列幅は戻さない', () => {
  const t = load();
  t.ctx.onOpen();
  const s = list(t);
  s.setColumnWidth(s.col('メモ', H), 500);
  t.ctx.onOpen();
  assert.equal(s.getColumnWidth(s.col('メモ', H)), 500);
});

test('M01 一覧の上の説明の行を削除しても、行を足して見出しを4行目に戻す（見出しやデータは上書きしない）', () => {
  const t = load();
  setup(t);
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const s = list(t);
  s.deleteRow(1);
  s.deleteRow(1);
  t.ctx.onOpen();
  assert.equal(s.get(H, 1), '受付番号');
  assert.equal(s.rowObj(H + 1, H)['お名前'], '山田 太郎');
  assert.match(s.get(1, 1), /状態/);
});

test('M02 一覧の見出しの行を消されたら、推測で書かずに E15 で止める', () => {
  const t = load();
  setup(t);
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const s = list(t);
  s.deleteRow(H);
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  assert.ok(t.env.mails.some((m) => m.to === 'admin@example.com' && /E15/.test(m.body)));
  assert.equal(s.getLastRow(), H); // データは増えていない
});

test('M03 一覧の列を並べ替えても、名前で探して正しい列に書く', () => {
  const t = load();
  setup(t);
  const s = list(t);
  // 「状態」と「受付日時」を入れ替える
  const a = s.col('状態', H);
  const b = s.col('受付日時', H);
  s.set(H, a, '受付日時');
  s.set(H, b, '状態');
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.equal(s.get(H + 1, b), '未対応');
  assert.ok(s.get(H + 1, a) instanceof t.ctx.VMDate);
});

test('M04 管理用の列を消されても、一番右に作り直す', () => {
  const t = load();
  t.ctx.onOpen();
  const s = list(t);
  s.set(H, s.col('メモ', H), '');
  t.ctx.onOpen();
  assert.ok(s.col('メモ', H) > 0);
});

test('M05 「確認事項」を消すと行の色が戻る（メモの薄い青は残る）。別の列を消しても色は残る', () => {
  const t = load();
  setup(t, { people: [['お見積もり', '佐藤', 'sato@example.com']] });
  t.form.submit(sampleAnswers({ お問い合わせの種類: 'その他' }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const s = list(t);
  const noteCol = s.col('確認事項', H);
  const memoCol = s.col('メモ', H);
  s.set(H + 1, memoCol, '');
  t.ctx.onEdit({ range: s.getRange(H + 1, memoCol) });
  assert.equal(s.bgOf(H + 1, 1), t.ctx.ERROR_ROW_COLOR);
  s.set(H + 1, noteCol, '');
  t.ctx.onEdit({ range: s.getRange(H + 1, noteCol) });
  assert.equal(s.bgOf(H + 1, 1), null);
  assert.equal(s.bgOf(H + 1, memoCol), t.ctx.INPUT_COLOR);
});

test('M06 担当者シート：答えはフォームの選択肢と（それ以外）から選ぶ。質問はフォームの選択式の質問から選ぶ。初めは選択肢が書かれる', () => {
  const t = load();
  setup(t, { people: [] });
  const staff = t.ss.getSheetByName('担当者');
  const h = findLabel(staff, '答え');
  // setup で表を消す前の状態を確かめるため、もう一度始め直す
  const t2 = load();
  t2.ctx.onOpen();
  const st2 = t2.ss.getSheetByName('担当者');
  st2.set(findLabel(st2, '管理者のメールアドレス'), 2, 'admin@example.com');
  t2.ctx.startNotifications();
  const h2 = findLabel(st2, '答え');
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => st2.get(h2 + i, 1)), ['商品について', 'ご予約・ご注文', 'お見積もり', 'その他', '（それ以外）']);
  const ansRule = st2.validations.find((v) => v.col === 1 && v.row === h2 + 1).rule;
  assert.deepEqual(ansRule.list, ['商品について', 'ご予約・ご注文', 'お見積もり', 'その他', '（それ以外）']);
  const qRow = findLabel(st2, '担当者を決める質問');
  assert.deepEqual(st2.validations.find((v) => v.col === 2 && v.row === qRow).rule.list, ['お問い合わせの種類']);
  assert.ok(h > 0);
});

test('M07 担当者シート：答えがフォームの選択肢にない行（打ち間違い）は黄色にして理由を書き、その人には送らない', () => {
  const t = load();
  setup(t, { people: [['お見積り', '佐藤', 'sato@example.com'], ['（それ以外）', '事務', 'jimu@example.com']] });
  t.env.mails = [];
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const staff = t.ss.getSheetByName('担当者');
  const h = findLabel(staff, '答え');
  assert.equal(staff.bgOf(h + 1, 1), t.ctx.WARN_ROW_COLOR);
  assert.match(staff.get(h + 1, 4), /選択肢にありません/);
  assert.equal(t.env.mails[0].to, 'jimu@example.com');
  // 直すと、黄色が消える
  staff.set(h + 1, 1, 'お見積もり');
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  assert.equal(staff.get(h + 1, 4), '');
  assert.equal(staff.bgOf(h + 1, 1), t.ctx.INPUT_COLOR);
});

test('M08 担当者シート：メールアドレスの形が違う行（貼り付けで入った）は黄色', () => {
  const t = load();
  setup(t, { people: [['お見積もり', '佐藤', 'sato@example'], ['（それ以外）', '事務', 'jimu@example.com']] });
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const staff = t.ss.getSheetByName('担当者');
  assert.match(staff.get(findLabel(staff, '答え') + 1, 4), /メールアドレスの形/);
});

test('M09 担当者シート：設定の行を消されても、表の上に足し直す。表の中身は消えない', () => {
  const t = load();
  setup(t);
  const staff = t.ss.getSheetByName('担当者');
  staff.deleteRow(findLabel(staff, '管理者のメールアドレス'));
  t.ctx.onOpen();
  const adminRow = findLabel(staff, '管理者のメールアドレス');
  const h = findLabel(staff, '答え');
  assert.ok(adminRow > 0 && adminRow < h);
  assert.equal(staff.get(h + 1, 3), 'sato@example.com');
});

test('M15 担当者シートに設定の行を足すとき、下の見出しの書式を引き継がない', () => {
  const t = load();
  setup(t);
  const staff = t.ss.getSheetByName('担当者');
  const h = findLabel(staff, '答え');
  // 本物と同じく、足した行は下の見出しのグレーを引き継ぐ
  const orig = staff.insertRowBefore.bind(staff);
  staff.insertRowBefore = (row) => { orig(row); for (let c = 1; c <= 4; c++) staff.bg.set(`${row},${c}`, '#f3f3f3'); };
  staff.deleteRow(findLabel(staff, 'リマインドの時刻'));
  t.ctx.onOpen();
  const row = findLabel(staff, 'リマインドの時刻');
  assert.ok(row > 0 && row < findLabel(staff, '答え'));
  assert.notEqual(staff.bgOf(row, 1), '#f3f3f3');
  assert.ok(h > 0);
});

test('M10 担当者シート：見出しを消されたら E15（表を推測で読まない）', () => {
  const t = load();
  setup(t);
  const staff = t.ss.getSheetByName('担当者');
  staff.deleteRow(findLabel(staff, '答え'));
  assert.throws(() => t.ctx.readStaff_(), /見出しの行が見つかりません/);
});

test('M11 一覧のシートを消されても、次の回答で作り直して入れる（受付番号は続きから）', () => {
  const t = load();
  setup(t);
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  t.ss.sheets = t.ss.sheets.filter((s) => s.getName() !== '問い合わせ一覧');
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  assert.equal(list(t).rowObj(H + 1, H)['受付番号'], 2);
});

test('M12 一覧の行が足りなくなっても、行を足して書き込む', () => {
  const t = load();
  setup(t);
  list(t).maxRows = H + 1;
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  assert.equal(list(t).getLastRow(), H + 2);
});

test('N32 止めていないのに「通知を止める」→「いいえ」なら止めない。止めた状態で押すと、止まっていると出る', () => {
  const t = load();
  setup(t);
  t.env.uiAnswers = ['NO'];
  t.ctx.stopNotifications();
  assert.equal(t.env.props[t.ctx.PROP.STOPPED], undefined);
  t.ctx.stopNotifications();
  t.ctx.stopNotifications();
  assert.match(t.env.alerts[t.env.alerts.length - 1].title, /止まっています/);
  const staff = t.ss.getSheetByName('担当者');
  assert.match(staff.get(findLabel(staff, '通知'), 2), /^停止中/);
});

test('N33 Errors.gs は lib/gas と同じ内容', () => {
  const a = fs.readFileSync(path.join(DIR, 'Errors.gs'), 'utf8');
  const b = fs.readFileSync(path.join(DIR, '..', '..', 'lib', 'gas', 'Errors.gs'), 'utf8');
  assert.equal(a, b);
});

test('N34 .claspignore は tests・md を除外し、appsscript.json は V8・Asia/Tokyo・必要な権限だけ', () => {
  const ignore = fs.readFileSync(path.join(DIR, '.claspignore'), 'utf8');
  assert.match(ignore, /tests\/\*\*/);
  assert.match(ignore, /\*\*\/\*\.md/);
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'Asia/Tokyo');
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.send_mail'));
  assert.ok(!manifest.oauthScopes.includes('https://mail.google.com/'));
});
