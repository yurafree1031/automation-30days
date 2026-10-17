// メニュー・自動の送信・シートを通しで動かすテスト（GAS の部品は偽物）
const test = require('node:test');
const assert = require('node:assert');
const { load, start, setSetting, findLabel, historyRows, jst } = require('./helper');

const MON_9 = jst(2026, 10, 19, 9, 10); // 月曜9時台
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 10/12〜10/18 に3件、10/5〜10/11 に1件の回答を入れる */
function fill(t) {
  t.respond(jst(2026, 10, 6, 12), [3, 3, 'SNS', '価格', '', '']);
  t.respond(jst(2026, 10, 13, 12), [5, 4, 'SNS', '料理の味, スタッフの対応', 'また来ます', '山田']);
  t.respond(jst(2026, 10, 14, 18), [4, 5, 'チラシ', '料理の味', '', '']);
  t.respond(jst(2026, 10, 18, 20), [2, 3, 'ホームページ', '', '待ち時間が長い', '']);
}

// ---- 正常 ----

test('N01 開くと、メニューと「設定」「集計の履歴」シートができる。設定の初期値は 毎週・月・9時', () => {
  const t = load();
  t.ctx.onOpen();
  assert.deepStrictEqual(plain(t.ss.menus[0].items.map((i) => i[0])), ['前回分を今すぐ送る（管理者）', '---', '送信を始める（管理者）', '送信を止める（管理者）']);
  const s = t.sheet('設定');
  assert.strictEqual(s.get(findLabel(s, '送る間隔'), 2), '毎週');
  assert.strictEqual(s.get(findLabel(s, '送る曜日'), 2), '月');
  assert.strictEqual(s.get(findLabel(s, '送る時刻'), 2), '9時');
  assert.ok(t.sheet('集計の履歴'));
  assert.strictEqual(t.ss.active.getName(), 'フォームの回答 1', '開いている画面は変えない');
});

test('N02 送信を始めると、1時間ごとのトリガーが入り、「集計する質問」に質問が並ぶ。終わった期間は送らない', () => {
  const t = load();
  fill(t);
  start(t);
  assert.strictEqual(t.env.triggers.length, 1);
  assert.strictEqual(t.env.triggers[0].everyHours, 1);
  assert.strictEqual(t.env.mails.length, 0);
  const q = t.sheet('集計する質問');
  assert.strictEqual(q.get(3, 1), '本日のご満足度');
  assert.strictEqual(q.get(3, 2), '段階評価');
  assert.strictEqual(q.get(3, 3), true);
  assert.match(t.env.alerts[0].message, /10\/19\(月\) 9時台に、前の週の集計を送ります/);
  const s = t.sheet('設定');
  assert.match(s.get(findLabel(s, '送信の状態'), 2), /送信中（office@example.com から）。次は 10\/19\(月\) 9時台に/);
});

test('N03 月曜9時より前は送らず、9時台に前の週の集計を1回だけ送る。履歴に1行残る', () => {
  const t = load();
  fill(t);
  start(t);
  t.clock(jst(2026, 10, 19, 8, 30));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 0);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  const mail = t.env.mails[0];
  assert.strictEqual(mail.to, 'owner@example.com');
  assert.strictEqual(mail.subject, '【アンケート集計】2026/10/12(月)〜10/18(日)　回答 3件');
  assert.match(mail.body, /平均 3\.7点/);
  t.clock(MON_9 + 60 * 60 * 1000);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1, '同じ期間を2回送らない');
  const rows = historyRows(t);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]['期間'], '2026/10/12(月)〜10/18(日)');
  assert.strictEqual(rows[0]['回答数'], 3);
  assert.strictEqual(rows[0]['平均：本日のご満足度'], 3.7);
  assert.ok(rows[0]['送った日時']);
  assert.strictEqual(rows[0].bg, null);
});

test('N04 メールの中身: 選択式の「その他」、複数選択の分け方、記述式は件数だけ。チェックを外した質問は入れない', () => {
  const t = load();
  fill(t);
  start(t);
  const q = t.sheet('集計する質問');
  q.set(findLabel(q, 'お名前（任意）'), 3, false);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  const body = t.env.mails[0].body;
  assert.match(body, /ホームページ：1件（33%）/);
  assert.match(body, /SNS：1件（33%）/);
  assert.match(body, /その他：1件（33%）/);
  assert.match(body, /料理の味：2件（100%）/, '複数選択の割合は、答えた人のうち選んだ人');
  assert.match(body, /■ ご意見・ご感想\n　記入 2件/);
  assert.ok(!body.includes('待ち時間が長い'));
  assert.ok(!body.includes('お名前'), 'チェックを外した質問は載せない');
  assert.strictEqual(q.get(findLabel(q, 'お名前（任意）'), 3), false, 'チェックを外した状態は、並べ直しても残る');
});

test('N05 回答が0件の期間も「0件」と送る', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  assert.match(t.env.mails[0].subject, /回答 0件/);
});

test('N06 送り先が複数（改行・カンマ・読点）でも、全員に1通で送る', () => {
  const t = load();
  start(t, { to: 'a@example.com\nb@example.com、c@example.com' });
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails[0].to, 'a@example.com,b@example.com,c@example.com');
});

test('N07 前回分を今すぐ送る: 送信元を見せて確かめ、送ったら自動では同じ期間を送らない', () => {
  const t = load();
  fill(t);
  start(t);
  t.clock(jst(2026, 10, 19, 7)); // 9時より前
  t.ctx.sendLatestNow();
  const confirm = t.env.alerts[t.env.alerts.length - 1];
  assert.match(confirm.message, /2026\/10\/12\(月\)〜10\/18\(日\) の集計を、送り先の 1人 に送ります/);
  assert.match(confirm.message, /送信元：office@example.com（あなた）/);
  assert.strictEqual(t.env.mails.length, 1);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
});

test('N08 止めると自動では送らない。再開のとき「はい」で、止めていた間の期間を送る', () => {
  const t = load();
  fill(t);
  start(t);
  t.ctx.stopReports();
  assert.strictEqual(t.env.triggers.length, 0);
  t.clock(jst(2026, 10, 27, 10)); // 2期間たった
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 0);
  t.env.uiAnswers.push('YES');
  t.ctx.startReports();
  const ask = t.env.alerts.find((a) => a.title === '止めていた間の集計を送りますか？');
  assert.match(ask.message, /2期間 あります（2026\/10\/12\(月\)〜10\/18\(日\) 〜 2026\/10\/19\(月\)〜10\/25\(日\)）/);
  assert.strictEqual(t.env.mails.length, 2);
  assert.match(t.env.alerts[t.env.alerts.length - 1].message, /止めていた間の 2期間 の集計を送りました/);
});

test('N09 再開のとき「いいえ」なら送らず、次の期間から送る', () => {
  const t = load();
  start(t);
  t.ctx.stopReports();
  t.clock(jst(2026, 10, 27, 10));
  t.env.uiAnswers.push('NO');
  t.ctx.startReports();
  assert.strictEqual(t.env.mails.length, 0);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 0);
  t.clock(jst(2026, 11, 2, 9, 30));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  assert.match(t.env.mails[0].subject, /2026\/10\/26\(月\)〜11\/1\(日\)/);
});

test('N10 「送る間隔」を変えても、過去の期間がまとめて届かない（変えたあとの区切りから送る）', () => {
  const t = load();
  start(t);
  setSetting(t, '送る間隔', '毎日');
  t.ctx.onEdit({ range: t.sheet('設定').getRange(5, 2) });
  t.ctx.hourlyCheck(); // 土曜12時。前の日（金曜）の分は、変えたときにもう終わっているので送らない
  assert.strictEqual(t.env.mails.length, 0);
  t.clock(jst(2026, 10, 18, 9, 5));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  assert.match(t.env.mails[0].subject, /2026\/10\/17\(土\)　/);
});

test('N11 「毎月」なら、1日に前の月の分を送る', () => {
  const t = load();
  t.ctx.onOpen();
  setSetting(t, '送る間隔', '毎月');
  start(t);
  t.clock(jst(2026, 11, 1, 9, 20));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  assert.match(t.env.mails[0].subject, /2026年10月/);
});

// ---- エラー ----

test('E01 メールを送れないと赤い行（日本語の理由）。管理者には詳しい内容。直ると次の1時間で送り直し、赤が消える', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  t.env.mailError = new Error('Invalid email: owner@exampl');
  // 管理者へのメールも送れないので、エラーにして終える（Googleから失敗のお知らせが届く）
  assert.throws(() => t.ctx.hourlyCheck());
  let rows = historyRows(t);
  assert.strictEqual(rows[0].bg, '#f4cccc');
  assert.match(rows[0]['確認事項'], /^\[E13\] メールを送れませんでした/);
  assert.ok(!rows[0]['確認事項'].includes('Invalid'), 'シートに英語のエラー文を出さない');
  t.env.mailError = null;
  t.clock(MON_9 + 60 * 60 * 1000);
  t.ctx.hourlyCheck();
  rows = historyRows(t);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].bg, null);
  assert.strictEqual(rows[0]['確認事項'], '');
  assert.strictEqual(t.env.mails.length, 1);
});

test('E02 送り先の間違いで送れないとき、管理者のメールに詳しい内容が載る。同じエラーは1日1通', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  const ctx = t.ctx;
  const realSend = ctx.MailApp.sendEmail;
  ctx.MailApp.sendEmail = (m) => { if (m.to === 'owner@example.com') throw new Error('Invalid email: owner@example.com'); realSend(m); };
  ctx.hourlyCheck();
  ctx.hourlyCheck();
  const admin = t.env.mails.filter((m) => m.to === 'admin@example.com');
  assert.strictEqual(admin.length, 1);
  assert.match(admin[0].body, /詳しい内容: Invalid email/);
  assert.match(t.sheet('集計の履歴').get(3, 1), /\[E13\]/, '帯にも出る');
});

test('E03 送信数の上限（E12）は赤い行と帯。管理者へのメールは送れないので、エラーにして終える', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  t.env.quota = 0;
  assert.throws(() => t.ctx.hourlyCheck());
  assert.match(historyRows(t)[0]['確認事項'], /\[E12\]/);
  assert.match(t.sheet('集計の履歴').get(3, 1), /\[E12\]/);
  t.env.quota = 100;
  t.clock(MON_9 + 60 * 60 * 1000);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  assert.strictEqual(t.sheet('集計の履歴').get(3, 1), '', '直ったら帯が消える');
});

test('E04 設定の間違い（E17）は管理者に知らせ、設定を直した時点で帯が消える', () => {
  const t = load();
  start(t);
  setSetting(t, '送り先', 'owner@example');
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.filter((m) => m.to === 'admin@example.com').length, 1);
  assert.match(t.sheet('集計の履歴').get(3, 1), /\[E17\].*形が違います/);
  const s = t.sheet('設定');
  assert.strictEqual(s.bgOf(findLabel(s, '送り先'), 2), '#fff2cc', '直すセルは黄色');
  setSetting(t, '送り先', 'owner@example.com');
  t.ctx.onEdit({ range: s.getRange(findLabel(s, '送り先'), 2) });
  assert.strictEqual(t.sheet('集計の履歴').get(3, 1), '');
  assert.strictEqual(s.bgOf(findLabel(s, '送り先'), 2), '#e8f0fe');
});

test('E05 フォームがつながっていない（E11）・回答のシートが消された（E15）・フォームを開けない（E14）', () => {
  let t = load();
  t.ctx.onOpen();
  setSetting(t, '送り先', 'o@example.com');
  setSetting(t, '管理者のメールアドレス', 'a@example.com');
  t.ss.formUrl = null;
  t.ctx.startReports();
  assert.match(t.env.alerts[0].message, /\[E11\]/);

  t = load();
  start(t);
  t.answers.formUrl = null; // 回答のシートが消された
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.match(historyRows(t)[0]['確認事項'], /\[E15\]/);

  t = load();
  start(t);
  t.env.formError = new Error('No item with the given ID could be found');
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.match(historyRows(t)[0]['確認事項'], /\[E14\]/);
});

test('E06 送り先・管理者が空なら、始めずに直し方を出す', () => {
  const t = load();
  t.ctx.onOpen();
  t.ctx.startReports();
  assert.strictEqual(t.env.alerts[0].title, '確認してください');
  assert.match(t.env.alerts[0].message, /「送り先」に、集計を受け取る人のメールアドレスを書いてください/);
  assert.match(t.env.alerts[0].message, /「管理者のメールアドレス」を書いてください/);
  assert.strictEqual(t.env.triggers.length, 0);
});

// ---- 誤操作 ----

test('M01 送信元でない人が「前回分を今すぐ送る」を押すと、ふだんの送信元を見せて確かめる。「いいえ」なら送らない', () => {
  const t = load();
  start(t);
  t.env.me = 'tencho@example.com';
  t.env.uiAnswers.push('NO');
  t.ctx.sendLatestNow();
  assert.match(t.env.alerts[t.env.alerts.length - 1].message, /ふだんは office@example.com から送っています/);
  assert.strictEqual(t.env.mails.length, 0);
});

test('M02 前の送信元のトリガーが動いても、送らずにトリガーを片づける', () => {
  const t = load();
  start(t);
  t.env.me = 'new@example.com';
  t.env.uiAnswers.push('YES');
  t.ctx.startReports(); // 送信元を替える
  t.env.me = 'office@example.com';
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 0);
  assert.strictEqual(t.env.triggers.filter((tr) => tr.owner === 'office@example.com').length, 0);
});

test('M03 ほかの送信の途中（ロック中）なら、自動の送信は何もせず次の1時間に回す', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  t.env.scriptLockBusy = true;
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 0);
  t.env.scriptLockBusy = false;
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
});

test('M04 長く送れなかったときは、5期間までさかのぼって送る。それより前の赤い行は黄色の「送っていません」に', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  t.env.quota = 0;
  assert.throws(() => t.ctx.hourlyCheck()); // 10/12〜10/18 が赤い行に
  t.env.quota = 100;
  t.clock(jst(2026, 11, 23, 9, 10)); // 6期間たった
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 5);
  const rows = historyRows(t);
  const first = rows.find((r) => r['期間'] === '2026/10/12(月)〜10/18(日)');
  assert.strictEqual(first.bg, '#fff2cc');
  assert.match(first['確認事項'], /^送っていません（さかのぼれる数（5期間）を超えたため）/);
});

test('M05 赤い行が残っているときに「前回分を今すぐ送る」で新しい期間を送ると、赤い行は理由つきの黄色に', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  t.env.quota = 0;
  assert.throws(() => t.ctx.hourlyCheck());
  t.env.quota = 100;
  t.ctx.stopReports();
  t.clock(jst(2026, 10, 26, 10));
  t.ctx.sendLatestNow();
  const rows = historyRows(t);
  assert.match(rows[0]['確認事項'], /^送っていません（あとの期間を「前回分を今すぐ送る」で送ったため）/);
  assert.strictEqual(rows[0].bg, '#fff2cc');
  assert.strictEqual(rows[1].bg, null);
});

test('M06 「設定」の行を消しても、次に開いたときに初期値で戻る', () => {
  const t = load();
  t.ctx.onOpen();
  const s = t.sheet('設定');
  s.deleteRow(findLabel(s, '送る時刻'));
  t.ctx.onOpen();
  assert.strictEqual(s.get(findLabel(s, '送る時刻'), 2), '9時');
});

test('M07 「送る時刻」が時刻（9:00）として入っていても、9時として読む', () => {
  const t = load();
  t.ctx.onOpen();
  const s = t.sheet('設定');
  s.set(findLabel(s, '送る時刻'), 2, new t.ctx.Date(jst(1899, 12, 30, 9)));
  setSetting(t, '送り先', 'o@example.com');
  setSetting(t, '管理者のメールアドレス', 'a@example.com');
  t.ctx.startReports();
  assert.strictEqual(t.env.alerts[0].title, '送信を始めました');
  assert.match(t.env.alerts[0].message, /9時台に/);
});

test('M08 「集計の履歴」のシートを消しても、同じ期間を2回送らない。シートは次に開いたときに作り直す', () => {
  const t = load();
  start(t);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  t.ss.sheets = t.ss.sheets.filter((s) => s.getName() !== '集計の履歴');
  t.clock(MON_9 + 60 * 60 * 1000);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  t.ctx.onOpen();
  assert.ok(t.sheet('集計の履歴'), '次に開いたときに作り直す');
});

test('M09 回答のシートに日時でない行（手で書き足した行）があっても、飛ばして集計する', () => {
  const t = load();
  fill(t);
  t.answers.getRange(t.answers.getLastRow() + 1, 1, 1, 2).setValues([['メモ：テスト', 1]]);
  start(t);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.match(t.env.mails[0].subject, /回答 3件/);
});

test('M10 「集計の履歴」の上の説明の行が消されていたら、行を足して戻す', () => {
  const t = load();
  t.ctx.onOpen();
  const h = t.sheet('集計の履歴');
  h.deleteRow(1);
  h.deleteRow(1);
  t.ctx.onOpen();
  assert.strictEqual(findLabel(h, '期間'), 4);
});

// ---- 見た目 ----

test('V01 見出しは薄いグレーで固定。数字の列の見出しは右揃え。入力するセルは薄い青', () => {
  const t = load();
  t.ctx.onOpen();
  const h = t.sheet('集計の履歴');
  assert.strictEqual(h.bgOf(4, 1), '#f3f3f3');
  assert.strictEqual(h.frozen, 4);
  const right = h.aligns.filter((a) => a.row === 4 && a.a === 'right').map((a) => h.get(4, a.col));
  assert.deepStrictEqual(right.sort(), ['回答数', '送った日時'].sort());
  const s = t.sheet('設定');
  assert.strictEqual(s.bgOf(findLabel(s, '送り先'), 2), '#e8f0fe');
  assert.strictEqual(s.bgOf(findLabel(s, '送信の状態'), 2), null, 'ツールが書くセルは青にしない');
});

test('V02 「集計する質問」の「集計する」はチェックボックスで、薄い青', () => {
  const t = load();
  start(t);
  const q = t.sheet('集計する質問');
  assert.ok(q.validations.some((v) => v.col === 3 && v.rule.checkbox));
  assert.strictEqual(q.bgOf(3, 3), '#e8f0fe');
});

// ---- ユーザーのチェックで足したもの ----

/** 「送る間隔」を「1回だけ」にする */
function once(t) {
  t.ctx.onOpen();
  setSetting(t, '送る間隔', '1回だけ');
}

test('N12 毎週: フォームの受付が終わったら、1時間のうちに最後の分（前に送った週のあと〜受付終了）を送って終わる【ユーザー指摘】', () => {
  const t = load();
  fill(t);
  start(t);
  t.clock(MON_9);
  t.ctx.hourlyCheck(); // 10/12〜10/18 を送る
  t.respond(jst(2026, 10, 20, 12), [5, 5, 'SNS', '価格', '', '']);
  t.env.formClosed = true; // 10/21 に受付を終えた
  t.clock(jst(2026, 10, 21, 15, 20));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 2);
  assert.strictEqual(t.env.mails[1].subject, '【アンケート集計】2026/10/19(月)〜10/21(水)（受付終了まで）　回答 1件');
  t.clock(jst(2026, 10, 26, 9, 10));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 2, '受付が終わったあとは送らない');
  const s = t.sheet('設定');
  assert.match(s.get(findLabel(s, '送信の状態'), 2), /^フォームの受付が終わったので、最後の分を送りました（10\/21）/);
});

test('N13 1回だけ: 受付中は送らず、受付が終わったら、最初の回答からの全部をまとめて1回だけ送る【ユーザー指摘】', () => {
  const t = load();
  fill(t);
  once(t);
  start(t);
  assert.match(t.env.alerts[t.env.alerts.length - 1].message, /フォームの受付が終わったら（終わってから1時間のうちに）、それまでの回答を全部まとめて1回だけ送ります/);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 0, '受付中は送らない');
  t.env.formClosed = true;
  t.clock(jst(2026, 10, 25, 18, 30));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1);
  assert.strictEqual(t.env.mails[0].subject, '【アンケート集計】2026/10/6(火)〜10/25(日)（受付終了まで）　回答 4件');
  t.clock(jst(2026, 10, 25, 19, 30));
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 1, '2回は送らない');
});

test('N17 受付を再開したら、また決まった間隔で送る', () => {
  const t = load();
  start(t);
  t.env.formClosed = true;
  t.ctx.hourlyCheck(); // 10/12〜10/17 の分を送って終わる
  assert.strictEqual(t.env.mails.length, 1);
  t.env.formClosed = false;
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(t.env.mails.length, 2);
  assert.match(t.env.mails[1].subject, /2026\/10\/12\(月\)〜10\/18\(日\)　/);
});

test('N18 最後の分を送れなかったときは、1時間後に同じ期間の名前で送り直す（赤い行が残らない）', () => {
  const t = load();
  start(t);
  t.env.formClosed = true;
  t.env.quota = 0;
  assert.throws(() => t.ctx.hourlyCheck());
  t.env.quota = 100;
  t.clock(jst(2026, 10, 17, 13, 10));
  t.ctx.hourlyCheck();
  const rows = historyRows(t);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]['期間'], '2026/10/12(月)〜10/17(土)（受付終了まで）');
  assert.strictEqual(rows[0].bg, null);
});

test('N14 推移のグラフ: 記述式以外の集計している質問を全部グラフにする（平均の折れ線・選択式ごとの割合の積み上げ棒・回答数の棒）。作り直しても増えない【ユーザー指摘】', () => {
  const t = load();
  fill(t);
  start(t);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  t.clock(jst(2026, 10, 26, 9, 10));
  t.ctx.hourlyCheck();
  const g = t.sheet('推移のグラフ');
  assert.ok(g, '「推移のグラフ」シートができる');
  const charts = g.getCharts();
  assert.deepStrictEqual(charts.map((c) => c.options.title), [
    '段階評価の平均の推移（期間ごと）',
    '「ご来店のきっかけ」の割合の推移（期間ごと）',
    '「よかった点（いくつでも）」の割合の推移（期間ごと・複数選択）',
    '回答数の推移（期間ごと）',
  ], '作り直すので、グラフは増えない。記述式（ご意見・お名前）はグラフにしない');
  const h = t.sheet('集計の履歴');
  const names = (c) => c.ranges.map((r) => h.get(r.row, r.col));
  const [line, trigger, good, bar] = charts;
  assert.deepStrictEqual(names(line), ['期間', '平均：本日のご満足度', '平均：スタッフの対応']);
  assert.strictEqual(line.ranges[0].numRows, 3, '見出しと2期間');
  assert.deepStrictEqual([line.options['vAxis.viewWindow.min'], line.options['vAxis.viewWindow.max']], [1, 5]);
  assert.strictEqual(line.options['legend.position'], 'bottom');
  assert.deepStrictEqual(names(trigger), ['期間', 'ご来店のきっかけ：ホームページ', 'ご来店のきっかけ：SNS', 'ご来店のきっかけ：知人の紹介', 'ご来店のきっかけ：通りがかり', 'ご来店のきっかけ：その他']);
  assert.strictEqual(trigger.type, 'COLUMN');
  assert.strictEqual(trigger.options.isStacked, 'percent');
  assert.strictEqual(trigger.options['series.1.labelInLegend'], 'SNS', '凡例は選択肢の名前だけ');
  assert.strictEqual(names(good).length, 6, '期間と5つの選択肢');
  assert.strictEqual(bar.type, 'COLUMN');
  assert.strictEqual(h.get(bar.ranges[1].row, bar.ranges[1].col), '回答数');
  assert.strictEqual(bar.options['vAxis.viewWindow.min'], 0, '回答数は0から');
  const r = historyRows(t);
  assert.strictEqual(r[0]['ご来店のきっかけ：SNS'], 1, '選択肢ごとの件数が履歴に残る');
  assert.strictEqual(r[0]['よかった点（いくつでも）：料理の味'], 2);
  assert.strictEqual(t.ss.active.getName(), 'フォームの回答 1', '開いている画面は変えない');
});

test('N19 チェックを外した質問は、グラフにしない', () => {
  const t = load();
  fill(t);
  start(t);
  const q = t.sheet('集計する質問');
  q.set(findLabel(q, 'ご来店のきっかけ'), 3, false);
  q.set(findLabel(q, 'スタッフの対応'), 3, false);
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  const charts = t.sheet('推移のグラフ').getCharts();
  assert.ok(!charts.some((c) => /ご来店のきっかけ/.test(c.options.title)));
  const h = t.sheet('集計の履歴');
  assert.deepStrictEqual(charts[0].ranges.map((r) => h.get(r.row, r.col)), ['期間', '平均：本日のご満足度']);
});

test('N15 回答のシート: 質問の種類に合わせて列幅を広げ、長い答えの列は折り返す。あとで変えた幅は戻さない【ユーザー指摘】', () => {
  const t = load();
  t.answers.wraps = [];
  t.answers.getRange = ((orig) => function (...a) {
    const r = orig.apply(this, a);
    r.setWrap = (w) => { t.answers.wraps.push([r.col, r.numRows, w]); return r; };
    return r;
  })(t.answers.getRange);
  start(t);
  const w = (col) => t.answers.getColumnWidth(col);
  assert.deepStrictEqual([w(1), w(2), w(4), w(5), w(6), w(7)], [150, 120, 150, 240, 280, 280]);
  assert.ok(t.answers.wraps.some(([col, rows]) => col === 6 && rows > 1), '記述式の列は折り返す');
  assert.ok(!t.answers.wraps.some(([col, rows]) => col === 2 && rows > 1), '段階評価の列は折り返さない');
  t.answers.setColumnWidth(6, 500); // 使う人が広げた
  t.clock(MON_9);
  t.ctx.hourlyCheck();
  assert.strictEqual(w(6), 500);
});

test('N16 履歴は期間の古い順に並ぶ（止めていた間の期間をあとから送っても、グラフの横軸が時間の順）【ユーザー指摘】', () => {
  const t = load();
  fill(t);
  start(t);
  t.ctx.stopReports();
  t.clock(jst(2026, 10, 27, 10));
  t.ctx.sendLatestNow(); // 10/19〜10/25 を先に送る
  t.env.props.REPORT_LAST_END = String(jst(2026, 10, 12)); // 10/12〜10/18 を、止めていた間の期間として送れるようにする
  t.env.uiAnswers.push('YES');
  t.ctx.startReports(); // 止めていた間の 10/12〜10/18 をあとから送る
  const rows = historyRows(t);
  assert.deepStrictEqual(rows.map((r) => r['期間']), ['2026/10/12(月)〜10/18(日)', '2026/10/19(月)〜10/25(日)']);
  assert.strictEqual(rows[0]['回答数'], 3, '値も行と一緒に動く');
});

test('E07 受付を終えたフォームでは始めず、受付をオンにするよう出す', () => {
  const t = load();
  t.env.formClosed = true;
  start(t);
  assert.strictEqual(t.env.alerts[0].title, '確認してください');
  assert.match(t.env.alerts[0].message, /フォームが回答を受け付けていません/);
  assert.strictEqual(t.env.triggers.length, 0);
});

test('M11 1回だけ: 「前回分を今すぐ送る」は送らず、受付が終わったら自動で送ると出す', () => {
  const t = load();
  once(t);
  start(t);
  t.ctx.sendLatestNow();
  assert.match(t.env.alerts[t.env.alerts.length - 1].message, /「1回だけ」は、フォームの受付が終わったときに自動で送ります/);
  assert.strictEqual(t.env.mails.length, 0);
});

test('M12 1回だけから「毎週」に戻すと、変えた日を含む週から送る（過去の週がまとめて届かない）', () => {
  const t = load();
  once(t);
  start(t);
  setSetting(t, '送る間隔', '毎週');
  t.ctx.hourlyCheck(); // 変えたあとの1時間ごとの確認（10/17(土)）。終わっている週（10/5〜10/11）は送らない
  assert.strictEqual(t.env.mails.length, 0);
  ['19', '26'].forEach((d) => { t.clock(jst(2026, 10, Number(d), 9, 10)); t.ctx.hourlyCheck(); });
  assert.strictEqual(t.env.mails.length, 2);
  assert.match(t.env.mails[0].subject, /2026\/10\/12\(月\)〜10\/18\(日\)/, '変えた日を含む週から送る');
});
