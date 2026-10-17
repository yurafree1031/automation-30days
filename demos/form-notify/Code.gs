/**
 * フォームの回答を「問い合わせ一覧」に転記して、担当者にメールで知らせる
 *
 * 流れ: Googleフォームに回答が届く → 「問い合わせ一覧」に1行追加（受付番号・状態つき）
 *       → 「担当者」シートで、問い合わせの種類から知らせる人を決める → Gmail で通知
 *
 * 事前準備（管理者）:
 *   - フォームの回答先を、このスプレッドシートにする（フォームの「回答」→「スプレッドシートにリンク」）
 *   - 「担当者」シートに、管理者のメールアドレスと、知らせる人を書く
 *   - メニュー「問い合わせ管理 → 通知を始める」を1回押す（押した人のGmailから通知が送られる）
 *   「問い合わせ一覧」「担当者」シートは、スプレッドシートを開いたときに自動で作られる
 *
 * 自動で動くもの（トリガー。「通知を始める」で入り、「通知を止める」で外れる）:
 *   - handleFormSubmit:      回答が届いたとき
 *   - continueNotifications: 時間切れなどで残りがあるとき、数分後に1回だけ
 *   - dailyCheck:            毎朝1回。取りこぼしの取り込みと、止まっていないかの確認
 *   - weeklyReminder:        毎週1回（「担当者」シートで決めた曜日・時刻）。未対応のままの問い合わせを担当者に知らせる
 * ウェブアプリ（doGet）: 通知メールの「対応を始める」ボタンから呼ばれ、その問い合わせを「対応済み」にする
 * 自動で動いている最中のエラーは、画面に出せないので、管理者にメールで知らせ、一覧の上の帯にも書く
 *
 * 取り込み済みの位置（どの回答まで一覧に入れたか）と受付番号は、スクリプトプロパティに残す。
 * 一覧の行を消したり並べ替えたりしても、同じ回答を2回取り込まないようにするため。
 */

const CONFIG = {
  LIST_SHEET_NAME: '問い合わせ一覧',
  STAFF_SHEET_NAME: '担当者',
  MENU_NAME: '問い合わせ管理',
  DEFAULT_TYPE_QUESTION: 'お問い合わせの種類', // 「担当者」シートで変えられる。ここは最初に書き込む初期値
  OTHER_ANSWER: '（それ以外）',
  MAIL_SENDER_NAME: '問い合わせ通知',
  // GASは1回6分（360秒）で強制終了する。メール1通は数秒なので、この時間を過ぎたら残りは次回に回す（最後の1通と記録に余裕を残す）
  TIME_BUDGET_SECONDS: 240,
  // そのうち取り込みに使うのはここまで。回答1件の取り込みは1秒もかからないが、数百件たまっていても送る時間を残す
  IMPORT_BUDGET_SECONDS: 90,
  // 回答が同時に届いたとき、前の取り込みが終わるのを待つ時間（取り込みは数秒〜90秒で終わる）
  LOCK_WAIT_MS: 30000,
  CONTINUE_AFTER_MINUTES: 5, // 残りがあるとき、続きを送るまでの時間
  DAILY_CHECK_HOUR: 8, // 毎朝の確認をする時刻（日本時間）
};

const TIME_ZONE = 'Asia/Tokyo'; // 日付はすべて日本時間で扱う（プロジェクトの設定に左右されないように）
// 管理するのは「お客様とのやり取りを始めたか」だけ（終わったかどうかは管理しない）
const STATUSES = ['未対応', '対応済み'];
// 色は「スプレッドシートの見た目ルール」に合わせる。状態の色は「状態」のセルだけに付ける（見た目ルールの例外）
const STATUS_COLORS = { 未対応: '#f4cccc', 対応済み: '#d9ead3' };
const ERROR_ROW_COLOR = '#f4cccc'; // 通知を送れなかった行の背景（薄い赤）
const WARN_ROW_COLOR = '#fff2cc'; // 確認が必要な行の背景（薄い黄）
const HEADER_COLOR = '#f3f3f3'; // 表の見出しの背景（薄いグレー）
const INPUT_COLOR = '#e8f0fe'; // 使う人が入力・選択するセルの背景（薄い青）
const NOTE_COLOR = '#666666'; // 補足の文字
const DEFAULT_COLUMN_WIDTH = 100; // スプレッドシートの列幅の初期値
const PROTECT_NOTE = '問い合わせ管理ツールの見出し'; // 見出しの行に付ける保護（消そうとすると警告が出る）の名前

const LIST_HEAD = ['受付番号', '受付日時', '状態', '担当者']; // フォームの質問の列より左
const LIST_TAIL = ['メモ', '通知', '確認事項', '回答ID']; // フォームの質問の列より右。回答IDは隠す
const LIST_HEADER_ROW = 4; // 「問い合わせ一覧」の表の見出し行（上の行には見かたと、自動の処理のエラーを書く）
const LIST_ALERT_ROW = 3; // 自動の処理で起きたエラーを書く行（フォームから届いたときは、画面に通知を出せないため）
const LIST_HELP = [
  '状態：未対応＝赤、対応済み＝緑。通知メールの「対応を始める」を押すか、ここで選ぶと「対応済み」になります',
  '行全体が赤＝担当者に送れなかった問い合わせ。「確認事項」のとおりに直し、メニューの「通知を送り直す」を押す',
];
const LIST_COLUMN_WIDTHS = { 受付日時: 130, 担当者: 140, メモ: 220, 確認事項: 320 };
const LIST_WRAP_COLUMNS = ['担当者', 'メモ', '確認事項'];
const QUESTION_WIDTH = 160; // フォームの質問の列の幅（長い文章の質問は LONG_QUESTION_WIDTH で折り返す）
const LONG_QUESTION_WIDTH = 360;
const SENT = '送信済み';
const UNSENT = '未送信';

const STAFF_HEADER = ['答え', '名前', 'メールアドレス', '確認事項'];
const STAFF_HEADER_ROW = 10; // 「担当者」シートを作るときの、表の見出し行
// 「担当者」シートの上の設定。行は位置ではなく、A列の名前で探す（行を消されたら、表の上に足し直す）
const STAFF_SETTINGS = [
  ['担当者を決める質問', CONFIG.DEFAULT_TYPE_QUESTION, '← フォームの質問から選ぶ。この質問の答えで、知らせる人を決める'],
  ['管理者のメールアドレス', '', '← エラーが起きたときや、担当者に送れなかったときに知らせる人'],
  ['通知', 'オフ　管理者がメニュー「問い合わせ管理 → 通知を始める」を押すと始まります', ''],
  ['リマインドの曜日', '月', '← 未対応のままの問い合わせを、担当者に知らせる曜日。「しない」なら送らない（変えたら「通知を始める」を押し直す）'],
  ['リマインドの時刻', 9, '← 0〜23 の時'],
  ['リマインドに載せる日数', 3, '← 受け付けてから、この日数より長く未対応のものを載せる'],
  ['ボタンのURL', '', '← 「対応を始める」ボタンの行き先。ウェブアプリとして公開したときのURL（…/exec）を貼る。空欄ならボタンを出さない'],
];
const STAFF_SETTING_KEYS = ['question', 'admin', 'state', 'remindDay', 'remindHour', 'remindAfter', 'webappUrl']; // STAFF_SETTINGS と同じ順
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const NO_REMIND = 'しない';
const STAFF_NOTE = '下の表に、答えごとに知らせる人を1行ずつ書く（同じ答えに何人でも）。どの答えにも当てはまらないときは「（それ以外）」の人に届く';

const PROP = {
  LAST_TIME: 'LAST_RESPONSE_TIME', // 取り込み済みの一番新しい回答の時刻（ミリ秒）
  LAST_IDS: 'LAST_RESPONSE_IDS', // その時刻ちょうどに届いた回答のID（同じ秒に2件届いたときのため）
  NEXT_NUMBER: 'NEXT_NUMBER', // 次の受付番号
  SENDER: 'NOTIFY_SENDER', // 通知を送るアカウント（最後に「通知を始める」を押した人）
  STOPPED: 'NOTIFY_STOPPED', // 「通知を止める」で '1'
  CHOICES: 'TYPE_CHOICES', // 担当者を決める質問の選択肢（「担当者」シートの答えの確かめに使う。選択式でなければ空）
  ALERT_PREFIX: 'ALERT_SENT_', // 管理者へのエラーのメールを、同じ内容は1日1通にするための記録
  BUTTON_SECRET: 'BUTTON_SECRET', // 「対応を始める」ボタンのリンクが、このツールが作ったものかを確かめる合言葉（自動で作る）
};

const TRIGGER_HANDLERS = ['handleFormSubmit', 'continueNotifications', 'dailyCheck', 'weeklyReminder'];

// エラーの種類（UserError・AdminError）は Errors.gs（lib/gas/ のコピー）
// このデモの AdminError の番号（README の「管理者向け：エラー番号の一覧」と合わせる。E01〜E05 はAIの部品で使う番号なので避ける）
//   E11 このスプレッドシートにフォームがつながっていない
//   E12 メールの1日の送信数の上限に達した
//   E13 メールを送れない（そのほかの理由）
//   E14 フォームを開けない（消された・権限がない）
//   E15 シートの見出しの行が見つからない
//   E16 担当者を決める質問が、フォームにない

/** スプレッドシートを開いたときに、メニューとシートを用意する */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(CONFIG.MENU_NAME)
    .addItem('通知を送り直す', 'resendNotifications')
    .addSeparator()
    .addItem('通知を始める（管理者）', 'startNotifications')
    .addItem('通知を止める（管理者）', 'stopNotifications')
    .addToUi();
  try {
    // 開いたときはフォームを読む権限がないので、フォームの質問の列は、最初の取り込みのときに足す
    ensureListSheet_([]);
    ensureStaffSheet_();
  } catch (e) {
    Logger.log(e.stack || e);
  }
}

/** 「問い合わせ一覧」の「確認事項」を空にしたら、その行の色を元に戻す */
function onEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== CONFIG.LIST_SHEET_NAME) return;
  const headerRow = findHeaderRow_(sheet, LIST_HEAD[0]);
  if (!headerRow) return;
  const cols = headerMap_(sheet, headerRow);
  const noteCol = cols['確認事項'];
  if (!noteCol || range.getColumn() > noteCol || range.getLastColumn() < noteCol) return;
  // 複数行をまとめて消した場合も、1行ずつ見て、空になった行だけ色を戻す
  const notes = sheet.getRange(range.getRow(), noteCol, range.getNumRows(), 1).getValues();
  notes.forEach(([note], i) => {
    const row = range.getRow() + i;
    if (row > headerRow && note === '') resetRowColor_(sheet, row, cols);
  });
}

// ---- メニュー ----

/** 管理者用メニュー：通知を始める（再開する）。トリガーを入れ、止めていた間の回答も取り込む */
function startNotifications() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  try {
    const form = openForm_();
    const props = PropertiesService.getScriptProperties();
    const staff = ensureStaffSheet_();
    const admin = String(staff.cells.admin.getValue()).trim();
    if (!isEmail_(admin)) {
      staff.sheet.activate();
      throw new UserError('「担当者」シートの「管理者のメールアドレス」を書いてから、もう一度押してください（エラーが起きたときに、ここへ知らせます）');
    }

    const me = Session.getEffectiveUser().getEmail();
    const sender = props.getProperty(PROP.SENDER);
    const running = sender && props.getProperty(PROP.STOPPED) !== '1';
    if (running && sender !== me) {
      const answer = ui.alert('送信元を替えますか？',
        `今は ${sender} から通知を送っています。\n替えると、これからは ${me}（あなた）から送ります。\n${sender} のアカウントがまだ使えるなら、先にそのアカウントで「通知を止める」を押してください。`,
        ui.ButtonSet.YES_NO);
      if (answer !== ui.Button.YES) return;
    }

    // 初めて始めるときは、今より前の回答は取り込まない（たまっていた回答で、メールが一度に大量に届かないように）
    // 止めていたのを再開するときは、止めていた間に届いた回答も取り込む
    const lastTime = Number(props.getProperty(PROP.LAST_TIME));
    if (lastTime) {
      const waiting = form.getResponses(new Date(lastTime - 1)).filter((r) => r.getTimestamp().getTime() > lastTime).length;
      if (waiting > 0) {
        const answer = ui.alert('止めていた間の問い合わせを取り込みます',
          `止めていた間に届いた問い合わせが ${waiting}件 あります。一覧に入れて、担当者に知らせます。よろしいですか？`, ui.ButtonSet.YES_NO);
        if (answer !== ui.Button.YES) return;
      }
    } else {
      // トリガーより先に位置を決める（トリガーを入れた直後に届いた回答を、取りこぼさないように）
      props.setProperties({ [PROP.LAST_TIME]: String(Date.now()), [PROP.LAST_IDS]: '[]' });
    }
    props.setProperty(PROP.SENDER, me);
    props.deleteProperty(PROP.STOPPED);
    installTriggers_();

    const since = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy/MM/dd HH:mm');
    staff.cells.state.setValue(`オン　${me} から送ります（${since} から）`);
    const result = runOnce_(form, '通知を始める');

    const lines = [
      'これから届く問い合わせを「問い合わせ一覧」に入れ、担当者にメールで知らせます。',
      `メールは ${me} から送られます。`,
    ];
    const remind = remindSettings_();
    lines.push(remind.day < 0 ? '未対応のリマインドは送りません。'
      : `未対応のリマインドは、毎週${WEEKDAYS[remind.day]}曜 ${remind.hour}時に送ります（${remind.after}日より前に受け付けたもの）。`);
    webappUrlCache_ = null;
    if (!buttonUrl_(1)) lines.push('', '通知メールの「対応を始める」ボタンを使うには、ウェブアプリとして公開してください（説明書の「導入のしかた」）。');
    if (result.added) lines.push('', `止めていた間の問い合わせ ${result.added}件 を取り込み、${result.summary}`);
    else if (result.summary) lines.push('', result.summary);
    const tz = ss.getSpreadsheetTimeZone();
    if (tz !== TIME_ZONE) lines.push('', `このスプレッドシートのタイムゾーンが「${tz}」です。受付日時を正しい時刻で見るには、「ファイル → 設定」で「(GMT+09:00) 東京」にしてください。`);
    ui.alert(result.problem ? '通知を始めました（確認してください）' : '通知を始めました', lines.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    Logger.log(e.stack || e);
    ui.alert(e instanceof UserError ? '確認してください' : '管理者に連絡してください', errorText_(e), ui.ButtonSet.OK);
  }
}

/** 管理者用メニュー：通知を止める。止めている間に届いた回答は、次に「通知を始める」を押したときに取り込む */
function stopNotifications() {
  const ui = SpreadsheetApp.getUi();
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty(PROP.SENDER) || props.getProperty(PROP.STOPPED) === '1') {
      ui.alert('通知は止まっています', '始めるときは「通知を始める（管理者）」を押してください。', ui.ButtonSet.OK);
      return;
    }
    const answer = ui.alert('通知を止めますか？',
      '止めている間に届いた問い合わせは、一覧に入らず、担当者にも届きません。\n次に「通知を始める」を押したときに、まとめて一覧に入り、担当者に送られます。',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;
    // 止める印は全員で共有する（ほかの人のトリガーが残っていても、印を見て何もしない）
    props.setProperty(PROP.STOPPED, '1');
    removeMyTriggers_();
    const me = Session.getEffectiveUser().getEmail();
    const at = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy/MM/dd HH:mm');
    ensureStaffSheet_().cells.state.setValue(`停止中　${at} に ${me} が止めました。再開はメニュー「通知を始める」`);
    setListAlert_('');
    ui.alert('通知を止めました', '再開するときは「通知を始める（管理者）」を押してください。', ui.ButtonSet.OK);
  } catch (e) {
    Logger.log(e.stack || e);
    ui.alert('管理者に連絡してください', errorText_(e), ui.ButtonSet.OK);
  }
}

/** メニュー：「未送信」の問い合わせの通知を、もう一度送る */
function resendNotifications() {
  const ss = SpreadsheetApp.getActive();
  try {
    const listed = ensureListSheet_([]);
    const pending = countUnsent_(listed);
    if (pending === 0) {
      ss.toast('送り直す問い合わせはありません', CONFIG.MENU_NAME, 10);
      return;
    }
    ss.toast(`未送信 ${pending}件 の通知を送っています。このままお待ちください`, CONFIG.MENU_NAME, -1);
    const result = sendWithLock_(Date.now() + CONFIG.TIME_BUDGET_SECONDS * 1000);
    if (!result) {
      ss.toast('ほかの通知を送っている途中です。終わると自動で続きも送ります', '確認してください', 20);
      return;
    }
    if (result.newlyFailed.length) alertAdminFailed_(result.newlyFailed);
    setListAlert_(result.stopped ? `送信 ${result.sent}件 で止まりました。${errorText_(result.stopped)}` : '');
    const message = sendSummary_(result);
    ss.toast(message, result.stopped || result.failed || result.remaining ? '確認してください' : CONFIG.MENU_NAME, 30);
  } catch (e) {
    Logger.log(e.stack || e);
    ss.toast(errorText_(e), e instanceof UserError ? '確認してください' : '管理者に連絡してください', 30);
  }
}

// ---- 自動で動くもの（トリガー） ----

/** フォームに回答が届いたとき */
function handleFormSubmit() {
  runAuto_('回答が届いたとき');
}

/** 残りがあるときに、数分後に1回だけ動く */
function continueNotifications() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'continueNotifications')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  runAuto_('続きの送信');
}

/** 毎朝1回：取りこぼしを取り込み、送れていない問い合わせが残っていれば管理者に知らせる */
function dailyCheck() {
  const result = runAuto_('毎朝の確認');
  if (!result) return;
  const listed = ensureListSheet_([]);
  const unsent = countUnsent_(listed);
  if (unsent > 0) {
    alertAdmin_('unsent', `担当者に送れていない問い合わせが ${unsent}件 あります`, [
      '「問い合わせ一覧」の赤い行の「確認事項」を見て直し、メニュー「問い合わせ管理 → 通知を送り直す」を押してください。',
    ]);
  }
}

/**
 * 自動で動いたときの共通の処理。止めている・送信元が替わったときは何もしない
 * エラーは管理者にメールで知らせ、一覧の上の帯にも書く。メールで知らせられなかったときだけ、エラーにして終える
 * （トリガーの持ち主に、Googleから失敗のお知らせが届くように）
 */
function runAuto_(source) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.STOPPED) === '1' || !props.getProperty(PROP.LAST_TIME)) return null;
  const me = Session.getEffectiveUser().getEmail();
  const sender = props.getProperty(PROP.SENDER);
  if (sender && me && me !== sender) {
    removeMyTriggers_(); // 送信元が替わった。前の送信元に残っていたトリガーを片づける
    return null;
  }
  let result;
  try {
    result = runOnce_(openForm_(), source);
  } catch (e) {
    Logger.log(e.stack || e);
    setListAlert_(errorText_(e));
    const alerted = alertAdmin_(e.code || 'E99', `問い合わせの通知でエラーが起きました（${source}）`, [errorText_(e)]);
    if (!alerted) throw e;
    return null;
  }
  // 管理者にメールで知らせられなかった問題（送信数の上限など）は、エラーにして終える
  if (result.problem && !result.alerted) throw new Error(result.problem);
  return result;
}

/**
 * 取り込みと送信を1回する（時間で区切る）。残りがあれば、数分後の続きを予約する
 * 戻り値: { added, summary（使う人向けの結果の文）, problem（管理者向けの問題。なければ空）, alerted（管理者にメールで知らせたか） }
 */
function runOnce_(form, source) {
  const deadline = Date.now() + CONFIG.TIME_BUDGET_SECONDS * 1000;
  const problems = [];
  const staffCheck = refreshStaffChoices_(form);
  if (staffCheck) problems.push(staffCheck);

  const imported = importWithLock_(form, Math.min(deadline, Date.now() + CONFIG.IMPORT_BUDGET_SECONDS * 1000));
  const sent = sendWithLock_(deadline);
  if (imported.more || !sent || sent.remaining) scheduleContinue_();
  if (sent && sent.newlyFailed.length) alertAdminFailed_(sent.newlyFailed);
  if (sent && sent.stopped) problems.push(`送信 ${sent.sent}件 で止まりました。${errorText_(sent.stopped)}`);

  setListAlert_(problems.join('　'));
  let alerted = true;
  // E16（質問がない）は1日1通。E12（送信数の上限）は、メールを送れないので帯だけ
  if (staffCheck) alerted = alertAdmin_('E16', `問い合わせの通知でエラーが起きました（${source}）`, [staffCheck]) && alerted;
  if (sent && sent.stopped) alerted = false;
  return {
    added: imported.added,
    // 送るものがなかったとき（初めて始めたときなど）は、結果の文を出さない
    summary: !sent ? '続きは数分後に自動で送ります。' : sent.sent || sent.failed || sent.remaining || sent.stopped ? sendSummary_(sent) : '',
    problem: problems.join('\n'),
    alerted,
  };
}

/** 送信の結果を、使う人向けの短い文にする（途中で止まったときも、ここまでに送った件数を出す） */
function sendSummary_(r) {
  const parts = [`送信 ${r.sent}件`];
  if (r.failed) parts.push(`送れなかった ${r.failed}件（赤い行）`);
  if (r.remaining) parts.push(`残り ${r.remaining}件 は数分後に自動で送ります`);
  if (r.stopped) parts.push(`止まりました。${errorText_(r.stopped)}`);
  return parts.join('　');
}

/** このアカウントのトリガーを入れ直す（回答が届いたとき・毎朝の確認） */
function installTriggers_() {
  removeMyTriggers_();
  const ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('handleFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('dailyCheck').timeBased().everyDays(1).atHour(CONFIG.DAILY_CHECK_HOUR).inTimezone(TIME_ZONE).create();
  const remind = remindSettings_();
  if (remind.day >= 0) {
    ScriptApp.newTrigger('weeklyReminder').timeBased().onWeekDay(WEEKDAY_ENUM_[remind.day]()).atHour(remind.hour).inTimezone(TIME_ZONE).create();
  }
}

// ScriptApp.WeekDay は読み込んだ時点では使えないことがあるので、使うときに取り出す
const WEEKDAY_ENUM_ = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].map((d) => () => ScriptApp.WeekDay[d]);

/** 「担当者」シートのリマインドの設定。{ day（0=日〜6=土、送らないなら -1）, hour, after（日数） } */
function remindSettings_() {
  const { cells } = ensureStaffSheet_();
  const dayText = String(cells.remindDay.getValue()).trim().replace(/曜日?$/, '');
  const num = (cell, fallback, min, max) => {
    const n = Number(cell.getValue());
    return cell.getValue() === '' || !Number.isFinite(n) || n < min || n > max ? fallback : Math.floor(n);
  };
  return {
    day: dayText === NO_REMIND ? -1 : WEEKDAYS.includes(dayText) ? WEEKDAYS.indexOf(dayText) : 1, // 空欄なら月曜
    hour: num(cells.remindHour, 9, 0, 23),
    after: num(cells.remindAfter, 3, 0, 60),
  };
}

/** このアカウントのトリガーを外す（ほかの人のトリガーは、Googleの仕組みで見えないので外せない） */
function removeMyTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => TRIGGER_HANDLERS.includes(t.getHandlerFunction()))
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/** 数分後に1回だけ、続きを送る（予約がすでにあれば足さない） */
function scheduleContinue_() {
  const exists = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'continueNotifications');
  if (!exists) ScriptApp.newTrigger('continueNotifications').timeBased().after(CONFIG.CONTINUE_AFTER_MINUTES * 60 * 1000).create();
}

// ---- 取り込み ----

/** 新しい回答を一覧に取り込む。ほかで取り込んでいる途中なら待ち、待ちきれなければ続きに回す */
function importWithLock_(form, until) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return { added: 0, updated: 0, more: true };
  try {
    return importNew_(form, until);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 取り込み済みの位置より新しい回答を、一覧の下にまとめて書き込む
 * until を過ぎたら、そこまでで書き込んで位置を進め、残りは次回に回す
 * お客様が回答を直したとき（同じ回答IDがすでに一覧にある）は、行を足さずに中身を直し、黄色にして知らせる
 * 戻り値: { added, updated, more（残りがある） }
 */
function importNew_(form, until) {
  const props = PropertiesService.getScriptProperties();
  const lastTime = Number(props.getProperty(PROP.LAST_TIME));
  if (!lastTime) return { added: 0, updated: 0, more: false }; // まだ「通知を始める」が押されていない
  const lastIds = JSON.parse(props.getProperty(PROP.LAST_IDS) || '[]');

  const responses = form.getResponses(new Date(lastTime - 1))
    .filter((r) => {
      const t = r.getTimestamp().getTime();
      return t > lastTime || (t === lastTime && !lastIds.includes(r.getId()));
    })
    .sort((a, b) => a.getTimestamp() - b.getTimestamp());
  if (responses.length === 0) return { added: 0, updated: 0, more: false };

  const questions = questionsOf_(form);
  const listed = ensureListSheet_(questions);
  const { sheet, headerRow } = listed;
  const cols = listed.cols;
  const width = sheet.getLastColumn();
  const known = listedIds_(listed); // 回答ID → 行
  let number = Number(props.getProperty(PROP.NEXT_NUMBER)) || 1;
  const rows = [];
  const updates = [];
  let done = 0;
  for (const r of responses) {
    if (done > 0 && Date.now() >= until) break;
    done++;
    const answers = answersOf_(questions, r);
    if (known[r.getId()]) {
      updates.push({ row: known[r.getId()], id: r.getId(), answers, time: r.getTimestamp() });
      continue;
    }
    const row = new Array(width).fill('');
    row[cols['受付番号'] - 1] = number++;
    row[cols['受付日時'] - 1] = r.getTimestamp();
    row[cols['状態'] - 1] = STATUSES[0];
    row[cols['通知'] - 1] = UNSENT;
    row[cols['回答ID'] - 1] = r.getId();
    answers.forEach(({ name, value }) => {
      if (cols[name] && value !== '') row[cols[name] - 1] = asText_(value);
    });
    rows.push(row);
  }

  if (rows.length) {
    // 書き込む行を先に決めてから、まとめて書く（途中で人が行を足しても、別の行に書かないように）
    const start = Math.max(sheet.getLastRow(), headerRow) + 1;
    const needed = start + rows.length - 1 - sheet.getMaxRows();
    if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
    sheet.getRange(start, 1, rows.length, width).setValues(rows);
  }
  updates.forEach((u) => applyEdit_(sheet, cols, u));

  // 書き込めてから、取り込み済みの位置を進める（途中で止まっても、回答が欠けないように）
  const handled = responses.slice(0, done);
  const newest = handled[handled.length - 1].getTimestamp().getTime();
  const sameTime = handled.filter((r) => r.getTimestamp().getTime() === newest).map((r) => r.getId());
  props.setProperties({
    [PROP.LAST_TIME]: String(newest),
    [PROP.LAST_IDS]: JSON.stringify(newest === lastTime ? lastIds.concat(sameTime) : sameTime),
    [PROP.NEXT_NUMBER]: String(number),
  });
  applyListLayout_(sheet, headerRow, questions);
  return { added: rows.length, updated: updates.length, more: done < responses.length };
}

/** お客様が直した回答で、一覧の行の中身を直し、黄色にして知らせる */
function applyEdit_(sheet, cols, u) {
  const row = locateRow_(sheet, cols, u.row, '回答ID', u.id);
  if (!row) return; // 行が消されていたら、何もしない
  u.answers.forEach(({ name, value }) => {
    if (cols[name]) sheet.getRange(row, cols[name]).setValue(value === '' ? '' : asText_(value));
  });
  const stamp = Utilities.formatDate(u.time, TIME_ZONE, 'M/d HH:mm');
  sheet.getRange(row, 1, 1, sheet.getLastColumn()).setBackground(WARN_ROW_COLOR);
  sheet.getRange(row, cols['確認事項']).setValue(`お客様が回答を直しました（${stamp}）。内容を確かめたら、この文を消してください`);
}

/** 一覧にある回答ID → 行番号 */
function listedIds_({ sheet, headerRow, cols }) {
  const last = sheet.getLastRow();
  const map = {};
  if (last <= headerRow) return map;
  sheet.getRange(headerRow + 1, cols['回答ID'], last - headerRow, 1).getValues()
    .forEach(([id], i) => { if (id) map[id] = headerRow + 1 + i; });
  return map;
}

/** フォームの質問の一覧 [{name, long, type, itemId}]。name は一覧の列の名前 */
function questionsOf_(form) {
  const skip = [FormApp.ItemType.SECTION_HEADER, FormApp.ItemType.PAGE_BREAK, FormApp.ItemType.IMAGE, FormApp.ItemType.VIDEO];
  const list = form.getItems()
    .filter((item) => !skip.includes(item.getType()))
    .map((item) => ({ name: columnName_(item.getTitle()), title: item.getTitle().trim(), long: item.getType() === FormApp.ItemType.PARAGRAPH_TEXT, type: item.getType(), itemId: item.getId() }));
  // フォームの設定で回答者のメールアドレスを集めているときは、それも列にする
  if (form.collectsEmail()) list.unshift({ name: columnName_('メールアドレス'), title: 'メールアドレス', long: false, type: null, itemId: null });
  // 同じ名前の質問が2つあるときは、2つ目以降に番号を付ける
  const seen = {};
  return list.map((q) => {
    seen[q.name] = (seen[q.name] || 0) + 1;
    return seen[q.name] === 1 ? q : { ...q, name: `${q.name}（${seen[q.name]}）` };
  });
}

/** 1件の回答を [{name, value}] にする（name は questionsOf_ の列の名前） */
function answersOf_(questions, response) {
  const byItem = {};
  response.getItemResponses().forEach((ir) => { byItem[ir.getItem().getId()] = ir; });
  return questions.map((q) => {
    if (q.itemId == null) return { name: q.name, value: response.getRespondentEmail() || '' };
    const ir = byItem[q.itemId];
    return { name: q.name, value: ir ? formatAnswer_(ir.getResponse(), q.type) : '' };
  });
}

/** 回答を、セルに入れる文字にする（複数選択は1行に1つ。ファイルはドライブのリンク） */
function formatAnswer_(value, type) {
  if (value == null) return '';
  if (type === FormApp.ItemType.FILE_UPLOAD) {
    return [].concat(value).map((id) => `https://drive.google.com/open?id=${id}`).join('\n');
  }
  // 選択肢の文に「、」や「/」が入っていても分けられるよう、改行でつなぐ
  if (Array.isArray(value)) return value.map((v) => (Array.isArray(v) ? v.join('・') : String(v == null ? '' : v))).join('\n');
  return String(value);
}

/**
 * お客様の入力は、必ず文字としてセルに入れる
 * 「090…」の電話番号の0が消えたり、「=」で始まる入力が数式として動いたりしないように
 */
function asText_(value) {
  return `'${value}`;
}

/** 質問の名前が、管理用の列（受付番号・メモなど）と同じなら、区別できる名前にする */
function columnName_(title) {
  const name = String(title).trim() || '（名前のない質問）';
  return LIST_HEAD.includes(name) || LIST_TAIL.includes(name) ? `${name}（フォーム）` : name;
}

// ---- 通知 ----

/** 「未送信」の行の通知を送る。ほかで送っている途中なら null（送っている側が、新しい行も続けて送る） */
function sendWithLock_(deadline) {
  const lock = LockService.getDocumentLock(); // 取り込み（スクリプトのロック）とは別のロック。送っている間も取り込めるように
  if (!lock.tryLock(1000)) return null;
  try {
    return sendPending_(deadline);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 一覧の「通知」が「未送信」の行に、メールを送る。送っている間に増えた行も続けて送る
 * 戻り値: { sent, failed, remaining（時間切れで残った件数）, newlyFailed（新しく赤くなった行）, stopped（止めたときのエラー） }
 */
function sendPending_(deadline) {
  const ss = SpreadsheetApp.getActive();
  const result = { sent: 0, failed: 0, remaining: 0, newlyFailed: [], stopped: null };
  const staff = readStaff_();
  webappUrlCache_ = null; // 「ボタンのURL」は、送るたびに読み直す
  const tried = new Set(); // 1回の実行で、同じ行は1回だけ試す（担当者が決まらない行で止まらないように）

  while (!result.stopped) {
    const listed = ensureListSheet_([]);
    const { sheet, headerRow, cols } = listed;
    const last = sheet.getLastRow();
    if (last <= headerRow) break;
    const values = sheet.getRange(headerRow + 1, 1, last - headerRow, sheet.getLastColumn()).getValues();
    const pending = values
      .map((v, i) => ({ v, row: headerRow + 1 + i }))
      .filter(({ v }) => v[cols['通知'] - 1] === UNSENT && !tried.has(v[cols['受付番号'] - 1]));
    if (pending.length === 0) break;

    for (let k = 0; k < pending.length; k++) {
      if (Date.now() >= deadline) { result.remaining = pending.length - k; return result; }
      const { v } = pending[k];
      const number = v[cols['受付番号'] - 1];
      tried.add(number);
      const r = notifyRow_(ss, sheet, pending[k].row, v, cols, staff);
      // メールを送っている間に並べ替えられても、別の行に書かないよう、受付番号で行を確かめてから書く
      const row = locateRow_(sheet, cols, pending[k].row, '受付番号', number);
      if (!row) continue; // 行が消されていた
      if (r.names) sheet.getRange(row, cols['担当者']).setValue(r.names);
      if (r.ok) {
        result.sent++;
        sheet.getRange(row, cols['通知']).setValue(SENT);
        if (v[cols['確認事項'] - 1] !== '') {
          sheet.getRange(row, cols['確認事項']).clearContent();
          resetRowColor_(sheet, row, cols);
        }
      } else {
        result.failed++;
        if (v[cols['確認事項'] - 1] !== r.note) result.newlyFailed.push({ number, note: r.note });
        sheet.getRange(row, 1, 1, sheet.getLastColumn()).setBackground(ERROR_ROW_COLOR);
        sheet.getRange(row, cols['確認事項']).setValue(r.note);
        if (r.stop) { result.stopped = r.stop; break; } // 上限などは、ほかの行を送っても同じなので止める
      }
    }
  }
  return result;
}

/** 行番号の行に、目印の列（受付番号・回答ID）の値があるか確かめる。違えば探し直す。見つからなければ 0 */
function locateRow_(sheet, cols, row, key, value) {
  if (row > 0 && row <= sheet.getLastRow() && sheet.getRange(row, cols[key]).getValue() === value) return row;
  const headerRow = findHeaderRow_(sheet, LIST_HEAD[0]);
  const last = sheet.getLastRow();
  if (!headerRow || last <= headerRow) return 0;
  const i = sheet.getRange(headerRow + 1, cols[key], last - headerRow, 1).getValues().findIndex(([v]) => v === value);
  return i < 0 ? 0 : headerRow + 1 + i;
}

/** 1行分の通知を送る。戻り値: { ok, names, note, stop } */
function notifyRow_(ss, sheet, row, v, cols, staff) {
  const typeCol = cols[columnName_(staff.question)];
  const type = typeCol ? String(v[typeCol - 1]) : '';
  const people = pickPeople_(staff.people, type);
  const names = people.map((p) => p.name || p.email).join('・');
  if (people.length === 0) {
    return { ok: false, note: `「${type.replace(/\n/g, '・') || '（空欄）'}」の担当者が決まっていません。「担当者」シートに、この答えか「${CONFIG.OTHER_ANSWER}」の人のメールアドレスを書いてください（黄色の行は使われません）` };
  }
  if (MailApp.getRemainingDailyQuota() < people.length) return quotaFailure_(names);

  const mail = buildMail_(ss, sheet, row, v, cols, type);
  try {
    MailApp.sendEmail({ ...mail, to: people.map((p) => p.email).join(','), name: CONFIG.MAIL_SENDER_NAME });
    return { ok: true, names };
  } catch (e) {
    Logger.log(`受付番号 ${v[cols['受付番号'] - 1]} の通知を送れません: ${e.stack || e}`);
    if (/too many times|上限/i.test(String(e.message))) return quotaFailure_(names);
    return { ok: false, names, note: '[E13] メールを送れませんでした。管理者に連絡してください' };
  }
}

/** メールの1日の送信数の上限に達したとき（ほかの行を送っても同じなので、送るのを止める） */
function quotaFailure_(names) {
  const stop = new AdminError('E12', 'メールの1日の送信数の上限に達しました', '24時間たつと送れるようになります。そのあと、メニュー「通知を送り直す」を押してください');
  return { ok: false, names, note: `[E12] ${stop.message}。24時間たってから「通知を送り直す」を押してください`, stop };
}

/** 答えに合う担当者を選ぶ。いなければ「（それ以外）」の人。複数選べる質問は、選ばれた答えすべての担当者 */
function pickPeople_(people, type) {
  const answers = String(type).split('\n').map(normalizeAnswer_).filter(Boolean);
  const matched = people.filter((p) => answers.includes(p.answer));
  const list = matched.length ? matched : people.filter((p) => p.answer === normalizeAnswer_(CONFIG.OTHER_ANSWER));
  // 同じ人が2つの答えの担当でも、メールは1通にする
  const seen = new Set();
  return list.filter((p) => (seen.has(p.email) ? false : seen.add(p.email)));
}

/** 答えの表記の違い（全角・半角、空白）を吸収する */
function normalizeAnswer_(s) {
  return String(s).normalize('NFKC').replace(/\s/g, '');
}

function isEmail_(s) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(s));
}

/**
 * 通知メールの件名・本文
 * 返信先はお客様にしない（担当者がそのまま返信すると、社内向けの文や一覧のURLがお客様に届くため）
 * 「対応を始める」ボタンを押すと、一覧が「対応済み」になり、お客様あての新しいメールを書く画面に進める
 * 受付番号・担当者は、担当者には要らないので載せない（件名は、同じ種類の問い合わせが1つの会話にまとまらないよう、名前と日時を入れる）
 */
function buildMail_(ss, sheet, row, v, cols, type) {
  const number = v[cols['受付番号'] - 1];
  const received = v[cols['受付日時'] - 1];
  const answers = answersFromRow_(cols, v).filter((a) => a.value !== '');
  const customer = customerOf_(answers);
  const url = `${ss.getUrl()}#gid=${sheet.getSheetId()}&range=A${row}`;
  const button = buttonUrl_(number);
  const isDate = received instanceof Date;
  const when = isDate ? Utilities.formatDate(received, TIME_ZONE, 'yyyy/MM/dd HH:mm') : String(received);
  let guide = 'お客様とのやり取りを始めたら、一覧の「状態」を「対応済み」にしてください。';
  if (button) {
    guide = customer.email
      ? '「対応を始める」を押すと、一覧の「状態」が「対応済み」になります。出てきた画面の「メールを書く」で、お客様あてのメールを書けます。'
      : 'お客様とのやり取りを始めたら、「対応を始める」を押してください（一覧の「状態」が「対応済み」になります）。';
  }

  const text = [
    '新しい問い合わせが届きました。',
    '',
    `受付日時: ${when}`,
    '',
    ...answers.flatMap((a) => [`■ ${a.name}`, a.value, '']),
  ];
  if (button) text.push(`対応を始める: ${button}`);
  text.push(`一覧を開く: ${url}`, guide, 'このメールに返信すると、お客様ではなく社内に届きます。');

  const br = (s) => escapeHtml_(s).replace(/\n/g, '<br>');
  const html = [
    '<p>新しい問い合わせが届きました。</p>',
    `<p>受付日時: ${escapeHtml_(when)}</p>`,
    ...answers.map((a) => `<p><b>■ ${escapeHtml_(a.name)}</b><br>${br(a.value)}</p>`),
    // ボタンがないとき（ウェブアプリのURLが未設定）は、お客様あてのメールを書くリンクだけ置く
    button ? buttonHtml_(button, '対応を始める') : customer.email ? `<p><a href="${escapeHtml_(replyUrl_(customer))}">お客様に返事を書く</a></p>` : '',
    `<p><a href="${escapeHtml_(url)}">問い合わせ一覧を開く</a></p>`,
    `<p style="color:#666666">${escapeHtml_(guide)}<br>このメールに返信すると、お客様ではなく社内に届きます。</p>`,
  ];
  const parts = ['【問い合わせ】', type ? `${type.replace(/\n/g, '・')} ` : '', customer.name ? `${customer.name} 様 ` : '',
    isDate ? Utilities.formatDate(received, TIME_ZONE, 'M/d HH:mm') : ''];
  const subject = parts.join('').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { subject, body: text.join('\n'), htmlBody: html.join('') };
}

/** 一覧の行から、フォームの質問の答えを [{name, value}]（列の順）にする */
function answersFromRow_(cols, v) {
  const fixed = LIST_HEAD.concat(LIST_TAIL);
  return Object.keys(cols)
    .filter((name) => !fixed.includes(name))
    .sort((a, b) => cols[a] - cols[b])
    .map((name) => ({ name, value: String(v[cols[name] - 1]) }));
}

/** 答えから、お客様の名前とメールアドレスを探す（質問の名前に「名前」「メール」が入っている列） */
function customerOf_(answers) {
  const mail = answers.find((a) => a.name.includes('メール') && isEmail_(a.value.trim()));
  const name = answers.find((a) => a.name.includes('名前') && a.value.trim() !== '');
  return { email: mail ? mail.value.trim() : '', name: name ? name.value.trim() : '' };
}

/**
 * お客様あての新しいメールを開くリンク（宛先・件名・書き出しを入れておく）
 * mailto: は、パソコンにメールアプリが登録されていないと何も起きないので、Gmail の作成画面を開く
 */
function replyUrl_(customer) {
  const body = `${customer.name ? `${customer.name} 様\n\n` : ''}お問い合わせありがとうございます。\n`;
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(customer.email)}`
    + `&su=${encodeURIComponent('お問い合わせの件')}&body=${encodeURIComponent(body)}`;
}

// ---- 「対応を始める」ボタン（ウェブアプリ） ----

/**
 * 「対応を始める」ボタンのリンク。ウェブアプリのURLが設定されていなければ空文字（ボタンを出さない）
 * URLは、管理者がウェブアプリとして公開したときのURLを、「担当者」シートの「ボタンのURL」に貼る
 * （ScriptApp.getService().getUrl() は、公開した版ではなく編集中の版のURLを返すことがあり、そのURLは開けないため）
 * リンクには、このツールだけが作れる合言葉（受付番号から作る）を付ける。番号を書き換えたリンクでは変えられないように
 */
function buttonUrl_(number) {
  if (webappUrlCache_ === null) webappUrlCache_ = String(ensureStaffSheet_().cells.webappUrl.getValue()).trim();
  const base = webappUrlCache_;
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(base)) return '';
  return `${base}?n=${encodeURIComponent(number)}&t=${buttonToken_(number)}`;
}

let webappUrlCache_ = null; // 1回の実行の中で、何度もシートを読まないように

function buttonToken_(number) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(PROP.BUTTON_SECRET);
  if (!secret) {
    secret = Utilities.getUuid();
    props.setProperty(PROP.BUTTON_SECRET, secret);
  }
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(number), secret)).slice(0, 22);
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** メールの中のボタン（メールアプリで崩れにくいよう、表と文字だけで作る） */
function buttonHtml_(url, label) {
  return '<table cellspacing="0" cellpadding="0"><tr><td style="background:#1a73e8;border-radius:4px;padding:10px 20px">'
    + `<a href="${escapeHtml_(url)}" style="color:#ffffff;text-decoration:none;font-weight:bold">${escapeHtml_(label)}</a></td></tr></table>`;
}

/**
 * 「対応を始める」ボタンを押したときに開く画面。その問い合わせを「対応済み」にし、
 * お客様のメールアドレスがあれば、お客様あての新しいメールを書くボタンを出す
 * （この画面から自動でメールを開くことはできない。押されていないのに別の画面へ移るのを、Google が止めているため）
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const number = Number(params.n || 0);
  const token = String(params.t || '');
  if (!number || token !== buttonToken_(number)) {
    return resultPage_('リンクが正しくありません', '通知メールの「対応を始める」から開き直してください。直らないときは、一覧の「状態」を「対応済み」にしてください。');
  }
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) return resultPage_('混み合っています', '少し待ってから、もう一度押してください。');
  try {
    const { sheet, cols } = ensureListSheet_([]);
    const row = locateRow_(sheet, cols, 0, '受付番号', number);
    if (!row) return resultPage_('この問い合わせは見つかりません', '一覧から行が消されています。');
    const v = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
    const cell = sheet.getRange(row, cols['状態']);
    if (cell.getValue() !== STATUSES[1]) cell.setValue(STATUSES[1]);
    const customer = customerOf_(answersFromRow_(cols, v));
    const listUrl = SpreadsheetApp.getActive().getUrl();
    if (!customer.email) {
      return resultPage_('「対応済み」にしました', 'お客様とのやり取りを進めてください。この画面は閉じてかまいません。', { listUrl });
    }
    return resultPage_('「対応済み」にしました', '下の「メールを書く」を押すと、お客様あてのメールが開きます。',
      { listUrl, reply: replyUrl_(customer) });
  } catch (err) {
    Logger.log(err.stack || err);
    return resultPage_('「対応済み」にできませんでした', '一覧の「状態」を「対応済み」にしてください。何度も出るときは、管理者に連絡してください。');
  } finally {
    lock.releaseLock();
  }
}

/** ボタンを押したあとの画面（スマホで読みやすい大きさ）。reply があれば、メールの作成画面を開くボタンを出す */
function resultPage_(title, message, opts) {
  const o = opts || {};
  const mail = o.reply
    ? `<p><a id="mail" href="${escapeHtml_(o.reply)}" target="_top" style="display:inline-block;background:#1a73e8;color:#ffffff;`
      + 'text-decoration:none;font-weight:bold;border-radius:4px;padding:12px 24px">メールを書く</a></p>'
    : '';
  const link = o.listUrl ? `<p><a href="${escapeHtml_(o.listUrl)}" target="_top">問い合わせ一覧を開く</a></p>` : '';
  return HtmlService.createHtmlOutput(
    `<div style="font-family:sans-serif;padding:24px;line-height:1.7"><h2 style="font-size:20px">${escapeHtml_(title)}</h2>`
    + `<p>${escapeHtml_(message)}</p>${mail}${link}</div>`)
    .setTitle('問い合わせ管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---- 未対応のリマインド ----

/** 毎週1回：受け付けてから決めた日数より長く「未対応」の問い合わせを、担当者ごとにまとめて知らせる。管理者には全体の件数 */
function weeklyReminder() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.STOPPED) === '1') return;
  const me = Session.getEffectiveUser().getEmail();
  const sender = props.getProperty(PROP.SENDER);
  if (sender && me && me !== sender) {
    removeMyTriggers_();
    return;
  }
  try {
    const result = sendReminders_(new Date());
    if (result.stopped) throw result.stopped;
  } catch (e) {
    Logger.log(e.stack || e);
    setListAlert_(errorText_(e));
    if (!alertAdmin_(e.code || 'E99', '問い合わせのリマインドでエラーが起きました', [errorText_(e)])) throw e;
  }
}

/** リマインドを送る。戻り値: { people（送った人数）, items（載せた件数）, stopped } */
function sendReminders_(now) {
  const { after } = remindSettings_();
  const { sheet, headerRow, cols } = ensureListSheet_([]);
  const staff = readStaff_();
  const last = sheet.getLastRow();
  const result = { people: 0, items: 0, stopped: null };
  if (last <= headerRow) return result;
  const typeCol = cols[columnName_(staff.question)];
  const limit = now.getTime() - after * 24 * 3600 * 1000;
  const byEmail = {};
  sheet.getRange(headerRow + 1, 1, last - headerRow, sheet.getLastColumn()).getValues().forEach((v) => {
    const received = v[cols['受付日時'] - 1];
    // まだ担当者に届いていない（赤い行の）ものは、送れなかったことを別に知らせているので載せない
    if (v[cols['状態'] - 1] !== STATUSES[0] || v[cols['通知'] - 1] !== SENT) return;
    if (!(received instanceof Date) || received.getTime() > limit) return;
    const type = typeCol ? String(v[typeCol - 1]) : '';
    const customer = customerOf_(answersFromRow_(cols, v));
    const item = { received, type, name: customer.name, email: customer.email };
    pickPeople_(staff.people, type).forEach((p) => {
      (byEmail[p.email] = byEmail[p.email] || { person: p, items: [] }).items.push(item);
    });
    result.items++;
  });

  const ss = SpreadsheetApp.getActive();
  const listUrl = `${ss.getUrl()}#gid=${sheet.getSheetId()}`;
  const summary = [];
  for (const { person, items } of Object.values(byEmail)) {
    if (MailApp.getRemainingDailyQuota() < 2) { // 1通は管理者への知らせに残す
      result.stopped = new AdminError('E12', 'メールの1日の送信数の上限に達しました', `リマインドは ${result.people}人 に送ったところで止まりました。残りは次の週に送られます`);
      break;
    }
    MailApp.sendEmail({ ...reminderMail_(person, items, listUrl), to: person.email, name: CONFIG.MAIL_SENDER_NAME });
    result.people++;
    summary.push(`${person.name || person.email}: ${items.length}件`);
  }
  if (result.items && !result.stopped) {
    alertAdmin_(null, `未対応の問い合わせが ${result.items}件 あります（${after}日より前の受付）`, [
      '担当者ごとの件数（担当者にもリマインドを送りました）:', ...summary,
    ]);
  }
  return result;
}

/** 担当者1人あてのリマインドのメール。未対応の問い合わせの情報（日時・名前・メールアドレス・種類）を並べるだけ */
function reminderMail_(person, items, listUrl) {
  const line = (i) => [Utilities.formatDate(i.received, TIME_ZONE, 'M/d HH:mm'), i.name, i.email, i.type.replace(/\n/g, '・')]
    .filter(Boolean).join('　');
  const lead = `まだ「未対応」の問い合わせが ${items.length}件 あります。`;
  const text = [
    ...(person.name ? [`${person.name}さん`, ''] : []),
    lead,
    '',
    ...items.map((i) => `・${line(i)}`),
    '',
    `問い合わせ一覧: ${listUrl}`,
  ];
  const html = [
    person.name ? `<p>${escapeHtml_(person.name)}さん</p>` : '',
    `<p>${escapeHtml_(lead)}</p>`,
    `<ul>${items.map((i) => `<li>${escapeHtml_(line(i))}</li>`).join('')}</ul>`,
    `<p><a href="${escapeHtml_(listUrl)}">問い合わせ一覧を開く</a></p>`,
  ];
  return { subject: `【問い合わせ】未対応が ${items.length}件 あります`, body: text.join('\n'), htmlBody: html.join('') };
}

// ---- 管理者への知らせ ----

/**
 * 管理者にメールで知らせる。同じ key の知らせは1日1通まで（同じエラーが何十通も届かないように）
 * key が null なら毎回送る。送れたら true（管理者のメールアドレスがない・送信数の上限なら false）
 */
function alertAdmin_(key, subject, lines) {
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
    if (key && props.getProperty(PROP.ALERT_PREFIX + key) === today) return true;
    const admin = String(ensureStaffSheet_().cells.admin.getValue()).trim();
    if (!isEmail_(admin) || MailApp.getRemainingDailyQuota() < 1) return false;
    const url = SpreadsheetApp.getActive().getUrl();
    MailApp.sendEmail({
      to: admin,
      subject: `【問い合わせ管理】${subject}`,
      body: lines.concat(['', `スプレッドシート: ${url}`, 'エラー番号ごとの直し方は、説明書の「エラー番号の一覧」を見てください。']).join('\n'),
      name: CONFIG.MAIL_SENDER_NAME,
    });
    if (key) props.setProperty(PROP.ALERT_PREFIX + key, today);
    return true;
  } catch (e) {
    Logger.log(`管理者に知らせられません: ${e.stack || e}`);
    return false;
  }
}

/** 新しく送れなくなった問い合わせを、まとめて管理者に知らせる */
function alertAdminFailed_(failed) {
  alertAdmin_(null, `担当者に送れなかった問い合わせが ${failed.length}件 あります`, [
    ...failed.map((f) => `受付番号 ${f.number}: ${f.note}`),
    '',
    '直したら、メニュー「問い合わせ管理 → 通知を送り直す」を押してください。',
  ]);
}

// ---- シート ----

/** 見出しの行を探す（上から20行の中で、label と同じ文字のセルがある行）。なければ 0 */
function findHeaderRow_(sheet, label) {
  const rows = Math.min(sheet.getLastRow(), 20);
  const cols = sheet.getLastColumn();
  if (rows === 0 || cols === 0) return 0;
  const i = sheet.getRange(1, 1, rows, cols).getValues().findIndex((r) => r.some((v) => String(v).trim() === label));
  return i + 1;
}

/** 見出しの名前 → 列番号 */
function headerMap_(sheet, headerRow) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return {};
  const map = {};
  sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0].forEach((v, i) => {
    const name = String(v).trim();
    if (name && !map[name]) map[name] = i + 1;
  });
  return map;
}

/**
 * 「問い合わせ一覧」がなければ作る。足りない列（管理用の列・フォームの質問）を足し、見た目をそろえる
 * 見出しの行は、位置ではなく「受付番号」の文字で探す。上の説明の行が消されていたら、行を足して戻す
 * 戻り値: { sheet, headerRow, cols }
 */
function ensureListSheet_(questions) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG.LIST_SHEET_NAME);
  if (!sheet) {
    const current = ss.getActiveSheet();
    sheet = ss.insertSheet(CONFIG.LIST_SHEET_NAME, 0);
    current.activate(); // insertSheet は新しいシートを開いてしまうので、元のシートに戻す
  }
  let headerRow = findHeaderRow_(sheet, LIST_HEAD[0]);
  if (!headerRow) {
    // 説明の行より下に何か入っているのに見出しがない＝見出しを消された。推測で書くと列がずれるので、止めて知らせる
    if (sheet.getLastRow() > LIST_ALERT_ROW) {
      throw new AdminError('E15', '「問い合わせ一覧」の見出しの行が見つかりません',
        '見出しの「受付番号」を消したか書き換えたときに出ます。「編集 → 元に戻す」か「変更履歴」で、見出しの行を戻してください');
    }
    headerRow = LIST_HEADER_ROW;
  } else if (headerRow < LIST_HEADER_ROW) {
    sheet.insertRowsBefore(1, LIST_HEADER_ROW - headerRow);
    headerRow = LIST_HEADER_ROW;
  }

  const cols = headerMap_(sheet, headerRow);
  const add = (name, before) => {
    if (cols[name]) return;
    let col;
    if (before && cols[before]) {
      col = cols[before];
      sheet.insertColumnBefore(col);
      // 足した列は、右の列（メモ）の書式を引き継ぐので、入力の色を消す
      sheet.getRange(headerRow + 1, col, sheet.getMaxRows() - headerRow, 1).setBackground(null);
      Object.keys(cols).forEach((k) => { if (cols[k] >= col) cols[k]++; });
    } else {
      col = Math.max(0, ...Object.values(cols)) + 1;
      if (col > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
    }
    sheet.getRange(headerRow, col).setValue(name);
    cols[name] = col;
  };
  LIST_HEAD.concat(LIST_TAIL).forEach((name) => add(name));
  // 新しい質問は「メモ」の左に足す（使う人が並べ替えていても、名前で探すので崩れない）
  questions.forEach((q) => add(q.name, 'メモ'));
  applyListLayout_(sheet, headerRow, questions);
  return { sheet, headerRow, cols };
}

/** 「問い合わせ一覧」の見た目。シートを作ったときだけでなく、毎回そろえる */
function applyListLayout_(sheet, headerRow, questions) {
  const cols = headerMap_(sheet, headerRow);
  const lastCol = sheet.getLastColumn();
  const rows = sheet.getMaxRows() - headerRow;
  sheet.getRange(1, 1, LIST_HELP.length, 1).setValues(LIST_HELP.map((t) => [t])).setFontColor(NOTE_COLOR);
  sheet.setFrozenRows(headerRow);
  styleHeader_(sheet.getRange(headerRow, 1, 1, lastCol));
  protectHeader_(sheet, sheet.getRange(1, 1, headerRow, lastCol));
  sheet.hideColumns(cols['回答ID']);
  if (rows < 1) return;
  const col = (name) => sheet.getRange(headerRow + 1, cols[name], rows, 1);

  sheet.getRange(headerRow, cols['受付番号'], rows + 1, 1).setHorizontalAlignment('right'); // 見出しも、データと同じ右揃え
  col('受付日時').setNumberFormat('yyyy/mm/dd hh:mm');
  col('状態').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false)
    .setHelpText('一覧から選んでください').build());
  col('メモ').setBackground(INPUT_COLOR);
  applyStatusColors_(sheet, col('状態'));

  const widths = { ...LIST_COLUMN_WIDTHS };
  const wraps = [...LIST_WRAP_COLUMNS];
  questions.forEach((q) => {
    widths[q.name] = q.long ? LONG_QUESTION_WIDTH : QUESTION_WIDTH;
    wraps.push(q.name); // 複数選択（1行に1つ）や長い答えも、全文が見えるように
  });
  // 幅は初期値のままの列だけ変える。使う人が自分で変えた幅はそのまま
  Object.entries(widths).forEach(([name, width]) => {
    if (cols[name] && sheet.getColumnWidth(cols[name]) === DEFAULT_COLUMN_WIDTH) sheet.setColumnWidth(cols[name], width);
  });
  wraps.forEach((name) => { if (cols[name]) col(name).setWrap(true); });
}

/** 見出しの行に、消そうとすると警告が出る保護を付ける（1つだけ。行が動いても保護は一緒に動く） */
function protectHeader_(sheet, range) {
  try {
    const exists = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).some((p) => p.getDescription() === PROTECT_NOTE);
    if (!exists) range.protect().setDescription(PROTECT_NOTE).setWarningOnly(true);
  } catch (e) {
    Logger.log(e.stack || e); // 保護を付けられなくても、動きには関係しない
  }
}

/** 「状態」のセルに、未対応・対応中・完了の色を付ける（条件付き書式。使う人が選び直すと、すぐ色が変わる） */
function applyStatusColors_(sheet, range) {
  // 前に付けた状態の色だけ外して付け直す（使う人が自分で足した条件付き書式は残す）
  const others = sheet.getConditionalFormatRules().filter((rule) => {
    const c = rule.getBooleanCondition();
    return !(c && c.getCriteriaType() === SpreadsheetApp.BooleanCriteria.TEXT_EQUAL_TO && STATUSES.includes(c.getCriteriaValues()[0]));
  });
  const mine = STATUSES.map((s) => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(s).setBackground(STATUS_COLORS[s]).setRanges([range]).build());
  sheet.setConditionalFormatRules(others.concat(mine));
}

/** 行の色を消す（「メモ」の入力の色は残す） */
function resetRowColor_(sheet, row, cols) {
  sheet.getRange(row, 1, 1, sheet.getLastColumn()).setBackground(null);
  if (cols['メモ']) sheet.getRange(row, cols['メモ']).setBackground(INPUT_COLOR);
}

/** 「未送信」の行の数 */
function countUnsent_({ sheet, headerRow, cols }) {
  const last = sheet.getLastRow();
  if (last <= headerRow) return 0;
  return sheet.getRange(headerRow + 1, cols['通知'], last - headerRow, 1).getValues().filter(([v]) => v === UNSENT).length;
}

/** 自動の処理で起きたエラーを、一覧の上に赤い帯で書く（空文字なら消す） */
function setListAlert_(text) {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.LIST_SHEET_NAME);
    if (!sheet || findHeaderRow_(sheet, LIST_HEAD[0]) <= LIST_ALERT_ROW) return;
    const band = sheet.getRange(LIST_ALERT_ROW, 1, 1, sheet.getMaxColumns());
    if (!text) {
      if (sheet.getRange(LIST_ALERT_ROW, 1).getValue() !== '') band.clearContent().setBackground(null);
      return;
    }
    const stamp = Utilities.formatDate(new Date(), TIME_ZONE, 'M/d HH:mm');
    sheet.getRange(LIST_ALERT_ROW, 1).setValue(`${stamp}　${text.replace(/\n/g, '　')}`);
    band.setBackground(ERROR_ROW_COLOR);
  } catch (e) {
    Logger.log(e.stack || e); // 書けなくても、管理者へのメールで分かる
  }
}

/**
 * 「担当者」シートがなければ作る。上の設定の行（A列の名前で探す）が消されていたら、表の上に足し直す
 * 戻り値: { sheet, headerRow, cells: { question, admin, state }（設定の値のセル） }
 */
function ensureStaffSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG.STAFF_SHEET_NAME);
  if (!sheet) {
    const current = ss.getActiveSheet();
    const list = ss.getSheetByName(CONFIG.LIST_SHEET_NAME);
    sheet = ss.insertSheet(CONFIG.STAFF_SHEET_NAME, list ? list.getIndex() : 0);
    current.activate();
    sheet.getRange(1, 1, STAFF_SETTINGS.length, 3).setValues(STAFF_SETTINGS);
    sheet.getRange(STAFF_SETTINGS.length + 1, 1).setValue(STAFF_NOTE).setFontColor(NOTE_COLOR);
    sheet.getRange(STAFF_HEADER_ROW, 1, 1, STAFF_HEADER.length).setValues([STAFF_HEADER]);
    sheet.getRange(STAFF_HEADER_ROW + 1, 1).setValue(CONFIG.OTHER_ANSWER);
    [220, 200, 280, 320].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  }
  let headerRow = findHeaderRow_(sheet, STAFF_HEADER[0]);
  if (!headerRow) {
    // 表の中身（メールアドレスか「（それ以外）」）が残っているのに見出しがない＝見出しを消された
    const values = sheet.getLastRow() ? sheet.getRange(1, 1, sheet.getLastRow(), 3).getValues() : [];
    if (values.some((r) => r[0] === CONFIG.OTHER_ANSWER || String(r[2]).includes('@'))) {
      throw new AdminError('E15', '「担当者」シートの見出しの行が見つかりません',
        '見出しの「答え」を消したか書き換えたときに出ます。「編集 → 元に戻す」か「変更履歴」で、見出しの行を戻してください');
    }
    headerRow = Math.max(sheet.getLastRow() + 2, STAFF_HEADER_ROW);
    sheet.getRange(headerRow, 1, 1, STAFF_HEADER.length).setValues([STAFF_HEADER]);
    sheet.getRange(headerRow + 1, 1).setValue(CONFIG.OTHER_ANSWER);
  }

  // 設定の行を、A列の名前で探す。なければ表の上に足す（値は初期値）
  const cells = {};
  STAFF_SETTING_KEYS.forEach((key, i) => {
    const labels = sheet.getRange(1, 1, Math.max(headerRow - 1, 1), 1).getValues().map((r) => String(r[0]).trim());
    let row = labels.indexOf(STAFF_SETTINGS[i][0]) + 1;
    if (!row || row >= headerRow) {
      sheet.insertRowBefore(headerRow);
      // 足した行は、下の見出しの書式（グレー・太字・罫線）を引き継ぐので、消してから書く
      sheet.getRange(headerRow, 1, 1, STAFF_HEADER.length).clearFormat();
      sheet.getRange(headerRow, 1, 1, 3).setValues([STAFF_SETTINGS[i]]);
      row = headerRow;
      headerRow++;
    }
    cells[key] = sheet.getRange(row, 2);
    sheet.getRange(row, 1).setFontWeight('bold');
    // 説明の文は、ツールが書くもの。直したときに今あるシートにも届くよう、毎回書き直す
    sheet.getRange(row, 3).setValue(STAFF_SETTINGS[i][2]).setFontColor(NOTE_COLOR);
  });
  cells.question.setBackground(INPUT_COLOR);
  cells.admin.setBackground(INPUT_COLOR).setDataValidation(emailRule_());
  cells.remindDay.setBackground(INPUT_COLOR).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(WEEKDAYS.concat([NO_REMIND]), true).setAllowInvalid(false).setHelpText('曜日を選んでください').build());
  cells.remindHour.setBackground(INPUT_COLOR).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberBetween(0, 23).setAllowInvalid(false).setHelpText('0〜23 の数字を入れてください（9 なら朝9時）').build());
  cells.webappUrl.setBackground(INPUT_COLOR);
  cells.remindAfter.setBackground(INPUT_COLOR).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberBetween(0, 60).setAllowInvalid(false).setHelpText('0〜60 の数字を入れてください').build());

  sheet.setFrozenRows(headerRow);
  styleHeader_(sheet.getRange(headerRow, 1, 1, STAFF_HEADER.length));
  protectHeader_(sheet, sheet.getRange(headerRow, 1, 1, STAFF_HEADER.length));
  const rows = sheet.getMaxRows() - headerRow;
  if (rows > 0) {
    // 入力の色をそろえる。ただし「確認事項」がある行（黄色の行）は、色を残す
    const notes = sheet.getRange(headerRow + 1, 4, rows, 1).getValues();
    const colors = notes.map(([note]) => new Array(3).fill(note === '' ? INPUT_COLOR : WARN_ROW_COLOR));
    sheet.getRange(headerRow + 1, 1, rows, 3).setBackgrounds(colors);
    sheet.getRange(headerRow + 1, 3, rows, 1).setDataValidation(emailRule_());
    sheet.getRange(headerRow + 1, 4, rows, 1).setWrap(true);
  }
  return { sheet, headerRow, cells };
}

function emailRule_() {
  return SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(false)
    .setHelpText('メールアドレスを入れてください（例: yamada@example.com）').build();
}

/**
 * フォームに合わせて「担当者」シートの選べる値をそろえる
 * - 担当者を決める質問（B1）は、フォームの選択式の質問から選ぶ
 * - 答えの列は、その質問の選択肢と「（それ以外）」から選ぶ。表が空なら、選択肢を書いておく
 * 質問がフォームにないときは、その文（管理者向けのエラー E16）を返す。問題がなければ空文字
 */
function refreshStaffChoices_(form) {
  const staff = ensureStaffSheet_();
  const { sheet, headerRow, cells } = staff;
  const props = PropertiesService.getScriptProperties();
  const choiceTypes = [FormApp.ItemType.MULTIPLE_CHOICE, FormApp.ItemType.LIST, FormApp.ItemType.CHECKBOX];
  const choiceItems = form.getItems().filter((i) => choiceTypes.includes(i.getType()));
  const titles = choiceItems.map((i) => i.getTitle().trim());
  if (titles.length) {
    cells.question.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(titles, true).setAllowInvalid(false)
      .setHelpText('フォームの質問から選んでください').build());
  }
  const question = String(cells.question.getValue()).trim();
  const item = choiceItems.find((i) => i.getTitle().trim() === question);
  const answerRange = sheet.getRange(headerRow + 1, 1, Math.max(sheet.getMaxRows() - headerRow, 1), 1);
  if (!item) {
    props.deleteProperty(PROP.CHOICES);
    answerRange.clearDataValidations();
    const isQuestion = form.getItems().some((i) => i.getTitle().trim() === question);
    if (isQuestion) return ''; // 選択式でない質問（自由に書く質問）なら、答えはそのまま照らし合わせる
    return `[E16] 担当者を決める質問「${question}」が、フォームにありません。「担当者」シートの「担当者を決める質問」で選び直してください（それまでは「${CONFIG.OTHER_ANSWER}」の人に届きます）`;
  }
  const typed = item.getType() === FormApp.ItemType.MULTIPLE_CHOICE ? item.asMultipleChoiceItem()
    : item.getType() === FormApp.ItemType.LIST ? item.asListItem() : item.asCheckboxItem();
  const choices = typed.getChoices().map((c) => c.getValue());
  props.setProperty(PROP.CHOICES, JSON.stringify(choices));
  answerRange.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(choices.concat([CONFIG.OTHER_ANSWER]), true)
    .setAllowInvalid(false).setHelpText('フォームの選択肢から選んでください').build());

  // 表が「（それ以外）」だけなら、選択肢を書いておく（打ち間違いを防ぐ）
  const last = sheet.getLastRow();
  const table = last > headerRow ? sheet.getRange(headerRow + 1, 1, last - headerRow, 3).getValues().filter((r) => r.join('') !== '') : [];
  if (table.every((r) => r[0] === CONFIG.OTHER_ANSWER && r[1] === '' && r[2] === '')) {
    const rows = choices.map((c) => [c, '', '']).concat([[CONFIG.OTHER_ANSWER, '', '']]);
    if (last > headerRow) sheet.getRange(headerRow + 1, 1, last - headerRow, 3).clearContent();
    sheet.getRange(headerRow + 1, 1, rows.length, 3).setValues(rows);
  }
  return '';
}

/**
 * 「担当者」シートを読む。{ question, people: [{answer, name, email}] }（メールアドレスが空の行は除く）
 * 答えがフォームの選択肢にない行・メールアドレスの形が違う行は、黄色にして理由を書く（その行の人には送らない）
 */
function readStaff_() {
  const { sheet, headerRow, cells } = ensureStaffSheet_();
  const question = String(cells.question.getValue()).trim() || CONFIG.DEFAULT_TYPE_QUESTION;
  const saved = PropertiesService.getScriptProperties().getProperty(PROP.CHOICES);
  const choices = saved ? JSON.parse(saved).concat([CONFIG.OTHER_ANSWER]).map(normalizeAnswer_) : null;
  const last = sheet.getLastRow();
  const rows = last > headerRow ? sheet.getRange(headerRow + 1, 1, last - headerRow, 4).getValues() : [];
  const people = [];
  rows.forEach(([answer, name, email, note], i) => {
    const row = headerRow + 1 + i;
    const p = { answer: normalizeAnswer_(answer), name: String(name).trim(), email: String(email).trim() };
    let problem = '';
    if (p.email && choices && !choices.includes(p.answer)) problem = 'この答えはフォームの選択肢にありません。選び直してください';
    else if (p.email && !isEmail_(p.email)) problem = 'メールアドレスの形が正しくありません';
    if (problem) {
      sheet.getRange(row, 1, 1, 4).setBackground(WARN_ROW_COLOR);
      sheet.getRange(row, 4).setValue(problem);
      return;
    }
    if (note !== '') {
      sheet.getRange(row, 1, 1, 3).setBackground(INPUT_COLOR);
      sheet.getRange(row, 4).clearContent().setBackground(null);
    }
    if (p.email) people.push(p);
  });
  return { question, people };
}

/** このスプレッドシートにつながっているフォームを開く */
function openForm_() {
  const url = SpreadsheetApp.getActive().getFormUrl();
  if (!url) {
    throw new AdminError('E11', 'このスプレッドシートにフォームがつながっていません',
      'フォームの編集画面の「回答」→「スプレッドシートにリンク」で、このスプレッドシートを選んでください');
  }
  try {
    return FormApp.openByUrl(url);
  } catch (e) {
    Logger.log(`フォームを開けません（${url}）: ${e.stack || e}`);
    throw new AdminError('E14', 'フォームを開けません', 'フォームが消されたか、「通知を始める」を押した人がフォームの編集者から外れています');
  }
}

/** 表の見出しの見た目（太字・薄いグレー・下に罫線） */
function styleHeader_(range) {
  range.setFontWeight('bold').setBackground(HEADER_COLOR).setBorder(null, null, true, null, null, null);
}

/** エラーを、見る人が分かる文にする（想定外のエラーの中身は、管理者が「実行数」のログで見る） */
function errorText_(e) {
  if (e instanceof AdminError) return `[${e.code}] ${e.message}　${e.detail}`;
  if (e instanceof UserError) return e.message;
  return '[E99] 想定外のエラーが起きました。製作者に連絡してください（Apps Script の「実行数」に詳しい内容があります）';
}
