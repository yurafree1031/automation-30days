// 取り込み・通知・止める／始める・自動の処理のテスト（GASの部品は偽物。メールは送らない）
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, setup, sampleAnswers, findLabel } = require('./helper');

const LIST = '問い合わせ一覧';
const H = 4; // 一覧の見出しの行

function started() {
  const t = load();
  setup(t);
  t.env.mails = [];
  t.env.alerts = [];
  return t;
}
const list = (t) => t.ss.getSheetByName(LIST);
const rows = (t) => { const s = list(t); const out = []; for (let r = H + 1; r <= s.getLastRow(); r++) out.push(s.rowObj(r, H)); return out; };

test('N01 回答が届くと、一覧に1行入り、種類の担当者にメールが届く', () => {
  const t = started();
  t.form.submit(sampleAnswers());
  t.ctx.handleFormSubmit();
  const [r] = rows(t);
  assert.equal(r['受付番号'], 1);
  assert.equal(r['状態'], '未対応');
  assert.equal(r['通知'], '送信済み');
  assert.equal(r['担当者'], '佐藤');
  assert.equal(r['お名前'], '山田 太郎');
  assert.equal(r['電話番号'], '09012345678'); // 先頭の0が消えない（文字として入れる）
  assert.equal(t.env.mails.length, 1);
  assert.equal(t.env.mails[0].to, 'sato@example.com');
  assert.match(t.env.mails[0].subject, /^【問い合わせ】お見積もり 山田 太郎 様 \d+\/\d+ \d\d:\d\d$/);
  // 受付番号・担当者は、担当者には要らないので載せない（ユーザーの指摘）
  assert.ok(!/受付番号|担当:/.test(t.env.mails[0].body));
  assert.ok(!/受付番号|担当:/.test(t.env.mails[0].htmlBody));
  assert.match(t.env.mails[0].body, /見積もりをお願いします/);
});

test('N02 担当者が決まっていない答えは「（それ以外）」の人に届く', () => {
  const t = started();
  t.form.submit(sampleAnswers({ お問い合わせの種類: '商品について' }));
  t.ctx.handleFormSubmit();
  assert.equal(t.env.mails[0].to, 'jimu@example.com');
  assert.equal(rows(t)[0]['担当者'], '事務');
});

test('N03 同じ答えに2人いると、2人に1通で届く。表記の違い（全角・空白）は吸収する', () => {
  const t = load();
  setup(t, { people: [['お見積もり', '佐藤', 'sato@example.com'], ['お見積もり ', '鈴木', 'suzuki@example.com'], ['（それ以外）', '事務', 'jimu@example.com']] });
  t.env.mails = [];
  t.form.submit(sampleAnswers());
  t.ctx.handleFormSubmit();
  assert.equal(t.env.mails.length, 1);
  assert.equal(t.env.mails[0].to, 'sato@example.com,suzuki@example.com');
  assert.equal(rows(t)[0]['担当者'], '佐藤・鈴木');
});

test('N04 2件続けて届くと、受付番号が1・2になる。一覧の行を消しても番号は戻らず、同じ回答は2回入らない', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  t.form.submit(sampleAnswers({ お名前: '佐々木' }), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  assert.deepEqual(rows(t).map((r) => r['受付番号']), [1, 2]);
  list(t).deleteRow(H + 2);
  t.ctx.handleFormSubmit();
  assert.equal(rows(t).length, 1);
  t.form.submit(sampleAnswers(), Date.now() + 3000);
  t.ctx.handleFormSubmit();
  assert.deepEqual(rows(t).map((r) => r['受付番号']), [1, 3]);
});

test('N05 同じ時刻（同じ秒）に2件届いても、どちらも1回ずつ入る', () => {
  const t = started();
  const now = Date.now() + 5000;
  t.form.submit(sampleAnswers({ お名前: 'A' }), now);
  t.ctx.handleFormSubmit();
  t.form.submit(sampleAnswers({ お名前: 'B' }), now);
  t.ctx.handleFormSubmit();
  t.ctx.handleFormSubmit();
  assert.deepEqual(rows(t).map((r) => r['お名前']), ['A', 'B']);
});

test('N06 「通知を始める」より前の回答は取り込まない', () => {
  const t = load();
  t.form.submit(sampleAnswers({ お名前: '前の人' }), Date.now() - 60000);
  setup(t);
  t.form.submit(sampleAnswers({ お名前: '後の人' }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.deepEqual(rows(t).map((r) => r['お名前']), ['後の人']);
});

test('N07 フォームに質問を足すと、一覧の「メモ」の左に列が足される', () => {
  const t = started();
  const { FakeItem, ItemType } = require('./helper');
  t.form.items.push(new FakeItem(6, 'ご希望の日', ItemType.TEXT));
  t.form.submit(sampleAnswers({ ご希望の日: '10/20' }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const h = list(t).header(H);
  assert.equal(h.indexOf('ご希望の日') + 1, h.indexOf('メモ'));
  assert.equal(rows(t)[0]['ご希望の日'], '10/20');
});

test('N08 「=」で始まる入力は、数式ではなく文字として入る', () => {
  const t = started();
  t.form.submit(sampleAnswers({ お問い合わせ内容: '=IMPORTRANGE("x")' }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.equal(rows(t)[0]['お問い合わせ内容'], '=IMPORTRANGE("x")'); // 偽のシートでは、先頭の ' が「文字として入れる」印として外れる
});

test('N09 メールの返信先はお客様にしない。ボタンがないときは、お客様あての新しいメールを書くリンクを置く', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const m = t.env.mails[0];
  assert.equal(m.replyTo, undefined);
  assert.match(m.body, /お客様ではなく社内に届きます/);
  assert.ok(!/view=cm/.test(m.htmlBody)); // ボタンがあるときは、ボタン1つにまとめる
  const staff = t.ss.getSheetByName('担当者');
  staff.set(findLabel(staff, 'ボタンのURL'), 2, '');
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.ctx.handleFormSubmit();
  assert.match(t.env.mails[1].htmlBody, /view=cm&amp;fs=1&amp;to=taro%40example\.com/);
});

test('N10 本文のHTMLは、お客様の入力をそのまま埋め込まない', () => {
  const t = started();
  t.form.submit(sampleAnswers({ お問い合わせ内容: '<script>alert(1)</script>' }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.ok(!t.env.mails[0].htmlBody.includes('<script>'));
  assert.ok(t.env.mails[0].htmlBody.includes('&lt;script&gt;'));
});

test('N11 お客様が回答を直すと、行を足さずに中身を直し、黄色にして知らせる（メールは送り直さない）', () => {
  const t = started();
  const r = t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  r.answers = sampleAnswers({ お問い合わせ内容: '直しました' });
  r.time = Date.now() + 2000; // 直すと、回答の時刻が新しくなる
  t.ctx.handleFormSubmit();
  assert.equal(rows(t).length, 1);
  assert.equal(rows(t)[0]['お問い合わせ内容'], '直しました');
  assert.match(rows(t)[0]['確認事項'], /お客様が回答を直しました/);
  assert.equal(list(t).bgOf(H + 1, 1), t.ctx.WARN_ROW_COLOR);
  assert.equal(t.env.mails.length, 1);
});

test('N12 複数選べる質問は、選ばれた答えすべての担当者に届く（選択肢に「、」があっても分けられる）', () => {
  const t = load();
  const { FakeItem, ItemType } = require('./helper');
  t.form.items[3] = new FakeItem(4, 'お問い合わせの種類', ItemType.CHECKBOX, ['商品について', 'ご予約、ご注文', 'お見積もり']);
  setup(t, { people: [['お見積もり', '佐藤', 'sato@example.com'], ['ご予約、ご注文', '高橋', 'taka@example.com'], ['（それ以外）', '事務', 'jimu@example.com']] });
  t.env.mails = [];
  t.form.submit(sampleAnswers({ お問い合わせの種類: ['ご予約、ご注文', 'お見積もり'] }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.equal(t.env.mails[0].to, 'sato@example.com,taka@example.com');
});

test('E01 担当者が誰もいない答えは、赤い行で残り、管理者にメールが届く。直して送り直すと赤が消える', () => {
  const t = load();
  setup(t, { people: [['お見積もり', '佐藤', 'sato@example.com']] });
  t.env.mails = [];
  t.form.submit(sampleAnswers({ お問い合わせの種類: '商品について' }), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  const s = list(t);
  assert.equal(rows(t)[0]['通知'], '未送信');
  assert.match(rows(t)[0]['確認事項'], /「商品について」の担当者が決まっていません/);
  assert.equal(s.bgOf(H + 1, 1), t.ctx.ERROR_ROW_COLOR);
  assert.equal(t.env.mails.length, 1);
  assert.equal(t.env.mails[0].to, 'admin@example.com');
  assert.match(t.env.mails[0].body, /受付番号 1/);

  const staff = t.ss.getSheetByName('担当者');
  const h = findLabel(staff, '答え');
  ['（それ以外）', '事務', 'jimu@example.com'].forEach((v, j) => staff.set(h + 2, j + 1, v));
  t.ctx.resendNotifications();
  assert.equal(rows(t)[0]['通知'], '送信済み');
  assert.equal(rows(t)[0]['確認事項'], '');
  assert.equal(s.bgOf(H + 1, 1), null);
  assert.match(t.ss.lastToast.message, /送信 1件/);
});

test('E02 メールの1日の上限に達すると、その行を赤くして止め、件数つきで帯に出す（管理者にメールは送れないので、エラーにして終える）', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.env.quota = 1;
  t.env.mailError = null;
  // 1通目で残りが0になり、2通目で止まる
  assert.throws(() => t.ctx.handleFormSubmit(), /E12/);
  const r = rows(t);
  assert.equal(r[0]['通知'], '送信済み');
  assert.equal(r[1]['通知'], '未送信');
  assert.match(r[1]['確認事項'], /E12/);
  assert.match(list(t).get(3, 1), /送信 1件 で止まりました/);
});

test('E03 メールがそのほかの理由で送れないと、E13 の赤い行になる', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.env.mailError = new Error('Something failed');
  t.ctx.handleFormSubmit();
  assert.match(rows(t)[0]['確認事項'], /E13/);
});

test('E04 フォームのつながりが切れていると、帯に E11 を出し、管理者にメールで知らせる（1日1通）', () => {
  const t = started();
  t.ss.formUrl = null;
  t.ctx.handleFormSubmit();
  t.ctx.handleFormSubmit();
  assert.match(list(t).get(3, 1), /E11/);
  const adminMails = t.env.mails.filter((m) => m.to === 'admin@example.com');
  assert.equal(adminMails.length, 1);
  assert.match(adminMails[0].body, /E11/);
});

test('E05 管理者に知らせられない（管理者のメールアドレスがない）ときは、エラーにして終える', () => {
  const t = started();
  const staff = t.ss.getSheetByName('担当者');
  staff.set(findLabel(staff, '管理者のメールアドレス'), 2, '');
  t.ss.formUrl = null;
  assert.throws(() => t.ctx.handleFormSubmit(), /フォームがつながっていません/);
});

test('E06 フォームを開けないと E14', () => {
  const t = started();
  t.env.formError = new Error('No item with the given ID could be found');
  t.ctx.handleFormSubmit();
  assert.match(list(t).get(3, 1), /E14/);
});

test('E07 担当者を決める質問がフォームにないと E16。（それ以外）の人に届き、管理者に知らせる', () => {
  const t = started();
  const staff = t.ss.getSheetByName('担当者');
  staff.set(findLabel(staff, '担当者を決める質問'), 2, '種類');
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit();
  assert.equal(t.env.mails.find((m) => m.to !== 'admin@example.com').to, 'jimu@example.com');
  assert.match(list(t).get(3, 1), /E16/);
  assert.ok(t.env.mails.some((m) => m.to === 'admin@example.com' && /E16/.test(m.body)));
});

test('E08 想定外のエラーは、帯と管理者へのメールに、技術の言葉を出さずに E99 で出す', () => {
  const t = started();
  t.form.getResponses = () => { throw new TypeError('Cannot read properties of undefined'); };
  t.ctx.handleFormSubmit();
  assert.match(list(t).get(3, 1), /E99/);
  assert.ok(!list(t).get(3, 1).includes('Cannot read'));
});

test('E09 次にうまく動くと、帯は消える', () => {
  const t = started();
  t.ss.formUrl = null;
  t.ctx.handleFormSubmit();
  t.ss.formUrl = 'https://docs.google.com/forms/d/FORM/edit';
  t.ctx.handleFormSubmit();
  assert.equal(list(t).get(3, 1), '');
});

test('N13 時間切れで残った分は、件数を出し、5分後の続きを予約する。続きで残りが送られる', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.form.submit(sampleAnswers(), Date.now() + 2000);
  t.ctx.CONFIG.TIME_BUDGET_SECONDS = 0;
  t.ctx.handleFormSubmit();
  assert.ok(rows(t).every((r) => r['通知'] === '未送信'));
  assert.ok(t.env.triggers.some((x) => x.handler === 'continueNotifications' && x.after === 5 * 60 * 1000));
  t.ctx.CONFIG.TIME_BUDGET_SECONDS = 240;
  t.ctx.continueNotifications();
  assert.ok(rows(t).every((r) => r['通知'] === '送信済み'));
  assert.ok(!t.env.triggers.some((x) => x.handler === 'continueNotifications'));
});

test('N14 たまった回答が多いときは、取り込みも時間で区切り、区切るたびに位置を進める', () => {
  const t = started();
  for (let i = 0; i < 5; i++) t.form.submit(sampleAnswers({ お名前: `人${i}` }), Date.now() + 1000 + i);
  t.ctx.CONFIG.IMPORT_BUDGET_SECONDS = 0; // 1回に1件だけ
  t.ctx.handleFormSubmit();
  assert.equal(rows(t).length, 1);
  assert.ok(t.env.triggers.some((x) => x.handler === 'continueNotifications'));
  for (let i = 0; i < 4; i++) t.ctx.continueNotifications();
  assert.deepEqual(rows(t).map((r) => r['お名前']), ['人0', '人1', '人2', '人3', '人4']);
});

test('N15 ほかで取り込み中（ロックが取れない）なら、エラーにせず続きを予約する', () => {
  const t = started();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.env.scriptLockBusy = true;
  t.ctx.handleFormSubmit();
  assert.equal(list(t).get(3, 1), '');
  assert.ok(t.env.triggers.some((x) => x.handler === 'continueNotifications'));
  t.env.scriptLockBusy = false;
  t.ctx.continueNotifications();
  assert.equal(rows(t).length, 1);
});

test('N16 送っている間に並べ替えられても、受付番号で行を確かめて正しい行に書く', () => {
  const t = started();
  t.form.submit(sampleAnswers({ お名前: 'A' }), Date.now() + 1000);
  t.form.submit(sampleAnswers({ お名前: 'B' }), Date.now() + 2000);
  t.env.docLockBusy = true; // 先に取り込みだけ
  t.ctx.handleFormSubmit();
  t.env.docLockBusy = false;
  const s = list(t);
  // 1通目を送るときに、行を入れ替える
  const orig = t.ctx.MailApp.sendEmail;
  let swapped = false;
  t.ctx.MailApp.sendEmail = (m) => {
    orig(m);
    if (swapped) return;
    swapped = true;
    const w = s.getLastColumn();
    const a = s.getRange(H + 1, 1, 1, w).getValues()[0];
    const b = s.getRange(H + 2, 1, 1, w).getValues()[0];
    s.getRange(H + 1, 1, 1, w).setValues([b]);
    s.getRange(H + 2, 1, 1, w).setValues([a]);
  };
  t.ctx.resendNotifications();
  assert.ok(rows(t).every((r) => r['通知'] === '送信済み'));
  assert.equal(t.env.mails.length, 2);
});

test('N17 通知を止めると、回答が届いても何もしない。再開すると、止めていた間の分を件数を見せて取り込み、送る', () => {
  const t = started();
  t.ctx.stopNotifications();
  assert.equal(t.env.props[t.ctx.PROP.STOPPED], '1');
  assert.ok(!t.env.triggers.some((x) => x.handler === 'handleFormSubmit'));
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.ctx.handleFormSubmit(); // ほかの人のトリガーが残っていても、止める印を見て何もしない
  assert.equal(rows(t).length, 0);
  t.ctx.startNotifications();
  assert.ok(t.env.alerts.some((a) => /止めていた間に届いた問い合わせが 1件/.test(a.message)));
  assert.equal(rows(t).length, 1);
  assert.equal(rows(t)[0]['通知'], '送信済み');
  assert.ok(t.env.triggers.some((x) => x.handler === 'handleFormSubmit'));
});

test('N18 再開の確認で「いいえ」なら、始めない', () => {
  const t = started();
  t.ctx.stopNotifications();
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.env.uiAnswers = ['NO'];
  t.ctx.startNotifications();
  assert.equal(t.env.props[t.ctx.PROP.STOPPED], '1');
  assert.equal(rows(t).length, 0);
});

test('N19 「通知を始める」を何回押しても、トリガーは1つずつ（回答・毎朝）', () => {
  const t = started();
  t.ctx.startNotifications();
  t.ctx.startNotifications();
  assert.equal(t.env.triggers.filter((x) => x.handler === 'handleFormSubmit').length, 1);
  assert.equal(t.env.triggers.filter((x) => x.handler === 'dailyCheck').length, 1);
  assert.equal(t.env.triggers.find((x) => x.handler === 'dailyCheck').hour, 8);
});

test('E10 管理者のメールアドレスがないと、通知を始められない', () => {
  const t = load();
  t.ctx.onOpen();
  t.ctx.startNotifications();
  assert.match(t.env.alerts[0].message, /管理者のメールアドレス/);
  assert.equal(t.env.triggers.length, 0);
});

test('E11 フォームがつながっていないと、通知を始めるで E11', () => {
  const t = load();
  t.ss.formUrl = null;
  t.ctx.onOpen();
  t.ctx.startNotifications();
  assert.match(t.env.alerts[0].message, /E11/);
});

test('N20 別の人が「通知を始める」を押すと確かめる。「いいえ」なら送信元は替わらない', () => {
  const t = started();
  t.env.me = 'staff@example.com';
  t.env.uiAnswers = ['NO'];
  t.ctx.startNotifications();
  assert.match(t.env.alerts[0].message, /今は office@example\.com から/);
  assert.equal(t.env.props[t.ctx.PROP.SENDER], 'office@example.com');
  assert.ok(!t.env.triggers.some((x) => x.owner === 'staff@example.com'));
});

test('N21 送信元を替えると、前の送信元のトリガーは動いても何もせず、自分を片づける', () => {
  const t = started();
  t.env.me = 'new@example.com';
  t.env.uiAnswers = ['YES'];
  t.ctx.startNotifications();
  assert.equal(t.env.props[t.ctx.PROP.SENDER], 'new@example.com');
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.env.me = 'office@example.com'; // 前の送信元のトリガーが動いた
  t.env.mails = [];
  t.ctx.handleFormSubmit();
  assert.equal(t.env.mails.length, 0);
  assert.ok(!t.env.triggers.some((x) => x.owner === 'office@example.com'));
  t.env.me = 'new@example.com';
  t.ctx.handleFormSubmit();
  assert.equal(t.env.mails.length, 1);
});

test('N22 毎朝の確認で、取りこぼしを取り込む。送れていない行があれば管理者に知らせる', () => {
  const t = load();
  setup(t, { people: [['お見積もり', '佐藤', 'sato@example.com']] });
  t.env.mails = [];
  t.form.submit(sampleAnswers(), Date.now() + 1000); // トリガーが動かなかった
  t.form.submit(sampleAnswers({ お問い合わせの種類: 'その他' }), Date.now() + 2000);
  t.ctx.dailyCheck();
  assert.equal(rows(t).length, 2);
  assert.equal(rows(t)[0]['通知'], '送信済み');
  assert.ok(t.env.mails.some((m) => m.to === 'admin@example.com' && /送れていない問い合わせが 1件/.test(m.subject)));
});

test('N23 「通知を始める」は、トリガーより先に取り込みの位置を決める', () => {
  const t = load();
  t.ctx.onOpen();
  const staff = t.ss.getSheetByName('担当者');
  staff.set(findLabel(staff, '管理者のメールアドレス'), 2, 'admin@example.com');
  const orig = t.ctx.ScriptApp.newTrigger;
  let propAtTrigger = null;
  t.ctx.ScriptApp.newTrigger = (h) => { if (propAtTrigger == null) propAtTrigger = t.env.props[t.ctx.PROP.LAST_TIME] || ''; return orig(h); };
  t.ctx.startNotifications();
  assert.ok(propAtTrigger);
});

test('N26 初めて「通知を始める」を押したときは、「送信 0件」のような意味のない結果を出さない', () => {
  const t = load();
  setup(t);
  const done = t.env.alerts.find((a) => a.title.startsWith('通知を始めました'));
  assert.ok(!/送信 0件/.test(done.message));
});

test('N24スプレッドシートのタイムゾーンが日本以外なら、始めるときに知らせる', () => {
  const t = load();
  t.ss.tz = 'America/New_York';
  setup(t);
  assert.ok(t.env.alerts.some((a) => /America\/New_York/.test(a.message)));
});

test('N25 「通知を送り直す」は、送る前に件数つきで「送っています」と出す。未送信がなければそう出す', () => {
  const t = started();
  t.ctx.resendNotifications();
  assert.match(t.ss.lastToast.message, /送り直す問い合わせはありません/);
  t.form.submit(sampleAnswers(), Date.now() + 1000);
  t.env.docLockBusy = true;
  t.ctx.handleFormSubmit();
  t.env.docLockBusy = false;
  t.ctx.resendNotifications();
  assert.ok(t.ss.toasts.some((x) => /未送信 1件 の通知を送っています/.test(x.message)));
});
