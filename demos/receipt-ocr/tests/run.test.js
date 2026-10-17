// 「領収書を読み取る」ボタンの処理（run_ / processReceipts）の手元テスト（node --test で実行）
// AIの返事は偽物に差し替える。AI.gs そのものは lib/gas/tests/AI.test.js で確かめている
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const good = (o = {}) => ({ date: '2026-10-15', store: 'セブンイレブン', amount: 1280, category: '消耗品費', confidence: 95, ...o });

/** 設定済みの環境に、領収書を入れる */
function scenario(files, ai) {
  const env = load();
  const { inbox, done, settings } = env.setup();
  files.forEach((f) => inbox.addFile(typeof f === 'string' ? { name: f } : f));
  Object.assign(env.ai, ai);
  env.inbox = inbox;
  env.done = done;
  env.settings = settings;
  env.expenses = () => env.ss.getSheetByName('経費表');
  return env;
}
// 経費表の列: 1 登録日時 / 2 日付 / 3 店名 / 4 金額 / 5 勘定科目 / 6 画像 / 7 確認事項
const cell = (env, row, col) => env.expenses().getRange(row, col).getValue();
const rowBg = (env, row) => env.expenses().bg.get(`${row},1`) || null;

test('N01 正常: 2枚を読み取って経費表に記録し、画像を処理済みフォルダへ移す', () => {
  const env = scenario(['a.jpg', 'b.png'], { 'a.jpg': good(), 'b.png': good({ store: 'JR東日本', amount: 210, category: '旅費交通費', confidence: 100 }) });
  env.ctx.processReceipts();

  assert.deepStrictEqual(env.expenses().getRange(1, 1, 1, 7).getValues()[0], [...env.ctx.HEADER]);
  assert.deepStrictEqual([2, 3, 4, 5, 6, 7].map((c) => cell(env, 2, c)), ['2026-10-15', 'セブンイレブン', 1280, '消耗品費', 'a.jpg', '']);
  assert.deepStrictEqual([2, 3, 4, 5, 6, 7].map((c) => cell(env, 3, c)), ['2026-10-15', 'JR東日本', 210, '旅費交通費', 'b.png', '']);
  assert.strictEqual(Object.prototype.toString.call(cell(env, 2, 1)), '[object Date]', '登録日時が入っている');
  assert.strictEqual(env.expenses().links.get('2,6'), 'https://drive.example/file/a.jpg'); // 画像列はクリックで画像が開く
  assert.strictEqual(rowBg(env, 2), null);
  assert.strictEqual(rowBg(env, 3), null);
  assert.deepStrictEqual(env.inbox.names(), []);
  assert.deepStrictEqual(env.done.names().sort(), ['a.jpg', 'b.png']);
  assert.deepStrictEqual(env.ss.lastToast, { message: '記録 2件', title: '領収書の読み取り', seconds: 20 });
});

test('N02 正常: PDF も読み取る', () => {
  const env = scenario([{ name: 'r.pdf', mime: 'application/pdf' }], { 'r.pdf': good() });
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 3), 'セブンイレブン');
  assert.deepStrictEqual(env.done.names(), ['r.pdf']);
});

test('N03 自信度が低い（50〜89）: 読み取った値を入れて、黄色の行にする', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good({ confidence: 70 }) });
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 4), 1280);
  assert.strictEqual(cell(env, 2, 7), '読み取りが不確かです。画像と見比べてください');
  assert.strictEqual(rowBg(env, 2), env.ctx.WARN_ROW_COLOR);
  assert.deepStrictEqual(env.done.names(), ['a.jpg']);
  assert.deepStrictEqual(env.ss.lastToast, { message: '記録 1件　確認 1件', title: '確認してください', seconds: 20 });
});

test('N04 自信度の境界: 90で色なし、89と50で黄色、49で赤', () => {
  const env = scenario(['c90.jpg', 'c89.jpg', 'c50.jpg', 'c49.jpg'], {
    'c90.jpg': good({ confidence: 90 }), 'c89.jpg': good({ confidence: 89 }), 'c50.jpg': good({ confidence: 50 }), 'c49.jpg': good({ confidence: 49 }),
  });
  env.ctx.processReceipts();
  const bg = Object.fromEntries([2, 3, 4, 5].map((r) => [cell(env, r, 6), rowBg(env, r)]));
  assert.deepStrictEqual(bg, {
    'c90.jpg': null, 'c89.jpg': env.ctx.WARN_ROW_COLOR, 'c50.jpg': env.ctx.WARN_ROW_COLOR, 'c49.jpg': env.ctx.ERROR_ROW_COLOR,
  });
});

test('E01 読み取れなかった（自信度50未満）: 値は空のまま赤い行で残し、確認事項に直し方を書く', () => {
  const env = scenario(['blur.jpg'], { 'blur.jpg': good({ confidence: 20 }) });
  env.ctx.processReceipts();
  assert.deepStrictEqual([2, 3, 4, 5, 6].map((c) => cell(env, 2, c)), ['', '', '', '', 'blur.jpg']);
  assert.strictEqual(cell(env, 2, 7), '読み取れませんでした。手入力するか、撮り直してください');
  assert.strictEqual(rowBg(env, 2), env.ctx.ERROR_ROW_COLOR);
  assert.deepStrictEqual(env.done.names(), ['blur.jpg']);
  assert.strictEqual(env.ss.lastToast.message, '記録 1件　エラー 1件');
});

test('E02 ありえない値（自信度が高くても）: 赤い行にする', () => {
  const env = scenario(['d.jpg', 'm.jpg', 's.jpg', 'x.jpg'], {
    'd.jpg': good({ date: '2026/10/15' }),
    'm.jpg': good({ amount: 0 }),
    's.jpg': good({ store: '' }),
    'x.jpg': { date: '', store: '', amount: 0, category: '雑費', confidence: 0 }, // 領収書ではない画像
  });
  env.ctx.processReceipts();
  for (const r of [2, 3, 4, 5]) {
    assert.strictEqual(rowBg(env, r), env.ctx.ERROR_ROW_COLOR, `${r}行目`);
    assert.strictEqual(cell(env, r, 4), '');
  }
  assert.strictEqual(env.ss.lastToast.message, '記録 4件　エラー 4件');
});

test('E07 AIが答えを返さなかった／形式どおりでなかった: その画像だけ赤にして、次の画像に進む', () => {
  const env = scenario(['bad.jpg', 'ok.jpg'], { 'bad.jpg': { throws: null }, 'ok.jpg': good() });
  env.ai['bad.jpg'] = { throws: new env.ctx.AIUnreadableError('not json') };
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 7), '読み取れませんでした。手入力するか、撮り直してください');
  assert.strictEqual(rowBg(env, 2), env.ctx.ERROR_ROW_COLOR);
  assert.strictEqual(cell(env, 3, 3), 'セブンイレブン');
  assert.deepStrictEqual(env.inbox.names(), []);
});

test('E08 AIが受け付けない形式: その画像だけ赤にして、JPG/PNGで入れ直すよう案内する', () => {
  const env = scenario(['x.heic'], {});
  env.ai['x.heic'] = { throws: new env.ctx.AIUnsupportedFileError('image/heic') };
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 7), 'この形式の画像は読み取れません。JPGかPNGにして入れ直してください');
  assert.strictEqual(rowBg(env, 2), env.ctx.ERROR_ROW_COLOR);
});

test('M01 誤操作: 14MBを超える画像は、AIに送らず赤い行にする', () => {
  const env = scenario([{ name: 'big.jpg', size: 15 * 1024 * 1024 }], {});
  env.ctx.processReceipts();
  assert.deepStrictEqual(env.aiCalls, []);
  assert.strictEqual(cell(env, 2, 7), '画像が大きすぎます（14MBまで）。手入力するか、撮り直してください');
  assert.strictEqual(rowBg(env, 2), env.ctx.ERROR_ROW_COLOR);
});

test('E09 AIが混雑: 画像は未処理フォルダに残し、残りの画像も次回に回す', () => {
  const env = scenario(['a.jpg', 'b.jpg', 'c.jpg'], {});
  env.ai['a.jpg'] = good();
  env.ai['b.jpg'] = { throws: new env.ctx.RetryLaterError('gemini 503') };
  env.ctx.processReceipts();
  assert.strictEqual(env.expenses().getLastRow(), 2); // 見出し＋a.jpg の1行だけ
  assert.deepStrictEqual(env.inbox.names(), ['b.jpg', 'c.jpg']);
  assert.deepStrictEqual(env.aiCalls, ['a.jpg', 'b.jpg']);
  assert.deepStrictEqual(env.ss.lastToast, { message: '記録 1件\nAIが混雑中です。数分後にもう一度押してください（残り2枚）', title: '確認してください', seconds: 20 });
});

test('E10 管理者向けのエラー（APIキーが違う等）: 全体を止め、画像は残し、番号つきで「管理者に連絡」と出す', () => {
  const env = scenario(['a.jpg', 'b.jpg'], {});
  env.ai['a.jpg'] = { throws: new env.ctx.AdminError('E02', 'APIキーが正しくありません', 'gemini gemini-3.8-flash 403: bad key') };
  env.ctx.processReceipts();
  assert.strictEqual(env.expenses().getLastRow(), 1); // 見出しだけ
  assert.deepStrictEqual(env.inbox.names(), ['a.jpg', 'b.jpg']);
  const t = env.ss.lastToast;
  assert.strictEqual(t.title, '管理者に連絡してください');
  assert.ok(t.message.startsWith('[E02] APIキーが正しくありません'), t.message);
});

test('E11 想定外のエラー: [E99] で、管理者（製作者）に連絡するよう出す', () => {
  const env = scenario(['a.jpg'], {});
  env.ai['a.jpg'] = { throws: new Error('boom') };
  env.ctx.processReceipts();
  assert.strictEqual(env.ss.lastToast.title, '管理者に連絡してください');
  assert.ok(env.ss.lastToast.message.startsWith('[E99] 想定外のエラー'));
  assert.deepStrictEqual(env.inbox.names(), ['a.jpg']);
});

test('E12 APIキー未設定: 読み取りを始める前に E01 を出し、画像には触らない', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  delete env.props.GEMINI_API_KEY;
  env.ctx.processReceipts();
  assert.ok(env.ss.lastToast.message.startsWith('[E01]'), env.ss.lastToast.message);
  assert.deepStrictEqual(env.inbox.names(), ['a.jpg']);
  assert.strictEqual(env.expenses().getLastRow(), 1);
});

test('M02 誤操作: フォルダのURLが空 → 設定シートを開いて、貼るよう案内する', () => {
  const env = load();
  env.setup({ inboxUrl: '', doneUrl: '' });
  env.ss.getSheetByName('シート1').activate();
  env.ctx.processReceipts();
  assert.deepStrictEqual(env.ss.lastToast, { message: 'フォルダのURLを2つ貼って、もう一度押してください', title: '確認してください', seconds: 20 });
  assert.strictEqual(env.ss.getActiveSheet().getName(), '設定');
});

test('M03 誤操作: 未処理と処理済みに同じフォルダを指定', () => {
  const env = load();
  env.setup({ doneUrl: 'https://drive.google.com/drive/folders/INBOX' });
  env.ctx.processReceipts();
  assert.strictEqual(env.ss.lastToast.message, '未処理と処理済みに同じフォルダが指定されています。別々のフォルダにしてください');
});

test('M04 誤操作: フォルダのURLが間違っている', () => {
  const env = load();
  env.setup({ inboxUrl: 'https://drive.google.com/drive/folders/NOTHING' });
  env.ctx.processReceipts();
  assert.strictEqual(env.ss.lastToast.title, '確認してください');
  assert.ok(env.ss.lastToast.message.includes('「未処理フォルダのURL」のフォルダを開けません'));
});

test('M08 誤操作: 勘定科目の候補を全部消して実行', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.ctx.getCategories_(env.settings);
  env.settings.getRange(2, 4, 8, 1).clearContent();
  env.ctx.processReceipts();
  assert.strictEqual(env.ss.lastToast.message, '勘定科目の候補を1つ以上入れてください');
  assert.deepStrictEqual(env.inbox.names(), ['a.jpg']);
});

test('M09 誤操作: 領収書以外のファイル（Word等）は読まずに、未処理フォルダに残して知らせる', () => {
  const env = scenario(['a.jpg', { name: 'memo.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }], { 'a.jpg': good() });
  env.ctx.processReceipts();
  assert.deepStrictEqual(env.inbox.names(), ['memo.docx']);
  assert.deepStrictEqual(env.aiCalls, ['a.jpg']);
  assert.deepStrictEqual(env.ss.lastToast, { message: '記録 1件\n領収書以外のファイルが1個あります。未処理フォルダから移してください', title: '確認してください', seconds: 20 });
});

test('N05 未処理フォルダが空（または領収書以外だけ）: その旨を知らせる', () => {
  const empty = scenario([], {});
  empty.ctx.processReceipts();
  assert.strictEqual(empty.ss.lastToast.message, '未処理フォルダに領収書がありません');

  const others = scenario([{ name: 'memo.txt', mime: 'text/plain' }], {});
  others.ctx.processReceipts();
  assert.strictEqual(others.ss.lastToast.message, '未処理フォルダに領収書がありません\n領収書以外のファイルが1個あります。未処理フォルダから移してください');
});

test('N17 店別勘定科目: 登録した店は、AIが選んだ勘定科目より登録を優先する（赤い行は空のまま）', () => {
  const env = scenario(['a.jpg', 'b.jpg', 'c.jpg'], {
    'a.jpg': good({ store: 'スターバックス コーヒー 渋谷店', category: '雑費' }),
    'b.jpg': good({ store: 'ドトール', category: '雑費' }),
    'c.jpg': good({ store: 'スターバックス', confidence: 10 }),
  });
  env.setStoreRules([['スターバックス', '会議費']]);
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 5), '会議費');
  assert.strictEqual(cell(env, 3, 5), '雑費');
  assert.strictEqual(cell(env, 4, 5), '');
});

test('N18 時間切れ: 制限時間を過ぎたら次の画像に進まず止め、残り枚数を知らせる', () => {
  const env = scenario(['a.jpg', 'b.jpg', 'c.jpg'], { 'a.jpg': good(), 'b.jpg': good(), 'c.jpg': good() });
  env.tickClock(4 * 60 * 1000); // 画像を1枚見るたびに4分進む
  env.ctx.processReceipts();
  assert.deepStrictEqual(env.done.names(), ['a.jpg']);
  assert.deepStrictEqual(env.inbox.names(), ['b.jpg', 'c.jpg']);
  assert.strictEqual(env.ss.lastToast.message, '記録 1件\n残り2枚。もう一度押してください');
});

test('N19 使う人が変えた経費表の見出しは、上書きしない【2回目の評価の指摘3】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  const sheet = env.ss.add('経費表');
  sheet.getRange(1, 1, 1, 8).setValues([[...env.ctx.HEADER.slice(0, 6), 'メモ', '担当']]);
  env.ctx.processReceipts();
  assert.deepStrictEqual(sheet.getRange(1, 7, 1, 2).getValues()[0], ['メモ', '担当']);
});

test('N20 初回: 経費表・設定・店別勘定科目のシートと、勘定科目の初期値が自動でできる', () => {
  const env = load();
  env.ctx.processReceipts(); // フォルダ未設定なので案内が出る
  for (const name of ['経費表', '設定', '店別勘定科目']) assert.ok(env.ss.getSheetByName(name), name);
  const settings = env.ss.getSheetByName('設定');
  assert.strictEqual(settings.getRange('D1').getValue(), '勘定科目の候補');
  assert.strictEqual(settings.getRange('D2').getValue(), '旅費交通費');
  assert.strictEqual(env.ss.getActiveSheet().getName(), '設定'); // 貼る場所を開く
  assert.strictEqual(env.ss.lastToast.message, 'フォルダのURLを2つ貼って、もう一度押してください');
});

test('M10 誤操作: グラフシートを作れなくても、読み取りは続ける', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.ctx.ensureChartSheet_ = () => { throw new Error('グラフが作れない'); };
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 3), 'セブンイレブン');
  assert.deepStrictEqual(env.ss.lastToast, { message: '記録 1件', title: '領収書の読み取り', seconds: 20 });
});


// ---- 評価の指摘を反映したケース ----
test('N32 AIへの指示に、今日の日付を入れる【評価の指摘1】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.today = '2026-10-15';
  env.ctx.processReceipts();
  assert.ok(env.prompts[0].includes('今日は 2026-10-15 です'), env.prompts[0]);
});

test('E05 日付が今日より先／1年以上前: 値は入れて、黄色の行（赤にはしない）【評価の指摘1】', () => {
  const env = scenario(['f.jpg', 'o.jpg', 'ok.jpg'], {
    'f.jpg': good({ date: '2026-12-01' }), 'o.jpg': good({ date: '2024-05-01' }), 'ok.jpg': good({ date: '2026-10-15' }),
  });
  env.ctx.processReceipts();
  assert.strictEqual(rowBg(env, 2), env.ctx.WARN_ROW_COLOR);
  assert.match(cell(env, 2, 7), /今日より先/);
  assert.strictEqual(rowBg(env, 3), env.ctx.WARN_ROW_COLOR);
  assert.match(cell(env, 3, 7), /1年以上前/);
  assert.strictEqual(rowBg(env, 4), null);
  assert.strictEqual(cell(env, 2, 4), 1280);
});

test('E13 AIが受け付けない画像（400）: その画像だけ赤にして、残りは処理する【評価の指摘2】', () => {
  const env = scenario(['big.jpg', 'ok.jpg'], { 'ok.jpg': good() });
  env.ai['big.jpg'] = { throws: new env.ctx.AIBadRequestError('image exceeds 5 MB', new env.ctx.AdminError('E04', 'AIとの通信でエラー（400）', 'x')) };
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 7), 'この画像はAIが受け付けませんでした。手入力するか、撮り直してください');
  assert.strictEqual(rowBg(env, 2), env.ctx.ERROR_ROW_COLOR);
  assert.strictEqual(cell(env, 3, 3), 'セブンイレブン');
  assert.strictEqual(env.ss.lastToast.message, '記録 2件　エラー 1件');
});

test('E18 AIが受け付けない（400）が3枚続いたら、画像のせいではないので E04 で止める【評価の指摘2】', () => {
  const env = scenario(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'], {});
  const bad = () => ({ throws: new env.ctx.AIBadRequestError('bad', new env.ctx.AdminError('E04', 'AIとの通信でエラー（400）', 'schema invalid')) });
  ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].forEach((n) => { env.ai[n] = bad(); });
  env.ctx.processReceipts();
  // 止まる前に記録した赤い行の件数も出す（どこまで記録されたか分かるように）【2回目の評価の指摘14】
  assert.ok(env.ss.lastToast.message.startsWith('ここまでに2件を記録しました\n[E04]'), env.ss.lastToast.message);
  assert.strictEqual(env.ss.lastToast.title, '管理者に連絡してください');
  assert.deepStrictEqual(env.inbox.names(), ['c.jpg', 'd.jpg']); // 3枚目で止まり、3枚目と4枚目は未処理に残る
});

test('E18b 400のあとに成功した画像があれば、続けて数えない', () => {
  const env = scenario(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'], { 'c.jpg': good(), 'e.jpg': good({ amount: 500 }) });
  const bad = () => ({ throws: new env.ctx.AIBadRequestError('bad', new env.ctx.AdminError('E04', 'x', 'y')) });
  ['a.jpg', 'b.jpg', 'd.jpg'].forEach((n) => { env.ai[n] = bad(); });
  env.ctx.processReceipts();
  assert.strictEqual(env.ss.lastToast.message, '記録 5件　エラー 3件');
});

test('E14 処理済みフォルダに移せない（編集権限がない等）: 行を増やさず、画像は残し、E06で管理者に知らせる【評価の指摘3】', () => {
  const env = scenario([{ name: 'a.jpg', moveError: new Error('Access denied: DriveApp') }, 'b.jpg'], { 'a.jpg': good(), 'b.jpg': good() });
  env.ctx.processReceipts();
  assert.strictEqual(env.expenses().getLastRow(), 1); // 見出しだけ
  assert.deepStrictEqual(env.inbox.names(), ['a.jpg', 'b.jpg']);
  assert.ok(env.ss.lastToast.message.startsWith('[E06] 画像を処理済みフォルダに移せません'), env.ss.lastToast.message);
  assert.ok(env.ss.lastToast.message.includes('編集権限'));
  assert.strictEqual(env.ss.lastToast.title, '管理者に連絡してください');
});

test('E15 AIの利用枠の上限（E05）: 「管理者に連絡」と、上限に達した旨を出す【評価の指摘4】', () => {
  const env = scenario(['a.jpg'], {});
  env.ai['a.jpg'] = { throws: new env.ctx.AdminError('E05', 'AIの利用枠の上限に達しています', 'gemini 429') };
  env.ctx.processReceipts();
  assert.ok(env.ss.lastToast.message.startsWith('[E05] AIの利用枠の上限に達しています'), env.ss.lastToast.message);
  assert.strictEqual(env.ss.lastToast.title, '管理者に連絡してください');
});

test('M11 別の読み取りが実行中にボタンを押す: 何もせず案内する。終わったらロックを戻す【評価の指摘5】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.lockBusy = true;
  env.ctx.processReceipts();
  assert.deepStrictEqual(env.aiCalls, []);
  assert.deepStrictEqual(env.inbox.names(), ['a.jpg']);
  assert.match(env.ss.lastToast.message, /別の読み取りが実行中です/);
  assert.strictEqual(env.lockReleased, 0);

  env.lockBusy = false;
  env.ctx.processReceipts();
  assert.strictEqual(env.lockReleased, 1);
  assert.deepStrictEqual(env.done.names(), ['a.jpg']);
});

test('M12b エラーで止まったときも、ロックを戻す（次に押せなくならない）', () => {
  const env = scenario(['a.jpg'], {});
  env.ai['a.jpg'] = { throws: new Error('boom') };
  env.ctx.processReceipts();
  assert.strictEqual(env.lockReleased, 1);
});

test('N34 結果は「実行」シートにも残る。未処理フォルダへのリンクが置かれる【評価の指摘5・7】', () => {
  const env = scenario(['a.jpg', 'b.jpg'], { 'a.jpg': good(), 'b.jpg': good({ confidence: 20 }) });
  env.ctx.onOpen();
  env.ctx.processReceipts();
  const run = env.ss.getSheetByName('実行');
  const today = new Date().toISOString(); // 偽の formatDate は「今日の月/日 12:00」を返す
  assert.strictEqual(run.getRange('B10').getValue(), `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))} 12:00　記録 2件　エラー 1件`);
  assert.strictEqual(run.links.get('19,2'), 'https://drive.example/folder/INBOX');
});

test('N35 エラーの通知も「実行」シートに残る', () => {
  const env = load();
  env.setup({ inboxUrl: '', doneUrl: '' });
  env.ctx.onOpen();
  env.ctx.processReceipts();
  assert.match(env.ss.getSheetByName('実行').getRange('B10').getValue(), /フォルダのURLを2つ貼って/);
});

test('N38 重複: 経費表に同じ日付・店名・金額の行があれば、黄色で「既にあります」と書く【評価の指摘12】', () => {
  const env = scenario(['a.jpg', 'b.jpg', 'c.jpg'], {
    'a.jpg': good(),
    'b.jpg': good({ store: '株式会社セブンイレブン' }), // 表記ゆれがあっても同じ
    'c.jpg': good({ amount: 999 }),
  });
  const sheet = env.ss.add('経費表');
  sheet.getRange(1, 1, 1, 7).setValues([[...env.ctx.HEADER]]);
  sheet.getRange(2, 1, 1, 7).setValues([['t', '2026-10-15', 'セブンイレブン', 1280, '消耗品費', 'old.jpg', '']]);
  env.ctx.processReceipts();
  assert.strictEqual(rowBg(env, 3), env.ctx.WARN_ROW_COLOR);
  assert.strictEqual(cell(env, 3, 7), '同じ日付・店名・金額の行が既にあります。二重に入れていないか確認してください');
  assert.strictEqual(rowBg(env, 4), env.ctx.WARN_ROW_COLOR); // b.jpg は、既にある行・a.jpg の両方と重なる
  assert.strictEqual(rowBg(env, 5), null);
  assert.strictEqual(env.ss.lastToast.message, '記録 3件　確認 2件');
});

test('N39 重複: 同じ領収書を2枚入れたら、2枚目が黄色になる。1枚目は色なし', () => {
  const env = scenario(['a.jpg', 'a2.jpg'], { 'a.jpg': good(), 'a2.jpg': good() });
  env.ctx.processReceipts();
  assert.strictEqual(rowBg(env, 2), null);
  assert.strictEqual(rowBg(env, 3), env.ctx.WARN_ROW_COLOR);
});

test('N40 重複: 読み取れなかった赤い行（値が空）どうしは、重複扱いにしない', () => {
  const env = scenario(['a.jpg', 'b.jpg'], { 'a.jpg': good({ confidence: 10 }), 'b.jpg': good({ confidence: 10 }) });
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 3, 7), '読み取れませんでした。手入力するか、撮り直してください');
});

test('N33 経費表の手入力の場所に入力規則が付く（日付は日付の形、勘定科目は設定シートの候補から）【評価の指摘6】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.ctx.processReceipts();
  const v = env.expenses().validations;
  const date = v.find((x) => x.col === 2);
  const category = v.find((x) => x.col === 5);
  assert.strictEqual(date.row, 2);
  assert.strictEqual(date.rule.kind, 'date');
  assert.strictEqual(date.rule.allowInvalid, false);
  assert.strictEqual(category.rule.kind, 'range');
  assert.strictEqual(category.rule.allowInvalid, false);
  assert.strictEqual(category.rule.range.getA1Notation(), 'D2:D1000');
  // 金額は数字だけ（「1280円」と文字で入ると集計に入らないため）【2回目の評価の指摘11】
  const amount = v.find((x) => x.col === 4);
  assert.strictEqual(amount.rule.kind, 'number>');
  assert.strictEqual(amount.rule.min, 0);
  assert.strictEqual(amount.rule.allowInvalid, false);
});

test('M20 誤操作: 勘定科目の候補が13個を超えたら、グラフが空にならないよう減らしてもらう【評価の指摘6】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.ctx.getCategories_(env.settings);
  env.settings.getRange(2, 4, 14, 1).setValues(Array.from({ length: 14 }, (_, i) => [`科目${i + 1}`]));
  env.ctx.processReceipts();
  assert.strictEqual(env.ss.lastToast.message, '勘定科目の候補は13個までです（今は14個）。減らしてから、もう一度押してください');
  assert.deepStrictEqual(env.inbox.names(), ['a.jpg']);
});

test('M21 誤操作: 勘定科目の候補がちょうど13個なら動く', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good({ category: '科目1' }) });
  env.ctx.getCategories_(env.settings);
  env.settings.getRange(2, 4, 13, 1).setValues(Array.from({ length: 13 }, (_, i) => [`科目${i + 1}`]));
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 5), '科目1');
});

test('N41 設定シートに、各項目の説明が書かれる【評価の指摘7】', () => {
  const env = load();
  env.ctx.processReceipts(); // 初回
  const settings = env.ss.getSheetByName('設定');
  assert.match(settings.getRange('C3').getValue(), /未処理とは別のフォルダ/);
  // 説明の列は、右隣の候補の列に隠れない幅にする（ブラウザで、隠れて読めなかったため）
  assert.ok(settings.columnWidths[3] >= 400, `C列の幅: ${settings.columnWidths[3]}`);
});

test('N42 文字が切れない: 経費表の列幅を広げ、長くなる列は折り返す。使う人が変えた幅はそのまま', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.ctx.processReceipts();
  const sheet = env.expenses();
  // 1 登録日時 / 3 店名 / 6 画像 / 7 確認事項
  assert.deepStrictEqual([1, 3, 6, 7].map((c) => sheet.getColumnWidth(c)), [150, 220, 200, 360]);
  const wrapped = sheet.wraps.filter((w) => w.on && w.row === 1 && w.numRows === 1000).map((w) => w.col).sort();
  assert.deepStrictEqual(wrapped, [3, 6, 7]);
  // 店別勘定科目は、表（8行目から）の店名だけ折り返す。上の説明は折り返さない
  const rules = env.ss.getSheetByName('店別勘定科目');
  assert.ok(rules.wraps.every((w) => w.col === 1 && w.row === env.ctx.STORE_RULES_HEADER_ROW + 1), JSON.stringify(rules.wraps));

  sheet.setColumnWidth(3, 300); // 使う人が店名の列を広げた
  env.ctx.processReceipts();
  assert.strictEqual(sheet.getColumnWidth(3), 300);
});

// ---- 2回目の評価の指摘を直したところ ----
test('N43 店別勘定科目の勘定科目が候補にないときは、AIの勘定科目を入れて黄色にする【2回目の評価の指摘9】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good({ store: 'スターバックス 渋谷店', category: '会議費' }) });
  env.setStoreRules([['スターバックス', '会議']]); // 打ち間違い
  env.ctx.processReceipts();
  assert.strictEqual(cell(env, 2, 5), '会議費');
  assert.match(cell(env, 2, 7), /店別勘定科目の「会議」が勘定科目の候補にありません/);
  assert.strictEqual(rowBg(env, 2), env.ctx.WARN_ROW_COLOR);
});

test('N44 店別勘定科目の勘定科目の列に、設定シートの候補から選ぶプルダウンが付く【2回目の評価の指摘9】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.ctx.processReceipts();
  const v = env.ss.getSheetByName('店別勘定科目').validations.find((x) => x.col === 2);
  assert.strictEqual(v.row, env.ctx.STORE_RULES_HEADER_ROW + 1);
  assert.strictEqual(v.rule.kind, 'range');
  assert.strictEqual(v.rule.range.getA1Notation(), 'D2:D1000');
});

test('N45 自信度の基準は、スクリプトプロパティで変えられる【2回目の評価の指摘5】', () => {
  const env = scenario(['a.jpg', 'b.jpg'], { 'a.jpg': good({ confidence: 85 }), 'b.jpg': good({ store: 'ローソン', confidence: 35 }) });
  Object.assign(env.props, { CONFIDENCE_WARN: '80', CONFIDENCE_FAIL: '30' });
  env.ctx.processReceipts();
  assert.strictEqual(rowBg(env, 2), null); // 85 は 80 以上なので色なし
  assert.strictEqual(rowBg(env, 3), env.ctx.WARN_ROW_COLOR); // 35 は 30 以上なので黄色
});

test('E20 スクリプトプロパティの設定がおかしいときは、画像に触る前に E08【2回目の評価の指摘5】', () => {
  for (const [name, value] of [['CONFIDENCE_WARN', 'abc'], ['CONFIDENCE_FAIL', '120'], ['TIME_BUDGET_SECONDS', '400']]) {
    const env = scenario(['a.jpg'], { 'a.jpg': good() });
    env.props[name] = value;
    env.ctx.processReceipts();
    assert.ok(env.ss.lastToast.message.startsWith('[E08] 設定の値が正しくありません'), env.ss.lastToast.message);
    assert.match(env.ss.lastToast.message, new RegExp(name));
    assert.deepStrictEqual(env.inbox.names(), ['a.jpg']);
  }
});

test('N46 1回の読み取り時間も、スクリプトプロパティで変えられる', () => {
  const env = scenario(['a.jpg', 'b.jpg', 'c.jpg'], { 'a.jpg': good(), 'b.jpg': good({ store: 'ローソン' }), 'c.jpg': good({ store: 'ファミマ' }) });
  env.props.TIME_BUDGET_SECONDS = '60';
  env.tickClock(40 * 1000); // Date.now を呼ぶたびに40秒進む
  env.ctx.processReceipts();
  assert.ok(env.done.names().length < 3, `読み取った枚数: ${env.done.names().length}`);
});

test('N47 AIには、混雑のやり直しをしてよい最後の時刻（読み取り開始から300秒）を渡す【2回目の評価の指摘10】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.tickClock(0); // 時計を 0 で止める
  env.ctx.processReceipts();
  assert.deepStrictEqual(env.deadlines, [300 * 1000]);
});

test('N48 設定シートに「年度の始まりの月」（初期値 4）がある。行を消しても、次に押したときに戻る【2回目の評価の指摘7】', () => {
  const env = load();
  env.ctx.processReceipts(); // 初回
  const settings = env.ss.getSheetByName('設定');
  assert.deepStrictEqual(settings.getRange(4, 1, 1, 2).getValues()[0], ['年度の始まりの月', 4]);

  const env2 = scenario(['a.jpg'], { 'a.jpg': good() }); // 「年度の始まりの月」の行がない設定シート
  env2.ctx.processReceipts();
  assert.strictEqual(env2.ctx.getSetting_(env2.settings, '年度の始まりの月'), '4');
  assert.deepStrictEqual(env2.done.names(), ['a.jpg']);
});

test('M24 誤操作: 「年度の始まりの月」が1〜12の数字でなければ、案内して止める【2回目の評価の指摘7】', () => {
  for (const value of ['13', '', '4月']) {
    const env = scenario(['a.jpg'], { 'a.jpg': good() });
    env.settings.getRange(4, 1, 1, 2).setValues([['年度の始まりの月', value]]);
    env.ctx.processReceipts();
    assert.strictEqual(env.ss.lastToast.message, '「年度の始まりの月」は1〜12の数字にしてください（3月決算なら 4）', value);
    assert.strictEqual(env.ss.getActiveSheet().getName(), '設定');
    assert.deepStrictEqual(env.inbox.names(), ['a.jpg']);
  }
});

test('V08 見た目: 見出しは薄いグレー、入力するセルは薄い青（見た目ルール）【2回目の評価の指摘6】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.ctx.processReceipts();
  const bgAt = (name, row, col) => env.ss.getSheetByName(name).bg.get(`${row},${col}`);
  assert.strictEqual(bgAt('経費表', 1, 1), '#f3f3f3');
  assert.strictEqual(bgAt('経費表', 1, 7), '#f3f3f3');
  assert.strictEqual(bgAt('設定', 1, 4), '#f3f3f3');
  assert.strictEqual(bgAt('設定', 2, 2), '#e8f0fe'); // フォルダのURL
  assert.strictEqual(bgAt('設定', 4, 2), '#e8f0fe'); // 年度の始まりの月
  assert.strictEqual(bgAt('設定', 2, 4), '#e8f0fe'); // 勘定科目の候補
  assert.strictEqual(bgAt('設定', 2, 3), undefined); // 説明は入力しない
  const row = env.ctx.STORE_RULES_HEADER_ROW;
  assert.strictEqual(bgAt('店別勘定科目', row, 1), '#f3f3f3');
  assert.strictEqual(bgAt('店別勘定科目', row + 1, 2), '#e8f0fe');
  // 勘定科目の候補の入力のルールは、画面（E1）に書く【2回目の評価の指摘16】
  assert.strictEqual(env.settings.getRange('E1').getValue(), '← 1行に1つ書く。13個まで');
});

test('E21 フォルダを開けないときは、管理者向けの番号（E07）も出す【2回目の評価の指摘17】', () => {
  const env = scenario(['a.jpg'], { 'a.jpg': good() });
  env.settings.getRange(2, 2).setValue('https://drive.google.com/drive/folders/NOPE');
  env.ctx.processReceipts();
  assert.strictEqual(env.ss.lastToast.message, '「未処理フォルダのURL」のフォルダを開けません。URLを確認してください。正しいのに開けないときは、管理者に連絡してください（E07）');
});

