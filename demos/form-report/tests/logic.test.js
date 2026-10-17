// 期間の区切り・集計の計算・メールの中身（シートに触らない計算）のテスト
const test = require('node:test');
const assert = require('node:assert');
const { load, jst } = require('./helper');

// GAS 側（vm の中）で作った配列・オブジェクトを、比べられる形にする
const plain = (v) => JSON.parse(JSON.stringify(v));

const weekly = { interval: '毎週', weekday: 1, hour: 9 };
const daily = { interval: '毎日', weekday: 1, hour: 9 };
const monthly = { interval: '毎月', weekday: 1, hour: 9 };

test('L01 毎週（月曜9時）: 月曜9時より前は前の前の週、9時を過ぎると前の週が終わった期間になる', () => {
  const { ctx } = load();
  const before = ctx.latestEnd_(jst(2026, 10, 19, 8, 59), weekly, true);
  const after = ctx.latestEnd_(jst(2026, 10, 19, 9, 0), weekly, true);
  assert.strictEqual(ctx.periodOf_(before, weekly).label, '2026/10/5(月)〜10/11(日)');
  assert.strictEqual(ctx.periodOf_(after, weekly).label, '2026/10/12(月)〜10/18(日)');
  // 時刻を見ないとき（「前回分を今すぐ送る」）は、月曜0時を過ぎれば前の週
  assert.strictEqual(ctx.periodOf_(ctx.latestEnd_(jst(2026, 10, 19, 1), weekly, false), weekly).label, '2026/10/12(月)〜10/18(日)');
});

test('L02 毎週（水曜）: 水曜の前の日までの7日間', () => {
  const { ctx } = load();
  const s = { ...weekly, weekday: 3 };
  const end = ctx.latestEnd_(jst(2026, 10, 17, 12), s, true);
  assert.strictEqual(ctx.periodOf_(end, s).label, '2026/10/7(水)〜10/13(火)');
});

test('L03 毎日: 前の日。毎月: 1日に前の月（年をまたいでも）', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.periodOf_(ctx.latestEnd_(jst(2026, 10, 17, 10), daily, true), daily).label, '2026/10/16(金)');
  assert.strictEqual(ctx.periodOf_(ctx.latestEnd_(jst(2026, 10, 17, 8), daily, true), daily).label, '2026/10/15(木)');
  assert.strictEqual(ctx.periodOf_(ctx.latestEnd_(jst(2027, 1, 1, 9), monthly, true), monthly).label, '2026年12月');
  assert.strictEqual(ctx.periodOf_(ctx.latestEnd_(jst(2027, 1, 1, 8), monthly, true), monthly).label, '2026年11月');
});

test('L04 期間の区切りは日本時間の0時（GASのプロジェクトの設定に左右されない）', () => {
  const { ctx } = load();
  const end = ctx.latestEnd_(jst(2026, 10, 19, 9), weekly, true);
  assert.strictEqual(end, jst(2026, 10, 19));
  assert.strictEqual(ctx.periodOf_(end, weekly).start, jst(2026, 10, 12));
});

test('L05 まだ送っていない期間は古い順に、多くても5期間', () => {
  const { ctx } = load();
  const due = ctx.duePeriods_(jst(2026, 10, 19, 10), weekly, jst(2026, 9, 28));
  assert.deepStrictEqual(plain(due).map((p) => p.label), ['2026/9/28(月)〜10/4(日)', '2026/10/5(月)〜10/11(日)', '2026/10/12(月)〜10/18(日)']);
  const many = ctx.duePeriods_(jst(2026, 10, 19, 10), weekly, jst(2026, 6, 1));
  assert.strictEqual(many.length, 5);
  assert.strictEqual(many[4].label, '2026/10/12(月)〜10/18(日)');
});

test('L06 次に送る日時: 送り終えていれば次の区切りの9時台、送る期間が残っていれば今', () => {
  const { ctx } = load();
  const now = jst(2026, 10, 17, 12);
  assert.strictEqual(ctx.sendTimeText_(ctx.nextSendTime_(now, weekly, jst(2026, 10, 12))), '10/19(月) 9時台');
  assert.strictEqual(ctx.nextSendTime_(now, weekly, jst(2026, 10, 5)), now);
});

const q = (title, kind, extra = {}) => ({ title, kind, choices: [], low: 1, high: 5, ...extra });
const row = (time, answers) => ({ time, answers });

test('L07 集計: 段階評価は平均（小数1桁）と点数ごとの件数。期間の外の回答は入れない', () => {
  const { ctx } = load();
  const period = ctx.periodOf_(jst(2026, 10, 19), weekly);
  const rows = [
    row(jst(2026, 10, 12, 0, 0), { 満足度: 5 }),
    row(jst(2026, 10, 15), { 満足度: 4 }),
    row(jst(2026, 10, 18, 23, 59), { 満足度: 4 }),
    row(jst(2026, 10, 19, 0, 0), { 満足度: 1 }), // 次の期間
    row(jst(2026, 10, 11, 23, 59), { 満足度: 1 }), // 前の期間
    row(jst(2026, 10, 16), { 満足度: '' }), // 答えていない
  ];
  const r = ctx.aggregate_([q('満足度', '段階評価')], rows, period);
  assert.strictEqual(r.count, 4);
  const item = r.items[0];
  assert.strictEqual(item.answered, 3);
  assert.strictEqual(item.average, 4.3);
  assert.deepStrictEqual(plain(item.buckets).map((b) => [b.label, b.count]), [['5', 1], ['4', 2], ['3', 0], ['2', 0], ['1', 0]]);
});

test('L08 集計: 選択式は選択肢ごとの件数。選択肢にない答えは「その他」', () => {
  const { ctx } = load();
  const period = ctx.periodOf_(jst(2026, 10, 19), weekly);
  const rows = ['SNS', 'SNS', 'チラシ', 'ホームページ', ''].map((v, i) => row(jst(2026, 10, 13 + i), { きっかけ: v }));
  const r = ctx.aggregate_([q('きっかけ', '選択式', { choices: ['ホームページ', 'SNS', '知人の紹介'] })], rows, period);
  assert.deepStrictEqual(plain(r.items[0].buckets).map((b) => [b.label, b.count]), [['ホームページ', 1], ['SNS', 2], ['知人の紹介', 0], ['その他', 1]]);
  assert.strictEqual(r.items[0].answered, 4);
});

test('L09 集計: 複数選択は「, 」で分ける。選択肢に「, 」が入っていても分けられる', () => {
  const { ctx } = load();
  const choices = ['料理の味', '価格, 量', '接客'];
  assert.deepStrictEqual(plain(ctx.splitCheckbox_('料理の味, 価格, 量', choices)), { found: ['料理の味', '価格, 量'], other: false });
  assert.deepStrictEqual(plain(ctx.splitCheckbox_('接客, 駐車場が広い', choices)), { found: ['接客'], other: true });
  const period = ctx.periodOf_(jst(2026, 10, 19), weekly);
  const rows = ['料理の味, 接客', '接客', '料理の味, 価格, 量'].map((v, i) => row(jst(2026, 10, 13 + i), { よかった点: v }));
  const r = ctx.aggregate_([q('よかった点', '複数選択', { choices })], rows, period);
  assert.deepStrictEqual(plain(r.items[0].buckets).map((b) => [b.label, b.count]), [['料理の味', 2], ['価格, 量', 1], ['接客', 2]]);
});

test('L10 メール: 件名に期間と件数。記述式は件数だけで、中身は載せない', () => {
  const t = load();
  const { ctx } = t;
  const period = ctx.periodOf_(jst(2026, 10, 19), weekly);
  const rows = [row(jst(2026, 10, 13), { 満足度: 5, ご意見: '店員さんが親切でした' }), row(jst(2026, 10, 14), { 満足度: 4, ご意見: '' })];
  const report = ctx.aggregate_([q('満足度', '段階評価'), q('ご意見', '記述式')], rows, period);
  const mail = ctx.buildMail_(report, t.answers);
  assert.strictEqual(mail.subject, '【アンケート集計】2026/10/12(月)〜10/18(日)　回答 2件');
  assert.match(mail.body, /平均 4\.5点（1〜5点、回答 2件）/);
  assert.match(mail.body, /5点：1件（50%）/);
  assert.match(mail.body, /記入 1件/);
  assert.ok(!mail.body.includes('店員さん') && !mail.html.includes('店員さん'), '記述の中身は載せない');
  assert.match(mail.body, /#gid=/);
});

test('L11 メール: 0件の期間は「回答はありませんでした」', () => {
  const t = load();
  const period = t.ctx.periodOf_(jst(2026, 10, 19), weekly);
  const mail = t.ctx.buildMail_(t.ctx.aggregate_([q('満足度', '段階評価')], [], period), t.answers);
  assert.match(mail.subject, /回答 0件/);
  assert.match(mail.body, /この期間の回答はありませんでした/);
});

test('L12 メール: 質問の名前や選択肢に < > & があっても、HTMLが崩れない', () => {
  const t = load();
  const period = t.ctx.periodOf_(jst(2026, 10, 19), weekly);
  const rows = [row(jst(2026, 10, 13), { '<b>A&B</b>': 'x<y' })];
  const mail = t.ctx.buildMail_(t.ctx.aggregate_([q('<b>A&B</b>', '選択式', { choices: ['x<y'] })], rows, period), t.answers);
  assert.ok(mail.html.includes('&lt;b&gt;A&amp;B&lt;/b&gt;'));
  assert.ok(mail.html.includes('x&lt;y'));
});
