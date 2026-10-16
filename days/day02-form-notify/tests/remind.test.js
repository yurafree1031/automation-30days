// 「対応を始める」ボタンと、未対応のリマインドのテスト（ユーザーの指摘：状態は2つ、メールにボタン、毎週のリマインド）
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, setup, sampleAnswers, findLabel } = require('./helper');

const H = 4;
const DAY = 24 * 3600 * 1000;
const list = (t) => t.ss.getSheetByName('問い合わせ一覧');
const rows = (t) => { const s = list(t); const out = []; for (let r = H + 1; r <= s.getLastRow(); r++) out.push(s.rowObj(r, H)); return out; };
const staffCell = (t, label) => { const s = t.ss.getSheetByName('担当者'); return [s, findLabel(s, label)]; };

function started(opts) {
  const t = load();
  setup(t, opts);
  t.env.mails = [];
  t.env.alerts = [];
  return t;
}
function buttonParams(mail) {
  const m = mail.body.match(/exec\?n=(\d+)&t=([\w-]+)/);
  return { n: m[1], t: m[2] };
}

test('R01 通知メールの「対応を始める」で「対応済み」になり、出てきた画面の「メールを書く」で、お客様あての Gmail の作成画面が開く。もう一度押しても壊れない', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const mail = t.env.mails[0];
  assert.equal((mail.htmlBody.match(/<a /g) || []).length, 2); // ボタンと「一覧を開く」だけ
  assert.match(mail.htmlBody, /対応を始める<\/a>/);
  const page = t.ctx.doGet({ parameter: buttonParams(mail) });
  assert.match(page.html, /「対応済み」にしました/);
  assert.match(page.html, /mail\.google\.com\/mail\/\?view=cm&amp;fs=1&amp;to=taro%40example\.com&amp;su=/);
  assert.match(page.html, /メールを書く<\/a>/);
  assert.ok(!/<script/.test(page.html)); // 自動で開く処理は、Google の制限で動かないので入れない
  assert.equal(rows(t)[0]['状態'], '対応済み');
  const again = t.ctx.doGet({ parameter: buttonParams(mail) });
  assert.match(again.html, /to=taro%40example\.com/);
  assert.equal(rows(t)[0]['状態'], '対応済み');
});

test('R15 お客様のメールアドレスがない問い合わせは、「対応済み」にするだけで、メールは開かない', () => {
  const t = started();
  t.form.submit(sampleAnswers({ メールアドレス: '' }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const page = t.ctx.doGet({ parameter: buttonParams(t.env.mails[0]) });
  assert.match(page.html, /「対応済み」にしました/);
  assert.ok(!/view=cm/.test(page.html));
});

test('R16 メールの画面の書き出しに、お客様の名前が入る', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const page = t.ctx.doGet({ parameter: buttonParams(t.env.mails[0]) });
  const href = page.html.match(/href="(https:\/\/mail\.google\.com[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(decodeURIComponent(href.split('body=')[1]), /^山田 太郎 様\n\nお問い合わせありがとうございます。/);
});

test('R02 番号を書き換えたリンク・合言葉のないリンクでは変わらない', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  const p = buttonParams(t.env.mails[0]);
  assert.match(t.ctx.doGet({ parameter: { n: '2', t: p.t } }).html, /リンクが正しくありません/);
  assert.match(t.ctx.doGet({ parameter: {} }).html, /リンクが正しくありません/);
  assert.deepEqual(rows(t).map((r) => r['状態']), ['未対応', '未対応']);
});

test('R03 一覧を並べ替えたり行を消したりしても、受付番号で正しい行を変える。消された行は「見つかりません」', () => {
  const t = started();
  t.form.submit(sampleAnswers({ お名前: 'A' }), Date.now() + 1000);
  t.form.submit(sampleAnswers({ お名前: 'B' }), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  const second = buttonParams(t.env.mails[1]);
  list(t).deleteRow(H + 1); // A の行を消す → B が上に詰まる
  t.ctx.doGet({ parameter: second });
  assert.equal(rows(t)[0]['お名前'], 'B');
  assert.equal(rows(t)[0]['状態'], '対応済み');
  const first = buttonParams(t.env.mails[0]);
  assert.match(t.ctx.doGet({ parameter: first }).html, /見つかりません/);
});

test('R04 ウェブアプリとして公開していないときは、ボタンを出さず、一覧で変えるよう書く', () => {
  const t = started();
  const [st, urlRow] = staffCell(t, 'ボタンのURL');
  st.set(urlRow, 2, '');
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.ok(!/対応を始める<\/a>/.test(t.env.mails[0].htmlBody));
  assert.match(t.env.mails[0].body, /一覧の「状態」を「対応済み」に/);
});

test('R13 「ボタンのURL」がウェブアプリのURLの形でない（貼り間違い）ときは、ボタンを出さない', () => {
  const t = started();
  const [st, urlRow] = staffCell(t, 'ボタンのURL');
  st.set(urlRow, 2, 'https://docs.google.com/spreadsheets/d/xxx/edit');
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.ok(!/対応を始める<\/a>/.test(t.env.mails[0].htmlBody));
});

test('R05リマインド：3日より前に受け付けた未対応だけを、担当者ごとに1通で送る。管理者には件数', () => {
  const t = started({ people: [['お見積もり', '佐藤', 'sato@example.com'], ['（それ以外）', '事務', 'jimu@example.com']] });
  const now = Date.now();
  t.form.submit(sampleAnswers({ お名前: '古い見積もり1' }), now + 1000);
  t.form.submit(sampleAnswers({ お名前: '古い見積もり2' }), now + 2000);
  t.form.submit(sampleAnswers({ お名前: '新しい見積もり' }), now + 3000);
  t.form.submit(sampleAnswers({ お名前: '古いその他', お問い合わせの種類: 'その他' }), now + 4000);
  t.form.submit(sampleAnswers({ お名前: '対応済みの見積もり' }), now + 5000);
  t.ctx.handleFormSubmit();
  // 受付日時を、新しい見積もり以外は5日前にする。最後の1件は対応済みにする
  const s = list(t);
  const dateCol = s.col('受付日時', H);
  [1, 2, 4, 5].forEach((i) => s.set(H + i, dateCol, new t.ctx.VMDate(now - 5 * DAY)));
  s.set(H + 5, s.col('状態', H), '対応済み');
  t.env.mails = [];
  t.ctx.weeklyReminder();
  const sato = t.env.mails.find((m) => m.to === 'sato@example.com');
  const jimu = t.env.mails.find((m) => m.to === 'jimu@example.com');
  assert.match(sato.subject, /未対応が 2件/);
  // 日時・名前・メールアドレス・種類を並べるだけ。ボタンは付けない（ユーザーの指摘）
  assert.match(sato.body, /・\d+\/\d+ \d\d:\d\d　古い見積もり1　taro@example\.com　お見積もり/);
  assert.match(sato.body, /古い見積もり2/);
  assert.ok(!/新しい見積もり|対応済みの見積もり/.test(sato.body));
  assert.ok(!/対応を始める/.test(sato.htmlBody));
  assert.ok(!/受付番号/.test(sato.body));
  assert.match(jimu.subject, /未対応が 1件/);
  const admin = t.env.mails.find((m) => m.to === 'admin@example.com');
  assert.match(admin.subject, /未対応の問い合わせが 3件/);
  assert.match(admin.body, /佐藤: 2件/);
});

test('R06 リマインド：未対応がなければ、誰にも送らない。送れなかった（赤い）行は載せない', () => {
  const t = started({ people: [['お見積もり', '佐藤', 'sato@example.com']] });
  t.form.submit(sampleAnswers({ お問い合わせの種類: 'その他' }), Date.now() + 1000); // 担当者がいない → 赤い行
  t.ctx.handleFormSubmit();
  list(t).set(H + 1, list(t).col('受付日時', H), new t.ctx.VMDate(Date.now() - 10 * DAY));
  t.env.mails = [];
  t.ctx.weeklyReminder();
  assert.equal(t.env.mails.length, 0);
});

test('R07 リマインドの曜日・時刻は「担当者」シートで決められ、「通知を始める」でトリガーになる。「しない」なら作らない', () => {
  const t = load();
  t.ctx.onOpen();
  const [s, dayRow] = staffCell(t, 'リマインドの曜日');
  const [, hourRow] = staffCell(t, 'リマインドの時刻');
  assert.equal(s.get(dayRow, 2), '月');
  assert.equal(s.get(hourRow, 2), 9);
  s.set(dayRow, 2, '金');
  s.set(hourRow, 2, 17);
  setup(t);
  const trig = t.env.triggers.find((x) => x.handler === 'weeklyReminder');
  assert.equal(trig.weekDay, 'FRIDAY');
  assert.equal(trig.hour, 17);
  assert.ok(t.env.alerts.some((a) => /毎週金曜 17時/.test(a.message)));
  s.set(dayRow, 2, 'しない');
  t.ctx.startNotifications();
  assert.ok(!t.env.triggers.some((x) => x.handler === 'weeklyReminder'));
});

test('R08 リマインドに載せる日数を変えられる（0日なら、今日の分も載せる）', () => {
  const t = started({ people: [['お見積もり', '佐藤', 'sato@example.com']] });
  const [s, row] = staffCell(t, 'リマインドに載せる日数');
  s.set(row, 2, 0);
  t.form.submit(sampleAnswers(), Date.now() - 1000);
  t.env.props[t.ctx.PROP.LAST_TIME] = String(Date.now() - 5000);
  t.ctx.handleFormSubmit();
  t.env.mails = [];
  t.ctx.weeklyReminder();
  assert.ok(t.env.mails.some((m) => m.to === 'sato@example.com'));
});

test('R09 通知を止めているときは、リマインドも送らない', () => {
  const t = started({ people: [['お見積もり', '佐藤', 'sato@example.com']] });
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  list(t).set(H + 1, list(t).col('受付日時', H), new t.ctx.VMDate(Date.now() - 10 * DAY));
  t.ctx.stopNotifications();
  t.env.mails = [];
  t.ctx.weeklyReminder();
  assert.equal(t.env.mails.length, 0);
});

test('R10 担当者シートの設定の行は、曜日は選択肢、時刻・日数は数字の範囲で入力を制限する', () => {
  const t = load();
  t.ctx.onOpen();
  const [s, dayRow] = staffCell(t, 'リマインドの曜日');
  const [, hourRow] = staffCell(t, 'リマインドの時刻');
  const day = s.validations.find((v) => v.row === dayRow && v.col === 2).rule;
  assert.deepEqual([...day.list], ['日', '月', '火', '水', '木', '金', '土', 'しない']);
  const hour = s.validations.find((v) => v.row === hourRow && v.col === 2).rule;
  assert.deepEqual([...hour.between], [0, 23]);
});
