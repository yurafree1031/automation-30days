/**
 * 領収書の写真をAIで読み取り、経費表に自動で記録する
 *
 * 流れ: 未処理フォルダの画像 → Gemini API で読み取り
 *       → 経費表シートに1行追加 → 画像を処理済みフォルダへ移動
 *
 * 事前準備:
 *   - スクリプトプロパティに、使うAIのAPIキーを保存しておく（GEMINI_API_KEY・CLAUDE_API_KEY・OPENAI_API_KEY のどれか。コードには書かない）
 *   - 自信度の基準・1回の読み取り時間は、スクリプトプロパティで変えられる（numberSetting_。書かなければ CONFIG の初期値）
 *   - 「設定」シートに、使うフォルダのURLを貼る（フォルダは既存のものを使う）
 *     「実行」シート（ボタン）はスプレッドシートを開いたとき、
 *     「経費表」「設定」「店別勘定科目」シートは初めてボタンを押したときに自動で作られる
 */

const CONFIG = {
  RUN_SHEET_NAME: '実行', // ボタンを置くシート
  SHEET_NAME: '経費表',
  SETTINGS_SHEET_NAME: '設定',
  STORE_RULES_SHEET_NAME: '店別勘定科目', // 店名ごとに勘定科目を決めておくシート
  INBOX_LABEL: '未処理フォルダのURL',
  DONE_LABEL: '処理済みフォルダのURL',
  FISCAL_START_LABEL: '年度の始まりの月',
  DEFAULT_FISCAL_START: 4, // 日本の会社に多い3月決算（4月始まり）
  // GASは1回6分（360秒）で強制終了するので、この時間を過ぎたら次の画像に進まずに止める（残りは次に押したとき）
  // 最後の1枚に、AIの返事（数十秒）と混雑時のやり直しの待ち時間がかかっても6分に収まるよう、90秒残す
  TIME_BUDGET_SECONDS: 270,
  // AIの混雑でやり直すのは、読み取りを始めてからこの秒数まで。過ぎたら混雑として次回に回す（最後の返事と記録に60秒残す）
  RETRY_DEADLINE_SECONDS: 300,
  MAX_FILE_BYTES: 14 * 1024 * 1024, // Gemini に直接送れるのは約20MBまで（文字に変換すると1.33倍になる）
  // 勘定科目の候補は「設定」シートのD列で変えられる。ここは最初に書き込む初期値
  CATEGORY_HEADER: '勘定科目の候補',
  DEFAULT_CATEGORIES: ['旅費交通費', '消耗品費', '会議費', '接待交際費', '通信費', '新聞図書費', '雑費'],
  // AIが答える自信度（0〜100）。これ未満なら黄色（要確認）、さらに下なら赤（読み取れなかった）
  // 初期値。精度テスト（tests/accuracy.js）の自信度の帯ごとの結果から決め直す
  CONFIDENCE_WARN: 90,
  CONFIDENCE_FAIL: 50,
};

// このデモの AdminError の番号（E01〜E05 は AI.gs。README の「エラー番号の一覧」と合わせる）
//   E06 処理済み／未処理フォルダの画像を移せない（編集権限がない、など）
//   E07 フォルダを開けない（URLの貼り間違い、共有されていない）
//   E08 スクリプトプロパティの設定の値が正しくない

const HEADER = ['登録日時', '日付', '店名', '金額', '勘定科目', '画像', '確認事項'];
const TIME_ZONE = 'Asia/Tokyo'; // 日付はすべて日本時間で扱う（プロジェクトの設定に左右されないように）
// 色は「スプレッドシートの見た目ルール」に合わせる。1つの色に意味は1つ
const ERROR_ROW_COLOR = '#f4cccc'; // 読み取れなかった行の背景（薄い赤）
const WARN_ROW_COLOR = '#fff2cc'; // 読み取れたが確認が必要な行の背景（薄い黄色）
const HEADER_COLOR = '#f3f3f3'; // 表の見出しの背景（薄いグレー）
const INPUT_COLOR = '#e8f0fe'; // 使う人が入力・選択するセルの背景（薄い青）
const NOTE_COLOR = '#666666'; // 補足の文字
const DEFAULT_COLUMN_WIDTH = 100; // スプレッドシートの列幅の初期値
// 経費表の列幅。よく入る長さの値（日時・支店名つきの店名・スマホの写真のファイル名）が切れない幅にする
const EXPENSE_COLUMN_WIDTHS = { 登録日時: 150, 店名: 220, 画像: 200, 確認事項: 360 };
const EXPENSE_WRAP_COLUMNS = ['店名', '画像', '確認事項']; // 幅を超える長さになりうる列は、折り返して全文を見せる
const STORE_RULES_HEADER = ['店名（一部でOK）', '勘定科目'];
const STORE_RULES_HEADER_ROW = 7; // 「店別勘定科目」シートの表の見出し行（上の行には入力のルールを書く）
const SETTINGS_ROWS = [
  ['項目', '値', '説明'],
  [CONFIG.INBOX_LABEL, '', '← 領収書の写真を入れるフォルダのURLを貼る'],
  [CONFIG.DONE_LABEL, '', '← 読み取りが終わった写真を移すフォルダのURL。未処理とは別のフォルダにする'],
  [CONFIG.FISCAL_START_LABEL, CONFIG.DEFAULT_FISCAL_START, '← 決算月の次の月（3月決算なら 4）。グラフの年度別・四半期別の集計に使う'],
];
const CATEGORY_NOTE = '← 1行に1つ書く。13個まで'; // 「設定」シートのE1。勘定科目の候補（D列）の入力のルール
const RUN_RESULT_CELL = 'B10'; // 「実行」シートで、前回の結果を残すセル
const RUN_FOLDER_CELL = 'B19'; // 「実行」シートで、未処理フォルダへのリンクを置くセル
const DUPLICATE_NOTE = '同じ日付・店名・金額の行が既にあります。二重に入れていないか確認してください';

/** スプレッドシートを開いたときに、「操作メニュー」と「実行」シートのボタンを用意する */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('操作メニュー')
    .addItem('確認事項を一括クリア', 'clearAllNotes')
    .addToUi();
  try {
    ensureRunSheet_();
  } catch (e) {
    // 作れなかったときは、管理者がエディタから ensureRunSheet を実行して作る
    Logger.log(e.stack || e);
  }
}

/**
 * セルが編集されたときに呼ばれる
 * - 「グラフ」シートのプルダウン（C2・D2・E2）を変えたら、グラフを作り替える
 * - 経費表の「確認事項」列を空にしたら、その行の色（赤・黄色）を元に戻す
 */
function onEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() === CHART_SHEET_NAME) {
    const cell = range.getA1Notation();
    if (cell === CHART_PERIOD_CELL) resetPiePeriod_(sheet);
    // 円グラフのタイトルに期間を出しているので、期間を変えたときも作り直す
    if (cell === CHART_TYPE_CELL || (cell === CHART_PIE_PERIOD_CELL && sheet.getRange(CHART_TYPE_CELL).getValue() === '円グラフ')) {
      applyChartType_(sheet);
    }
    return;
  }

  const noteCol = HEADER.length; // 「確認事項」は一番右の列
  if (sheet.getName() !== CONFIG.SHEET_NAME) return;
  if (range.getColumn() > noteCol || range.getLastColumn() < noteCol) return;

  // 複数行をまとめて消した場合も、1行ずつ見て、空になった行だけ色を戻す
  const notes = sheet.getRange(range.getRow(), noteCol, range.getNumRows(), 1).getValues();
  notes.forEach(([note], i) => {
    const row = range.getRow() + i;
    if (row > 1 && note === '') sheet.getRange(row, 1, 1, HEADER.length).setBackground(null);
  });
}

/** 操作メニュー：経費表の「確認事項」をすべて消して、行の色を戻す */
function clearAllNotes() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    SpreadsheetApp.getActive().toast('経費表にデータがありません', '操作メニュー', 10);
    return;
  }
  const answer = ui.alert(
    '確認事項を消しますか？',
    '赤・黄色の行が元の色に戻ります。元には戻せません。\n金額が空の行（読み取れなかった領収書）は、手入力するまで目印を残します。',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;

  const rows = sheet.getLastRow() - 1;
  const amounts = sheet.getRange(2, HEADER.indexOf('金額') + 1, rows, 1).getValues();
  let kept = 0;
  amounts.forEach(([amount], i) => {
    if (amount === '') { kept++; return; }
    sheet.getRange(i + 2, HEADER.length).clearContent();
    sheet.getRange(i + 2, 1, 1, HEADER.length).setBackground(null);
  });
  const message = kept ? `確認事項を消しました（金額が空の${kept}件は、手入力するまで残しています）` : '確認事項をすべて消しました';
  SpreadsheetApp.getActive().toast(message, '操作メニュー', 10);
}

/** 管理者用：エディタから実行して「実行」シートのボタンと「グラフ」シートを作り直す（消してしまったとき、自動で作れなかったとき） */
function ensureRunSheet() {
  getOrCreateSheet_(CONFIG.SHEET_NAME, [HEADER]); // グラフの集計元
  ensureChartSheet_();
  ensureRunSheet_();
  SpreadsheetApp.getActive().getSheetByName(CONFIG.RUN_SHEET_NAME).activate();
}

/**
 * 「実行」シートがなければ、いちばん左に作って使い方を書く。ボタン（画像）がなければ置く
 * シートとボタンを別々に確かめるのは、途中で失敗しても次の機会に作り直せるようにするため
 */
function ensureRunSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG.RUN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.RUN_SHEET_NAME, 0);
    sheet.setHiddenGridlines(true);
    sheet.setColumnWidth(1, 24);
    sheet.setColumnWidth(2, 640);
    sheet.getRange('B2').setValue('領収書の読み取り').setFontSize(16).setFontWeight('bold');
    sheet.getRange('B3:B5').setValues([
      ['1. 領収書の写真を、未処理フォルダに入れる'],
      ['2. 下のボタンを押す'],
      ['3. 画面右下に結果が出たら、「経費表」を確認する'],
    ]);
    sheet.setRowHeight(7, 70);
    sheet.getRange('B9').setValue('前回の結果').setFontWeight('bold');
    sheet.getRange(RUN_RESULT_CELL).setValue('まだ読み取りは実行されていません');
    sheet.getRange('B12').setValue('見かた').setFontWeight('bold');
    sheet.getRange('B13:B17').setValues([
      ['・赤い行 ＝ 読み取れなかった領収書。右端の「確認事項」の指示のとおり、手入力するか、撮り直してください'],
      ['・黄色い行 ＝ 読み取れたが不確か、または日付・重複に注意が必要。画像のリンクを開いて見比べてください'],
      ['・確認し終わったら、「確認事項」の文字を消すと、行の色が元に戻ります'],
      ['・結果に「残り○枚」と出たら、もう一度ボタンを押してください'],
      ['・ボタンはパソコンのブラウザで使ってください（スマートフォンのアプリでは動きません）'],
    ]).setFontColor(NOTE_COLOR);
    sheet.getRange(RUN_FOLDER_CELL).setValue('未処理フォルダ: 「設定」シートにフォルダのURLを貼ると、ここから開けます').setFontColor(NOTE_COLOR);
  }
  if (sheet.getImages().length === 0) {
    const blob = Utilities.newBlob(Utilities.base64Decode(RUN_BUTTON_PNG_BASE64), 'image/png', 'button.png');
    // 画像に関数を割り当てると、クリックで実行されるボタンになる
    sheet.insertImage(blob, 2, 7).setWidth(280).setHeight(60).assignScript('processReceipts');
  }
}

// エラーの種類（UserError・RetryLaterError・AdminError）は Errors.gs、AIの呼び出しは AI.gs（どちらも lib/gas/ のコピー）
// 画像ごとの UserError は、経費表に赤い行で記録し、確認事項の列に直し方を書く

/** 「実行」シートのボタンから呼ばれる */
function processReceipts() {
  // 実行中にもう一度押されても、同じ画像を2回記録しないよう、1つずつ実行する
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    SpreadsheetApp.getActive().toast('別の読み取りが実行中です。終わるまでお待ちください（終わると、結果が通知と「実行」シートに出ます）', '確認してください', 20);
    return;
  }
  try {
    SpreadsheetApp.getActive().toast('準備しています。このままお待ちください', '領収書の読み取り', -1);
    run_();
  } catch (e) {
    notifyError_(e);
  } finally {
    lock.releaseLock();
  }
}

/** 未処理フォルダの画像を読み取って、経費表に記録する */
function run_() {
  // 初回はここで「経費表」「設定」シートができる
  const sheet = getOrCreateSheet_(CONFIG.SHEET_NAME, [HEADER]);
  const settings = getOrCreateSheet_(CONFIG.SETTINGS_SHEET_NAME, SETTINGS_ROWS);
  ensureSettingRows_(settings);
  const categories = getCategories_(settings);
  const storeRules = getStoreRules_(ensureStoreRulesSheet_(settings));
  try {
    ensureChartSheet_();
  } catch (e) {
    // グラフが作れなくても読み取りは続ける。管理者がエディタから ensureRunSheet を実行すれば作り直せる
    Logger.log(e.stack || e);
  }

  const inboxUrl = getSetting_(settings, CONFIG.INBOX_LABEL);
  const doneUrl = getSetting_(settings, CONFIG.DONE_LABEL);
  if (!inboxUrl || !doneUrl) {
    settings.activate();
    throw new UserError('フォルダのURLを2つ貼って、もう一度押してください');
  }
  if (categories.length === 0) {
    settings.activate();
    throw new UserError('勘定科目の候補を1つ以上入れてください');
  }
  // 「グラフ」シートの集計表に並べられる数には上限がある（超えるとグラフが空になる）
  const maxCategories = CHART_TABLE_WIDTH - 1;
  if (categories.length > maxCategories) {
    settings.activate();
    throw new UserError(`勘定科目の候補は${maxCategories}個までです（今は${categories.length}個）。減らしてから、もう一度押してください`);
  }
  const fiscalStart = Number(getSetting_(settings, CONFIG.FISCAL_START_LABEL));
  if (!Number.isInteger(fiscalStart) || fiscalStart < 1 || fiscalStart > 12) {
    settings.activate();
    throw new UserError(`「${CONFIG.FISCAL_START_LABEL}」は1〜12の数字にしてください（3月決算なら 4）`);
  }
  try {
    ensureExpenseValidation_(sheet, settings);
    ensureExpenseLayout_(sheet);
    ensureSettingsLayout_(settings);
  } catch (e) {
    Logger.log(e.stack || e); // 入力規則や見た目が整えられなくても、読み取りは続ける
  }

  getAIConfig_(); // APIキーの設定に不備があれば、読み取りを始める前に知らせる
  // 管理者が変えられる設定。値がおかしければ、読み取りを始める前に知らせる
  const warnAt = numberSetting_('CONFIDENCE_WARN', CONFIG.CONFIDENCE_WARN, 0, 100);
  const failAt = numberSetting_('CONFIDENCE_FAIL', CONFIG.CONFIDENCE_FAIL, 0, 100);
  const budgetMs = numberSetting_('TIME_BUDGET_SECONDS', CONFIG.TIME_BUDGET_SECONDS, 30, CONFIG.RETRY_DEADLINE_SECONDS) * 1000;

  const inbox = openFolder_(inboxUrl, CONFIG.INBOX_LABEL);
  const done = openFolder_(doneUrl, CONFIG.DONE_LABEL);
  if (inbox.getId() === done.getId()) {
    settings.activate();
    throw new UserError('未処理と処理済みに同じフォルダが指定されています。別々のフォルダにしてください');
  }
  setFolderLink_(inbox);

  // 読み取る対象（画像・PDF）と、それ以外のファイルに分ける
  const targets = [];
  let others = 0;
  const it = inbox.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const type = f.getMimeType();
    if (type.startsWith('image/') || type === MimeType.PDF) targets.push(f);
    else others++;
  }
  const othersNote = others ? `領収書以外のファイルが${others}個あります。未処理フォルダから移してください` : '';
  if (targets.length === 0) {
    showResult_(['未処理フォルダに領収書がありません', othersNote].filter(Boolean).join('\n'), '領収書の読み取り', 15);
    return;
  }

  const EMPTY = { date: '', store: '', amount: '', category: '' };
  const today = todayString_();
  const seen = loadReceiptKeys_(sheet); // 同じ領収書を二重に入れていないか見るための、既に記録した行
  let recorded = 0, flagged = 0, warned = 0, busy = false, badInARow = 0;
  const startedAt = Date.now();
  const deadline = startedAt + CONFIG.RETRY_DEADLINE_SECONDS * 1000;
  const imageCol = HEADER.indexOf('画像') + 1;
  // 終わるまで最大5分ほどかかるので、動いていることを先に知らせる（終わったら結果の通知で置き換わる）
  SpreadsheetApp.getActive().toast(`${targets.length}枚を読み取っています。終わるまでこのままお待ちください`, '領収書の読み取り', -1);
  try {
    for (const file of targets) {
      if (Date.now() - startedAt > budgetMs) break;
      let r = EMPTY;
      let error = '', warning = '';
      try {
        if (file.getSize() > CONFIG.MAX_FILE_BYTES) {
          throw new UserError('画像が大きすぎます（14MBまで）。手入力するか、撮り直してください');
        }
        r = readReceipt_(file.getBlob(), categories, today, deadline);
        badInARow = 0;
        r.confidence = Number(r.confidence) || 0; // 返ってこなかったら 0 として扱う
        // 自信度が低い、または中身がありえない値（日付の形が違う・金額が0以下）なら、読み取れなかった扱いにする
        if (r.confidence < failAt || !isPlausible_(r)) {
          r = EMPTY;
          throw new UserError('読み取れませんでした。手入力するか、撮り直してください');
        }
        const notes = [];
        if (r.confidence < warnAt) notes.push('読み取りが不確かです。画像と見比べてください');
        const dateNote = dateWarning_(r.date, today);
        if (dateNote) notes.push(dateNote);
        warning = notes.join(' ');
      } catch (e) {
        // 混雑は時間をおけば直るので、画像を未処理フォルダに残して、残りの画像も次回に回す
        if (e instanceof RetryLaterError) { busy = true; break; }
        if (e instanceof AIBadRequestError) {
          // AIが受け付けない画像（大きすぎる等）は、その画像だけ赤い行にする。続けて起きるなら画像ではなく設定やプログラムの問題なので止める
          if (++badInARow >= 3) throw e.adminError;
          error = 'この画像はAIが受け付けませんでした。手入力するか、撮り直してください';
        } else if (e instanceof UserError) {
          error = e.message;
        } else {
          // 管理者が必要なエラーは、残りの画像でも同じことが起きるのでここで止める
          throw e;
        }
      }
      if (!error) {
        // 「店別勘定科目」に登録された店なら、AIの判断より登録した勘定科目を優先する
        // ただし登録した勘定科目が候補にない（打ち間違い・候補から消した）ときは、AIの判断を入れて確認してもらう
        const ruleCategory = findStoreCategory_(storeRules, r.store);
        if (ruleCategory && categories.includes(ruleCategory)) r.category = ruleCategory;
        else if (ruleCategory) warning = [warning, `店別勘定科目の「${ruleCategory}」が勘定科目の候補にありません。AIが選んだ勘定科目を入れたので確認してください`].filter(Boolean).join(' ');
        // 同じ日付・店名・金額の行が既にあれば、二重に入れていないか確認してもらう
        const key = receiptKey_(r.date, r.store, r.amount);
        if (seen.has(key)) warning = [warning, DUPLICATE_NOTE].filter(Boolean).join(' ');
        seen.add(key);
      }
      // 先に画像を移す。移せないとき（編集権限がない等）に、画像は残ったまま行だけが増えないようにする
      try {
        file.moveTo(done);
      } catch (e) {
        throw new AdminError('E06', '画像を処理済みフォルダに移せません', `ボタンを押した人に、未処理・処理済みの両方のフォルダの編集権限があるか確認してください（${e.message}）`);
      }
      // 読み取れなかった画像も行は残す。赤＝読み取れなかった、黄色＝要確認。確認事項の列に直し方を書く
      // 書く行を先に決め、その行にまとめて書く（途中で別の人が行を足しても、リンクや色が別の行に付かないように）
      const row = sheet.getLastRow() + 1;
      sheet.getRange(row, 1, 1, HEADER.length).setValues([[new Date(), r.date, r.store, r.amount, r.category, file.getName(), error || warning]]);
      // 画像列はファイル名を表示し、クリックで画像が開くリンクにする（URLの羅列より、どの写真か分かりやすい）
      sheet.getRange(row, imageCol)
        .setRichTextValue(SpreadsheetApp.newRichTextValue().setText(file.getName()).setLinkUrl(file.getUrl()).build());
      if (error || warning) {
        sheet.getRange(row, 1, 1, HEADER.length).setBackground(error ? ERROR_ROW_COLOR : WARN_ROW_COLOR);
        if (error) flagged++; else warned++;
      }
      recorded++;
    }
  } catch (e) {
    // 管理者向けのエラーで途中で止まったときも、それまでに記録した件数を知らせる
    if (recorded) e.progress = `ここまでに${recorded}件を記録しました`;
    throw e;
  }

  const remaining = targets.length - recorded;
  const lines = [
    [`記録 ${recorded}件`, flagged ? `エラー ${flagged}件` : '', warned ? `確認 ${warned}件` : ''].filter(Boolean).join('　'),
    busy ? `AIが混雑中です。数分後にもう一度押してください（残り${remaining}枚）`
      : remaining ? `残り${remaining}枚。もう一度押してください` : '',
    othersNote,
  ].filter(Boolean);
  const message = lines.join('\n');
  Logger.log(message);
  // ボタンから実行したときは実行ログが見えないので、結果を画面に出す
  const title = flagged || warned || busy || others ? '確認してください' : '領収書の読み取り';
  showResult_(message, title, 20);
}

/** エラーを種類に応じて画面に通知する */
function notifyError_(e) {
  Logger.log(e.stack || e);
  const ss = SpreadsheetApp.getActive();
  if (e instanceof UserError) {
    showResult_(e.message, '確認してください', 20);
    return;
  }
  const detail = e instanceof AdminError ? `[${e.code}] ${e.message}\n${e.detail}` : `[E99] 想定外のエラー\n${e.message}`;
  showResult_([e.progress, detail].filter(Boolean).join('\n').slice(0, 200), '管理者に連絡してください', 30);
}

/** 結果を画面右下に通知し、「実行」シートにも残す（通知は消えてしまうので） */
function showResult_(message, title, seconds) {
  const ss = SpreadsheetApp.getActive();
  ss.toast(message, title, seconds);
  try {
    const sheet = ss.getSheetByName(CONFIG.RUN_SHEET_NAME);
    if (!sheet) return;
    const stamp = Utilities.formatDate(new Date(), TIME_ZONE, 'M/d HH:mm');
    sheet.getRange(RUN_RESULT_CELL).setValue(`${stamp}　${message.replace(/\n/g, '　')}`);
  } catch (e) {
    Logger.log(e.stack || e); // 残せなくても、通知は出ている
  }
}

/** 「実行」シートに、未処理フォルダを開くリンクを置く */
function setFolderLink_(folder) {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.RUN_SHEET_NAME);
    if (!sheet) return;
    sheet.getRange(RUN_FOLDER_CELL)
      .setRichTextValue(SpreadsheetApp.newRichTextValue().setText('未処理フォルダを開く').setLinkUrl(folder.getUrl()).build());
  } catch (e) {
    Logger.log(e.stack || e);
  }
}

/** 読み取った値が、領収書としてありえる形か（AIの自信度とは別に確かめる） */
function isPlausible_(r) {
  return isRealDate_(r.date) && Number(r.amount) > 0 && !['', '不明'].includes(String(r.store).trim());
}

/** YYYY-MM-DD の形で、実際にある日付か（2026-02-31 のような日付は false） */
function isRealDate_(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 今日の日付（YYYY-MM-DD） */
function todayString_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

/** 日付が今日より先、または1年以上前なら、確認してもらうための文を返す（問題なければ空文字） */
function dateWarning_(date, today) {
  if (date > today) return '日付が今日より先になっています。画像と見比べてください';
  const oneYearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  if (date < oneYearAgo) return '日付が1年以上前です。画像と見比べてください';
  return '';
}

/** 同じ領収書かどうかを見分けるための、日付・店名・金額をまとめた文字列（店名は表記ゆれをそろえる） */
function receiptKey_(date, store, amount) {
  const d = Object.prototype.toString.call(date) === '[object Date]'
    ? Utilities.formatDate(date, TIME_ZONE, 'yyyy-MM-dd')
    : String(date);
  return [d, normalizeStore_(store), Number(amount)].join('|');
}

/** 経費表に既にある行（日付・金額が入っているもの）の、receiptKey_ の集まり */
function loadReceiptKeys_(sheet) {
  const n = sheet.getLastRow() - 1;
  if (n < 1) return new Set();
  return new Set(sheet.getRange(2, 2, n, 3).getValues()
    .filter(([date, , amount]) => date !== '' && amount !== '')
    .map(([date, store, amount]) => receiptKey_(date, store, amount)));
}

/** 経費表の手入力の場所に入力規則を付ける: 日付は日付の形、金額は数字、勘定科目は「設定」シートの候補から選ぶ（表記ゆれを防ぐ） */
function ensureExpenseValidation_(sheet, settings) {
  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  const dateRule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
    .setHelpText('日付は 2026/10/15 のような形で入れてください').build();
  sheet.getRange(2, HEADER.indexOf('日付') + 1, rows, 1).setDataValidation(dateRule);
  // 「1280円」のように文字で入ると、グラフの集計に入らないまま気づかれないので、数字だけにする
  const amountRule = SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false)
    .setHelpText('金額は数字だけで入れてください（例: 1280）').build();
  sheet.getRange(2, HEADER.indexOf('金額') + 1, rows, 1).setDataValidation(amountRule);
  sheet.getRange(2, HEADER.indexOf('勘定科目') + 1, rows, 1).setDataValidation(categoryRule_(settings));
}

/** 勘定科目は「設定」シートの候補から選ぶ入力規則（経費表と店別勘定科目で使う） */
function categoryRule_(settings) {
  return SpreadsheetApp.newDataValidation().requireValueInRange(settings.getRange('D2:D'), true).setAllowInvalid(false)
    .setHelpText('勘定科目は一覧から選んでください。足したいときは「設定」シートのD列に書きます').build();
}

/** 表の見出しの見た目（太字・薄いグレー・下に罫線） */
function styleHeader_(range) {
  range.setFontWeight('bold').setBackground(HEADER_COLOR).setBorder(null, null, true, null, null, null);
}

/**
 * 経費表の文字が切れないよう、列幅を広げ、長くなる列は折り返す
 * 幅は初期値（100）のままの列だけ変える。使う人が自分で変えた幅はそのまま
 */
function ensureExpenseLayout_(sheet) {
  // 見出しと書式は毎回そろえる（シートを作ったときだけにすると、作ったあとに変えた見た目が戻らない）
  styleHeader_(sheet.getRange(1, 1, 1, HEADER.length));
  const col = (name) => sheet.getRange(1, HEADER.indexOf(name) + 1, sheet.getMaxRows(), 1);
  col('金額').setNumberFormat('#,##0').setHorizontalAlignment('right');
  col('登録日時').setNumberFormat('yyyy/mm/dd hh:mm');
  col('日付').setNumberFormat('yyyy/mm/dd');
  Object.entries(EXPENSE_COLUMN_WIDTHS).forEach(([name, width]) => {
    const col = HEADER.indexOf(name) + 1;
    if (sheet.getColumnWidth(col) === DEFAULT_COLUMN_WIDTH) sheet.setColumnWidth(col, width);
  });
  EXPENSE_WRAP_COLUMNS.forEach((name) => sheet.getRange(1, HEADER.indexOf(name) + 1, sheet.getMaxRows(), 1).setWrap(true));
}

/** AIに画像を送り、{date, store, amount, category, confidence} を受け取る。deadline を過ぎたら混雑のやり直しはしない */
function readReceipt_(blob, categories, today, deadline) {
  const prompt = [
    `今日は ${today} です。`,
    'この画像が日本の領収書またはレシートなら、次の項目を読み取ってください。',
    '- date: 発行日（YYYY-MM-DD）。年が書かれていなければ、今日から見て直近の過去になる年とする',
    '- store: 店名・発行元',
    '- amount: 税込の合計金額（円、数字のみ）',
    '- category: 勘定科目。決められた候補の中から、内容に一番近いものを1つ選ぶ',
    '- confidence: 4項目を正しく読み取れた自信度（0〜100の整数）',
    '',
    '読み取れない項目は推測で埋めず、date と store は空文字、amount は 0 にしてください。',
    '画像が不鮮明・一部が切れている・文字が読みにくい場合は confidence を低くしてください。',
    '領収書やレシートではない画像なら、confidence を 0 にしてください。',
  ].join('\n');
  const schema = {
    type: 'object',
    properties: {
      date: { type: 'string' },
      store: { type: 'string' },
      amount: { type: 'integer' },
      category: { type: 'string', enum: categories },
      confidence: { type: 'integer' },
    },
    required: ['date', 'store', 'amount', 'category', 'confidence'],
  };
  try {
    return askAI_({ prompt, file: blob, schema, deadline });
  } catch (e) {
    // AIが答えを返さなかった、または形式どおりに返さなかった（不鮮明な画像で起きやすい）
    if (e instanceof AIUnreadableError) throw new UserError('読み取れませんでした。手入力するか、撮り直してください');
    if (e instanceof AIUnsupportedFileError) throw new UserError('この形式の画像は読み取れません。JPGかPNGにして入れ直してください');
    throw e;
  }
}

/** シートがなければ作り、初期値を書き込む */
function getOrCreateSheet_(name, initialRows) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    const current = ss.getActiveSheet();
    sheet = ss.insertSheet(name, ss.getSheets().length);
    current.activate(); // insertSheet は新しいシートを開いてしまうので、元のシートに戻す
    sheet.getRange(1, 1, initialRows.length, initialRows[0].length).setValues(initialRows);
    sheet.setFrozenRows(1);
    if (name === CONFIG.SETTINGS_SHEET_NAME) {
      // 説明の文字が、右隣の「勘定科目の候補」に隠れないよう、幅を広げる
      sheet.setColumnWidth(1, 200);
      sheet.setColumnWidth(2, 360);
      sheet.setColumnWidth(3, 560);
    }
  }
  return sheet;
}

/** 「店別勘定科目」シートがなければ作る。上に入力のルールを書き、その下を登録する表にする */
function ensureStoreRulesSheet_(settings) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CONFIG.STORE_RULES_SHEET_NAME) || createStoreRulesSheet_(ss);
  try {
    const rows = Math.max(sheet.getMaxRows() - STORE_RULES_HEADER_ROW, 1);
    styleHeader_(sheet.getRange(STORE_RULES_HEADER_ROW, 1, 1, STORE_RULES_HEADER.length));
    sheet.getRange(STORE_RULES_HEADER_ROW + 1, 1, rows, STORE_RULES_HEADER.length).setBackground(INPUT_COLOR); // 表は全部、使う人が入力する場所
    // 長い店名が右隣の勘定科目に隠れないよう、表の店名は折り返す（上の説明は1行で読めるよう折り返さない）
    sheet.getRange(STORE_RULES_HEADER_ROW + 1, 1, rows, 1).setWrap(true);
    // 勘定科目は「設定」シートの候補から選ぶ（打ち間違いや、候補にない勘定科目が経費表に入らないように）
    sheet.getRange(STORE_RULES_HEADER_ROW + 1, 2, rows, 1).setDataValidation(categoryRule_(settings));
  } catch (e) {
    Logger.log(e.stack || e); // 見た目や入力規則が付けられなくても、読み取りは続ける
  }
  return sheet;
}

function createStoreRulesSheet_(ss) {
  const current = ss.getActiveSheet();
  const sheet = ss.insertSheet(CONFIG.STORE_RULES_SHEET_NAME, ss.getSheets().length);
  current.activate(); // insertSheet は新しいシートを開いてしまうので、元のシートに戻す

  sheet.getRange('A1').setValue('店別勘定科目：この店のレシートは必ずこの勘定科目にする、と決めておく表です').setFontWeight('bold');
  sheet.getRange('A2:A5').setValues([
    ['・レシートに印字されている店名のうち、その店だと分かる部分を書いてください（例: スターバックス）'],
    ['・支店ごとに変えたいときは、空白で区切って支店名も書いてください（例: スターバックス 渋谷店）。詳しく書いたほうが優先されます'],
    ['・略称（例: スタバ）や、短すぎる言葉（例: 店）は使わないでください。略称は当たらず、短すぎる言葉は関係ない店にも当たります'],
    ['・全角/半角、ひらがな/カタカナ、空白、「株式会社」などの違いは気にしなくて大丈夫です。経費表の店名からコピーすると確実です'],
  ]).setFontColor(NOTE_COLOR);
  sheet.getRange(STORE_RULES_HEADER_ROW, 1, 1, STORE_RULES_HEADER.length).setValues([STORE_RULES_HEADER]);
  sheet.setFrozenRows(STORE_RULES_HEADER_ROW);
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 160);
  return sheet;
}

/** 「店別勘定科目」シートの表を読み、照合しやすい形にして、詳しい（長い）ルールから順に並べる */
function getStoreRules_(sheet) {
  const first = STORE_RULES_HEADER_ROW + 1;
  if (sheet.getLastRow() < first) return [];
  return sheet.getRange(first, 1, sheet.getLastRow() - first + 1, 2).getValues()
    .map(([store, category]) => parseStoreRule_(store, category))
    .filter((rule) => rule.parts.length && rule.category)
    // 「セブン」と「セブンイレブン 渋谷店」の両方があれば、詳しいほう（長いほう）を優先する
    .sort((a, b) => b.length - a.length);
}

/** 登録した店名を空白で区切り、言葉ごとに表記ゆれをそろえる（「スターバックス 渋谷店」→ 2つの言葉） */
function parseStoreRule_(store, category) {
  const parts = String(store).split(/\s+/).map(normalizeStore_).filter(Boolean);
  return { parts, category: String(category).trim(), length: parts.join('').length };
}

/**
 * 読み取った店名に、登録した言葉がすべて含まれていれば、その勘定科目を返す（なければ空文字）
 * 言葉ごとに見るので、「スターバックス 渋谷店」は「スターバックス コーヒー 渋谷店」にも当たる
 */
function findStoreCategory_(rules, store) {
  const s = normalizeStore_(store);
  const hit = s ? rules.find((rule) => rule.parts.every((p) => s.includes(p))) : null;
  return hit ? hit.category : '';
}

/**
 * 店名の表記ゆれをそろえる。次の違いは無視する
 * 全角/半角、大文字/小文字、ひらがな/カタカナ、会社の種類（株式会社・(株)・㈱ など）、空白・ハイフン・長音・中黒
 */
function normalizeStore_(name) {
  return String(name)
    .normalize('NFKC') // 全角/半角をそろえる（㈱ も (株) になる）
    .toLowerCase()
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|\((株|有|同|資|名)\)/g, '')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)) // ひらがな → カタカナ
    .replace(/[\s\-‐－―ー・]/g, '');
}

/** 「設定」シートのD列から勘定科目の候補を読む。D列が空なら（初回・消されたとき）初期値を書き込む */
function getCategories_(sheet) {
  if (sheet.getRange('D1').getValue() !== CONFIG.CATEGORY_HEADER) {
    // 見出しだけ消えた（または書き換えられた）ときは、D2以降の候補を残して見出しを戻す。何も入っていないときだけ初期値を書く
    const hasValues = sheet.getRange(2, 4, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().some((r) => String(r[0]).trim());
    if (hasValues) {
      sheet.getRange('D1').setValue(CONFIG.CATEGORY_HEADER);
    } else {
      const rows = [CONFIG.CATEGORY_HEADER, ...CONFIG.DEFAULT_CATEGORIES].map((c) => [c]);
      sheet.getRange(1, 4, rows.length, 1).setValues(rows);
    }
  }
  const values = sheet.getRange(2, 4, Math.max(sheet.getLastRow() - 1, 1), 1).getValues()
    .map((r) => String(r[0]).trim()).filter(Boolean);
  return [...new Set(values)];
}

/**
 * 「設定」シートに、SETTINGS_ROWS の項目の行がなければ、A列の空いている行に足す
 * （行を消されたときに、初期値で戻すため）
 */
function ensureSettingRows_(sheet) {
  const labels = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1) + SETTINGS_ROWS.length, 1).getValues().map((r) => r[0]);
  SETTINGS_ROWS.slice(1).forEach((row) => {
    if (labels.includes(row[0])) return;
    const i = labels.findIndex((v, n) => n > 0 && v === '');
    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
    labels[i] = row[0];
  });
}

/** 「設定」シートの見た目: 見出し、入力するセル（値・勘定科目の候補）、候補の入力のルール */
function ensureSettingsLayout_(sheet) {
  styleHeader_(sheet.getRange(1, 1, 1, 4));
  sheet.getRange(2, 2, SETTINGS_ROWS.length - 1, 1).setBackground(INPUT_COLOR);
  sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 1).setBackground(INPUT_COLOR);
  sheet.getRange('E1').setValue(CATEGORY_NOTE).setFontColor(NOTE_COLOR);
  const fiscal = sheet.getDataRange().getValues().findIndex((r) => r[0] === CONFIG.FISCAL_START_LABEL);
  if (fiscal >= 0) {
    sheet.getRange(fiscal + 1, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(1, 12).setAllowInvalid(false)
      .setHelpText('1〜12の数字を入れてください（3月決算なら 4）').build());
  }
}

/**
 * 管理者がスクリプトプロパティで変えられる数字の設定を読む。書かれていなければ fallback
 * 数字でない・範囲の外なら、読み取りを始める前に管理者向けのエラー（E08）にする
 */
function numberSetting_(name, fallback, min, max) {
  const raw = String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new AdminError('E08', '設定の値が正しくありません', `スクリプトプロパティ ${name} は ${min}〜${max} の数字にしてください（今の値: ${raw}）`);
  }
  return n;
}

/** 「設定」シートから、項目名に対応する値を返す（なければ空文字） */
function getSetting_(sheet, label) {
  const row = sheet.getDataRange().getValues().find((r) => r[0] === label);
  return row ? String(row[1]).trim() : '';
}

/** フォルダのURL（またはID）からフォルダを開く */
function openFolder_(value, label) {
  // URL（.../folders/<ID>?usp=...）でも、IDだけでも受け付ける
  const m = value.match(/folders\/([\w-]+)/);
  try {
    return DriveApp.getFolderById(m ? m[1] : value);
  } catch (e) {
    // 使う人には直し方だけを出し、本当の理由（権限がない・削除された等）は管理者が「実行数」のログで見られるように残す
    Logger.log(`「${label}」のフォルダを開けません（${value}）: ${e.stack || e}`);
    SpreadsheetApp.getActive().getSheetByName(CONFIG.SETTINGS_SHEET_NAME).activate();
    throw new UserError(`「${label}」のフォルダを開けません。URLを確認してください。正しいのに開けないときは、管理者に連絡してください（E07）`);
  }
}
