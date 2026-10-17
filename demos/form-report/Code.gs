/**
 * フォームの回答を、決まった間隔で集計してメールで送る
 *
 * 流れ: 1時間ごとに、送る時刻を過ぎたかを確かめる → 過ぎていれば、前の期間（前の日・週・月）の回答を
 *       フォームの回答シートから集めて集計 → 送り先にメール → 「集計の履歴」に1行残す → 「推移のグラフ」を作り直す
 *       フォームが回答の受付を終えたら、最後の分（「1回だけ」なら、それまでの全部）を1回送って終わる
 *       （フォームの締め切りの日時は、GASからは読めない。読めるのは「今、受け付けているか」だけなので、1時間ごとに確かめる）
 *
 * 事前準備（管理者）:
 *   - フォームの回答先を、このスプレッドシートにする（フォームの「回答」→「スプレッドシートにリンク」）
 *   - 「設定」シートに、送り先と管理者のメールアドレスを書く
 *   - メニュー「アンケート集計 → 送信を始める」を1回押す（押した人のGmailから送られる）
 *   「設定」「集計の履歴」シートは開いたときに、「集計する質問」シートは「送信を始める」を押したときに作られる
 *
 * 自動で動くもの（トリガー。「送信を始める」で入り、「送信を止める」で外れる）:
 *   - hourlyCheck: 1時間ごと。送る時刻を過ぎて、まだ送っていない期間があれば送る
 *     （決まった時刻のトリガーにしないのは、設定を変えてもトリガーを入れ直さずに済み、
 *       送れなかった期間も、直ったあとの1時間以内に自動で送り直せるため）
 * 自動で動いている最中のエラーは、画面に出せないので、管理者にメールで知らせ、「集計の履歴」の上の帯にも書く
 *
 * どの期間まで送ったかは、スクリプトプロパティに残す（履歴の行を消しても、同じ期間を2回送らないように）
 */

const CONFIG = {
  SETTINGS_SHEET_NAME: '設定',
  QUESTIONS_SHEET_NAME: '集計する質問',
  HISTORY_SHEET_NAME: '集計の履歴',
  CHART_SHEET_NAME: '推移のグラフ',
  MENU_NAME: 'アンケート集計',
  MAIL_SENDER_NAME: 'アンケート集計',
  LOCK_WAIT_MS: 30000, // ほかの送信が終わるのを待つ時間（1回の送信は数秒）
  // 送れなかった期間を、直ったあとにさかのぼって送る数の上限（長く止まっていたときに、メールが一度に何通も届かないように）
  MAX_CATCH_UP: 5,
};

const TIME_ZONE = 'Asia/Tokyo'; // 日付はすべて日本時間で扱う（プロジェクトの設定に左右されないように）
const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // 日本時間は夏時間がないので、9時間ずらすだけで日付を決められる
const DAY_MS = 24 * 60 * 60 * 1000;

// 色は「スプレッドシートの見た目ルール」に合わせる
const ERROR_ROW_COLOR = '#f4cccc'; // 送れなかった行・エラーの帯の背景（薄い赤）
const WARN_ROW_COLOR = '#fff2cc'; // 確認が必要な設定の行の背景（薄い黄）
const HEADER_COLOR = '#f3f3f3'; // 表の見出しの背景（薄いグレー）
const INPUT_COLOR = '#e8f0fe'; // 使う人が入力・選択するセルの背景（薄い青）
const NOTE_COLOR = '#666666'; // 補足の文字
const DEFAULT_COLUMN_WIDTH = 100; // スプレッドシートの列幅の初期値
const PROTECT_NOTE = 'アンケート集計ツールの見出し'; // 見出しの行に付ける保護（消そうとすると警告が出る）の名前

const ONCE = '1回だけ';
const INTERVALS = ['毎日', '毎週', '毎月', ONCE];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAY_CHOICES = ['月', '火', '水', '木', '金', '土', '日']; // プルダウンの並び（月曜始まり）
const HOUR_CHOICES = Array.from({ length: 24 }, (_, h) => `${h}時`);

// 「設定」シートの行（A列の名前で探す。消されたら、下に足し直す）
const SETTINGS = [
  { key: 'to', label: '送り先', note: '集計を受け取る人のメールアドレス。複数のときは、改行かカンマで区切る', input: true },
  { key: 'admin', label: '管理者のメールアドレス', note: '自動の送信でエラーが起きたとき、ここへ知らせる', input: true },
  { key: 'interval', label: '送る間隔', note: '毎日＝前の日の分、毎週＝前の週（7日間）の分、毎月＝前の月の分を送る。1回だけ＝フォームの受付が終わったときに、それまでの分を1回だけ送る', input: true, choices: INTERVALS, initial: '毎週' },
  { key: 'weekday', label: '送る曜日', note: '「毎週」のときだけ使う。この曜日の前の日までの7日間を集計する（月曜なら、前の週の月〜日）', input: true, choices: WEEKDAY_CHOICES, initial: '月' },
  { key: 'hour', label: '送る時刻', note: 'この時刻から1時間のうちに届く。「毎月」は1日のこの時刻', input: true, choices: HOUR_CHOICES, initial: '9時' },
  { key: 'state', label: '送信の状態', note: 'ツールが書く。始める・止めるは、メニュー「アンケート集計」から（管理者）' },
];
const SETTINGS_HEADER = ['項目', '内容', '説明'];
const SETTINGS_HEADER_ROW = 3; // 「設定」シートを作るときの、表の見出し行（上に題名と説明）

const QUESTIONS_HEADER = ['質問', '種類', '集計する'];
const QUESTIONS_HEADER_ROW = 2;
const QUESTIONS_NOTE = 'フォームの質問が自動で並びます。集計に入れない質問（お名前など）は、「集計する」のチェックを外してください';

// この右に、段階評価の質問ごとの「平均：〇〇」の列と、選択式・複数選択の選択肢ごとの「〇〇：選択肢」（件数）の列が増えていく（グラフの元）
const HISTORY_HEAD = ['期間', '回答数', '送った日時', '確認事項'];
const AVERAGE_PREFIX = '平均：';
const CHOICE_SEPARATOR = '：'; // 「質問：選択肢」の列の名前の区切り
const HISTORY_HEADER_ROW = 4;
const HISTORY_ALERT_ROW = 3; // 自動の処理で起きたエラーを書く行
const HISTORY_HELP = [
  '期間ごとに1行。赤い行＝送れなかった期間（直ると1時間以内に自動で送り直します）。黄色い行＝送らないことになった期間（「確認事項」に理由）',
];
const SKIPPED_PREFIX = '送っていません'; // 黄色い行の「確認事項」の書き出し
const HISTORY_COLUMN_WIDTHS = { 期間: 200, 送った日時: 130, 確認事項: 320 };
const AVERAGE_WIDTH = 140;

// フォームの回答のシートの列幅（質問の種類ごと）。長い文が入る列は折り返す
const ANSWER_WIDTHS = { タイムスタンプ: 150, 段階評価: 120, 選択式: 150, 複数選択: 240, 記述式: 280, そのほか: 160 };
const ANSWER_OTHER_WIDTH = 200; // 質問でない列（メールアドレスなど）
const ANSWER_WRAP_KINDS = ['複数選択', '記述式'];

// フォームの質問の種類 → 集計のしかた
const KIND = { SCALE: '段階評価', CHOICE: '選択式', CHECKBOX: '複数選択', TEXT: '記述式', OTHER: 'そのほか' };
const OTHER_CHOICE = 'その他'; // フォームの選択肢にない答え（「その他」の欄に書かれたもの）

const PROP = {
  SENDER: 'REPORT_SENDER', // 送るアカウント（最後に「送信を始める」を押した人）
  STOPPED: 'REPORT_STOPPED', // 「送信を止める」で '1'
  LAST_END: 'REPORT_LAST_END', // 送り終えた期間のうち、一番新しい期間の終わり（ミリ秒）
  SCHEDULE: 'REPORT_SCHEDULE', // LAST_END を決めたときの「送る間隔|送る曜日」（変わったら、次の期間から送る）
  CLOSED_AT: 'REPORT_CLOSED_AT', // フォームの受付が終わって、最後の分を送り終えた日時（ミリ秒）。受付を再開したら消す
  CLOSE_SEEN: 'REPORT_CLOSE_SEEN', // フォームの受付が終わったと初めて分かった日時（最後の期間の終わり。送り直しても、期間の名前が変わらないように）
  LAID_OUT: 'REPORT_LAID_OUT', // 列幅を整えた回答のシートと列（{ id, titles }）。使う人があとで変えた幅を戻さないように
};

const TRIGGER_HANDLERS = ['hourlyCheck'];

// エラーの種類（UserError・AdminError）と errorText_ は Errors.gs、シートの部品は Sheet.gs、管理者への知らせは Alert.gs（lib/gas/ のコピー）
// このデモの AdminError の番号（README の「管理者向け：エラー番号の一覧」と合わせる。E01〜E05 はAIの部品で使う番号なので避ける）
//   E11 このスプレッドシートにフォームがつながっていない
//   E12 メールの1日の送信数の上限に達した
//   E13 メールを送れない（そのほかの理由）
//   E14 フォームを開けない（消された・権限がない）
//   E15 フォームの回答のシートが見つからない
//   E17 「設定」シートの送り先・間隔などが正しくない

/** スプレッドシートを開いたときに、メニューとシートを用意する */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(CONFIG.MENU_NAME)
    .addItem('前回分を今すぐ送る（管理者）', 'sendLatestNow')
    .addSeparator()
    .addItem('送信を始める（管理者）', 'startReports')
    .addItem('送信を止める（管理者）', 'stopReports')
    .addToUi();
  try {
    // 開いたときはフォームを読む権限がないので、「集計する質問」シートは「送信を始める」のときに作る
    ensureSettingsSheet_();
    ensureHistorySheet_();
  } catch (e) {
    Logger.log(e.stack || e);
  }
}

/**
 * 「設定」シートを書き換えたら、「送信の状態」の次に送る日時を書き直す
 * 設定の間違い（E17）の帯が出ていて、直ったら、帯も消す
 */
function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== CONFIG.SETTINGS_SHEET_NAME) return;
  try {
    refreshState_(Date.now());
    const history = SpreadsheetApp.getActive().getSheetByName(CONFIG.HISTORY_SHEET_NAME);
    const band = history ? String(history.getRange(HISTORY_ALERT_ROW, 1).getValue()) : '';
    if (band.includes('[E17]') && !readSettings_().problems.length) setHistoryAlert_('');
  } catch (err) {
    Logger.log(err.stack || err);
  }
}

// ---- メニュー ----

/**
 * 管理者用メニュー：送信を始める（再開する）。トリガーを入れる
 * 初めて始めるときは、すでに終わった期間は送らない（次の期間から送る）
 * 止めていたのを再開するときは、止めていた間の期間の数を見せて、送るかどうかを選んでもらう
 */
function startReports() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  try {
    const source = openSource_();
    const settings = readSettings_();
    if (settings.problems.length) {
      ensureSettingsSheet_().sheet.activate();
      throw new UserError(settings.problems.join('\n'));
    }
    if (!source.form.isAcceptingResponses()) {
      throw new UserError('フォームが回答を受け付けていません。フォームの「回答を受け付ける」をオンにしてから押してください（受付が終わった回答は、フォームの回答のシートで見られます）');
    }
    const questions = refreshQuestions_(source.form);
    layoutAnswers_(source.sheet, questions);

    const props = PropertiesService.getScriptProperties();
    const me = Session.getEffectiveUser().getEmail();
    const sender = props.getProperty(PROP.SENDER);
    const running = sender && props.getProperty(PROP.STOPPED) !== '1';
    if (running && sender !== me) {
      const answer = ui.alert('送信元を替えますか？',
        `今は ${sender} から送っています。\n替えると、これからは ${me}（あなた）から送ります。\n${sender} のアカウントがまだ使えるなら、先にそのアカウントで「送信を止める」を押してください。`,
        ui.ButtonSet.YES_NO);
      if (answer !== ui.Button.YES) return;
    }

    const now = Date.now();
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) throw new UserError('ほかの送信が終わってから、もう一度押してください');
    let caughtUp = null;
    try {
      syncSchedule_(props, settings, now);
      const last = Number(props.getProperty(PROP.LAST_END)) || 0;
      props.deleteProperty(PROP.CLOSED_AT); // 受付中のフォームで始めるので、受付の終わりはこれから
      props.deleteProperty(PROP.CLOSE_SEEN);
      if (settings.interval === ONCE) {
        if (!last) props.setProperty(PROP.LAST_END, String(now)); // 自動の確認が動く印（「1回だけ」では区切りに使わない）
      } else if (!last) {
        advanceLastEnd_(props, latestEnd_(now, settings, true), '');
      } else if (!running) {
        const missed = duePeriods_(now, settings, last);
        if (missed.length) {
          const older = missed[0].start > last ? `\n（さかのぼって送れるのは ${CONFIG.MAX_CATCH_UP}期間 までです。それより前の期間は送りません）` : '';
          const answer = ui.alert('止めていた間の集計を送りますか？',
            `止めていた間に終わった期間が ${missed.length}期間 あります（${missed[0].label} 〜 ${missed[missed.length - 1].label}）。${older}\n\n「OK」で、送り先に ${missed.length}通 送ります。「いいえ」で送らずに、次の期間から送ります。`,
            ui.ButtonSet.YES_NO_CANCEL);
          if (answer !== ui.Button.YES && answer !== ui.Button.NO) return;
          if (answer === ui.Button.YES) {
            if (missed[0].start > last) {
              advanceLastEnd_(props, missed[0].start, `さかのぼれる数（${CONFIG.MAX_CATCH_UP}期間）を超えたため`, missed.map((p) => p.label));
            }
            caughtUp = sendPeriods_(missed, settings);
          } else {
            advanceLastEnd_(props, missed[missed.length - 1].end, '送信を止めていたため');
          }
        }
      }
      props.setProperty(PROP.SENDER, me);
      props.deleteProperty(PROP.STOPPED);
    } finally {
      lock.releaseLock();
    }
    installTriggers_();
    const next = refreshState_(now);
    if (caughtUp && caughtUp.error) throw caughtUp.error;
    setHistoryAlert_('');

    const lines = [];
    if (caughtUp) lines.push(`止めていた間の ${caughtUp.sent.length}期間 の集計を送りました。`, '');
    lines.push(
      settings.interval === ONCE ? 'フォームの受付が終わったら（終わってから1時間のうちに）、それまでの回答を全部まとめて1回だけ送ります。'
        : `${next}、${periodWord_(settings)}の集計を送ります。そのあとも${settings.interval}送り、フォームの受付が終わったら、最後の分を送って終わります。`,
      `メールは ${me} から、送り先の ${settings.to.length}人 に送られます。`,
      '',
      `集計に入れない質問（お名前など）は、「${CONFIG.QUESTIONS_SHEET_NAME}」シートでチェックを外してください（今は ${questions.filter((q) => q.include).length}問 を集計します）。`,
    );
    if (settings.interval !== ONCE) lines.push('すぐに中身を見たいときは、メニュー「前回分を今すぐ送る（管理者）」を押してください。');
    const tz = ss.getSpreadsheetTimeZone();
    if (tz !== TIME_ZONE) lines.push('', `このスプレッドシートのタイムゾーンが「${tz}」です。回答の日時を正しい時刻で見るには、「ファイル → 設定」で「(GMT+09:00) 東京」にしてください。`);
    ui.alert('送信を始めました', lines.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    Logger.log(e.stack || e);
    ui.alert(e instanceof UserError ? '確認してください' : '管理者に連絡してください', errorText_(e), ui.ButtonSet.OK);
  }
}

/** 管理者用メニュー：送信を止める */
function stopReports() {
  const ui = SpreadsheetApp.getUi();
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty(PROP.SENDER) || props.getProperty(PROP.STOPPED) === '1') {
      ui.alert('送信は止まっています', '始めるときは「送信を始める（管理者）」を押してください。', ui.ButtonSet.OK);
      return;
    }
    const answer = ui.alert('送信を止めますか？',
      `止めている間は、集計のメールが届きません。\n再開するときに、止めていた間の期間の数が出て、送るかどうかを選べます（さかのぼれるのは ${CONFIG.MAX_CATCH_UP}期間 まで）。`,
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;
    // 止める印は全員で共有する（ほかの人のトリガーが残っていても、印を見て何もしない）
    props.setProperty(PROP.STOPPED, '1');
    removeMyTriggers_();
    refreshState_(Date.now());
    setHistoryAlert_('');
    ui.alert('送信を止めました', '再開するときは「送信を始める（管理者）」を押してください。', ui.ButtonSet.OK);
  } catch (e) {
    Logger.log(e.stack || e);
    ui.alert('管理者に連絡してください', errorText_(e), ui.ButtonSet.OK);
  }
}

/** 管理者用メニュー：終わった期間のうち一番新しいものを、今すぐ送り先に送る（送信を止めていても送れる） */
function sendLatestNow() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  try {
    const settings = readSettings_();
    if (settings.problems.length) {
      ensureSettingsSheet_().sheet.activate();
      throw new UserError(settings.problems.join('\n'));
    }
    if (settings.interval === ONCE) {
      throw new UserError('「1回だけ」は、フォームの受付が終わったときに自動で送ります。今までの回答は、フォームの回答のシートで見られます');
    }
    const period = periodOf_(latestEnd_(Date.now(), settings, false), settings);
    // メールは押した人のGmailから送られる。ふだんの送信元と違う人が押したら、確かめる
    const me = Session.getEffectiveUser().getEmail();
    const sender = PropertiesService.getScriptProperties().getProperty(PROP.SENDER);
    const lines = [`${period.label} の集計を、送り先の ${settings.to.length}人 に送ります。`, `送信元：${me}（あなた）`];
    if (sender && sender !== me) lines.push('', `ふだんは ${sender} から送っています。あなたのGmailから送ってよいときだけ「OK」を押してください。`);
    const answer = ui.alert('集計を送りますか？', lines.join('\n'), ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;

    ss.toast('集計しています。このままお待ちください', CONFIG.MENU_NAME, -1);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
      ss.toast('ほかの送信が終わってから、もう一度押してください', '確認してください', 20);
      return;
    }
    let result;
    try {
      result = sendPeriods_([period], settings);
    } finally {
      lock.releaseLock();
    }
    if (result.error) throw result.error;
    // これより前の、送れずに残っていた期間は、自動では送らなくなる（送った位置が先に進んだため）
    markSkipped_('あとの期間を「前回分を今すぐ送る」で送ったため', [period.label]);
    refreshState_(Date.now());
    ss.toast(`${period.label}　回答 ${result.sent[0].count}件 の集計を送りました`, CONFIG.MENU_NAME, 20);
  } catch (e) {
    Logger.log(e.stack || e);
    ss.toast('', '', 1); // 「集計しています」を消す
    ui.alert(e instanceof UserError ? '確認してください' : '管理者に連絡してください', errorText_(e), ui.ButtonSet.OK);
  }
}

// ---- 自動で動くもの（トリガー） ----

/**
 * 1時間ごと：送る時刻を過ぎて、まだ送っていない期間があれば送る
 * フォームの受付が終わっていたら、最後の分も送って終わる（そのあとは、受付を再開するまで何もしない）
 * 止めている・送信元が替わったときは何もしない
 * エラーは管理者にメールで知らせ、「集計の履歴」の上の帯にも書く。メールで知らせられなかったときだけ、エラーにして終える
 * （トリガーの持ち主に、Googleから失敗のお知らせが届くように）
 */
function hourlyCheck() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.STOPPED) === '1' || !props.getProperty(PROP.LAST_END)) return;
  const me = Session.getEffectiveUser().getEmail();
  const sender = props.getProperty(PROP.SENDER);
  if (sender && me && me !== sender) {
    removeMyTriggers_(); // 送信元が替わった。前の送信元に残っていたトリガーを片づける
    return;
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return; // 「前回分を今すぐ送る」の途中。次の1時間で確かめる
  try {
    const now = Date.now();
    const settings = readSettings_();
    if (settings.problems.length) {
      throw new AdminError('E17', '「設定」シートを直してください', settings.problems.join('　'));
    }
    syncSchedule_(props, settings, now);
    const last = Number(props.getProperty(PROP.LAST_END));
    const due = settings.interval === ONCE ? [] : duePeriods_(now, settings, last);
    let source;
    try {
      source = openSource_();
    } catch (e) {
      due.forEach((p) => recordHistory_(p, null, null, errorText_(e))); // 送れなかった期間を赤い行で残す
      throw e;
    }
    const closed = !source.form.isAcceptingResponses();
    if (!closed) { // 受付中（または再開した）。また決まった間隔で送る
      props.deleteProperty(PROP.CLOSED_AT);
      props.deleteProperty(PROP.CLOSE_SEEN);
    }
    if (closed && props.getProperty(PROP.CLOSED_AT)) { // 受付が終わって、最後の分も送り終えている
      refreshState_(now);
      setHistoryAlert_('');
      return;
    }
    // 長く送れなかったときは、さかのぼれる数より前の期間は送らない（メールが一度に何通も届かないように）
    if (due.length && due[0].start > last) {
      advanceLastEnd_(props, due[0].start, `さかのぼれる数（${CONFIG.MAX_CATCH_UP}期間）を超えたため`, due.map((p) => p.label));
    }
    if (closed) {
      // 「1回だけ」は最初の回答から、それ以外は最後に送る期間のあとから、受付が終わったと分かった今まで
      const times = readResponses_(source.sheet).map((r) => r.time);
      const start = settings.interval === ONCE ? (times.length ? Math.min(...times) : now) : (due.length ? due[due.length - 1].end : last);
      if (!props.getProperty(PROP.CLOSE_SEEN)) props.setProperty(PROP.CLOSE_SEEN, String(now));
      const final = finalPeriod_(start, Number(props.getProperty(PROP.CLOSE_SEEN)));
      if (final) due.push(final);
      else props.setProperty(PROP.CLOSED_AT, String(now)); // 送る分がない（最後の期間を送った直後に締め切った）
    }
    const result = due.length ? sendPeriods_(due, settings) : { error: null };
    refreshState_(now);
    if (result.error) throw result.error;
    setHistoryAlert_('');
  } catch (e) {
    Logger.log(e.stack || e);
    setHistoryAlert_(errorText_(e));
    // 送信数の上限（E12）は、管理者へのメールも送れないので、帯とGoogleからの失敗のお知らせで知らせる
    const alerted = e.code !== 'E12' && alertAdmin_(e.code || 'E99', 'アンケートの集計を送れませんでした', [
      errorText_(e),
      ...(e.raw ? ['', `詳しい内容: ${e.raw}`] : []),
      '',
      '直ると、1時間以内に自動で送り直します。',
    ]);
    if (!alerted) throw e;
  } finally {
    lock.releaseLock();
  }
}

/** このアカウントのトリガーを入れ直す（1時間ごと） */
function installTriggers_() {
  removeMyTriggers_();
  ScriptApp.newTrigger('hourlyCheck').timeBased().everyHours(1).create();
}

/** このアカウントのトリガーを外す（ほかの人のトリガーは、Googleの仕組みで見えないので外せない） */
function removeMyTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => TRIGGER_HANDLERS.includes(t.getHandlerFunction()))
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

// ---- どこまで送ったか ----

/**
 * 「送る間隔」「送る曜日」が前と変わっていたら、新しい区切りで終わっている期間は送らず、次の期間から送る
 * （変えた直後に、新しい区切りの過去の期間が何通もまとめて届かないように）
 */
function syncSchedule_(props, settings, now) {
  const key = `${settings.interval}|${settings.interval === '毎週' ? settings.weekday : ''}`;
  const before = props.getProperty(PROP.SCHEDULE);
  if (before === key) return;
  props.setProperty(PROP.SCHEDULE, key);
  if (settings.interval === ONCE) return; // 「1回だけ」は受付の終わりに送るだけ。決まった区切りに戻したときに、次の期間から送る
  if (before && props.getProperty(PROP.LAST_END)) advanceLastEnd_(props, latestEnd_(now, settings, true), '「送る間隔」か「送る曜日」を変えたため');
}

/**
 * 送り終えた位置（LAST_END）を end まで進める（戻しはしない）
 * reason があれば、送らないことになった期間（送った日時のない赤い行）を、理由つきの黄色い行に変える
 * keepLabels の期間は、このあと送るので変えない
 */
function advanceLastEnd_(props, end, reason, keepLabels) {
  const last = Number(props.getProperty(PROP.LAST_END)) || 0;
  if (end > last) props.setProperty(PROP.LAST_END, String(end));
  if (reason) markSkipped_(reason, keepLabels || []);
}

// ---- 送信 ----

/**
 * 期間ごとに集計してメールを送り、「集計の履歴」に残す。途中で失敗したら、そこで止める（あとの期間は次回に送る）
 * 戻り値: { sent: [{ end, count }], error（止まった理由。なければ null） }
 */
function sendPeriods_(periods, settings) {
  const sent = [];
  let source;
  let questions;
  try {
    source = openSource_();
    const all = refreshQuestions_(source.form);
    layoutAnswers_(source.sheet, all);
    questions = all.filter((q) => q.include);
  } catch (e) {
    periods.forEach((p) => recordHistory_(p, null, null, errorText_(e)));
    return { sent, error: e };
  }
  const rows = readResponses_(source.sheet);
  for (const period of periods) {
    const report = aggregate_(questions, rows, period);
    try {
      if (MailApp.getRemainingDailyQuota() < settings.to.length) {
        throw new AdminError('E12', 'メールの1日の送信数の上限に達しました', '明日になると送れます。届いていない期間は、自動で送り直します');
      }
      const mail = buildMail_(report, source.sheet);
      MailApp.sendEmail({ to: settings.to.join(','), subject: mail.subject, body: mail.body, htmlBody: mail.html, name: CONFIG.MAIL_SENDER_NAME });
    } catch (e) {
      let err = e;
      if (!(e instanceof AdminError)) {
        // シートには日本語の短い文だけを出す。英語の詳しい内容は、管理者へのメールとログに回す
        err = new AdminError('E13', 'メールを送れませんでした', '「送り先」のアドレスが正しいか確かめてください。詳しい内容は管理者へのメールにあります');
        err.raw = String(e.message || e);
      }
      recordHistory_(period, report, null, errorText_(err));
      return { sent, error: err };
    }
    // 1期間送るたびに、どこまで送ったかを残す（途中で止まっても、送った期間をもう一度送らないように）
    if (period.final) PropertiesService.getScriptProperties().setProperty(PROP.CLOSED_AT, String(period.end));
    else advanceLastEnd_(PropertiesService.getScriptProperties(), period.end, '');
    recordHistory_(period, report, new Date(), '');
    sent.push({ end: period.end, count: report.count });
  }
  return { sent, error: null };
}

/** フォームと、その回答のシートを開く */
function openSource_() {
  const ss = SpreadsheetApp.getActive();
  const url = ss.getFormUrl();
  if (!url) {
    throw new AdminError('E11', 'このスプレッドシートにフォームがつながっていません',
      'フォームの編集画面の「回答」→「スプレッドシートにリンク」で、このスプレッドシートを選んでください');
  }
  let form;
  try {
    form = FormApp.openByUrl(url);
  } catch (e) {
    Logger.log(`フォームを開けません（${url}）: ${e.stack || e}`);
    throw new AdminError('E14', 'フォームを開けません', 'フォームが消されたか、「送信を始める」を押した人がフォームの編集者から外れています');
  }
  const id = form.getId();
  const sheet = ss.getSheets().find((s) => formIdOf_(s.getFormUrl()) === id);
  if (!sheet) {
    throw new AdminError('E15', 'フォームの回答のシートが見つかりません',
      '回答のシートが消されたときは、フォームの編集画面の「回答」→「スプレッドシートにリンク」で、このスプレッドシートを選び直してください');
  }
  return { form, sheet };
}

/** フォームのURLから、フォームのIDを取り出す（つながっていなければ空） */
function formIdOf_(url) {
  const m = String(url || '').match(/\/forms\/d\/(?:e\/)?([^/?#]+)/);
  return m ? m[1] : '';
}

/**
 * フォームの回答のシートを読む。1行目が見出し（1列目がタイムスタンプ、あとは質問の題）
 * 戻り値: [{ time（ミリ秒）, answers: { 質問の題: 答え } }]。日時でない行（手で書き足した行など）は飛ばす
 */
function readResponses_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const titles = values[0].map((v) => String(v).trim());
  return values.slice(1)
    .filter((r) => r[0] instanceof Date)
    .map((r) => {
      const answers = {};
      titles.forEach((t, i) => { if (i > 0 && t && !(t in answers)) answers[t] = r[i]; });
      return { time: r[0].getTime(), answers };
    });
}

// ---- 集計（シートやメールに触らない計算だけ） ----

/**
 * 期間の中の回答を、質問ごとに集計する
 * questions: [{ title, kind, choices（選択式・複数選択の選択肢）, low, high（段階評価の範囲） }]
 * 戻り値: { period, count, items: [{ title, kind, answered, average, buckets: [{ label, count }] }] }
 */
function aggregate_(questions, rows, period) {
  const inPeriod = rows.filter((r) => r.time >= period.start && r.time < period.end);
  const items = questions.map((q) => {
    const values = inPeriod.map((r) => r.answers[q.title]).filter((v) => v !== '' && v != null);
    const item = { title: q.title, kind: q.kind, answered: values.length };
    if (q.kind === KIND.SCALE) {
      const nums = values.map(Number).filter((n) => Number.isFinite(n));
      item.answered = nums.length;
      item.average = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
      item.low = q.low;
      item.high = q.high;
      item.buckets = [];
      for (let n = q.high; n >= q.low; n--) item.buckets.push({ label: String(n), count: nums.filter((v) => v === n).length });
    } else if (q.kind === KIND.CHOICE || q.kind === KIND.CHECKBOX) {
      const counts = new Map(q.choices.map((c) => [c, 0]));
      let other = 0;
      values.forEach((v) => {
        const picked = q.kind === KIND.CHECKBOX ? splitCheckbox_(String(v), q.choices) : { found: q.choices.includes(String(v)) ? [String(v)] : [], other: !q.choices.includes(String(v)) };
        picked.found.forEach((c) => counts.set(c, counts.get(c) + 1));
        if (picked.other) other++;
      });
      item.buckets = [...counts].map(([label, count]) => ({ label, count }));
      if (other) item.buckets.push({ label: OTHER_CHOICE, count: other });
    }
    return item;
  });
  return { period, count: inPeriod.length, items };
}

/**
 * 複数選択の答え（シートでは「A, B」のように「, 」でつながる）を、選択肢に分ける
 * 選択肢そのものに「, 」が入っていても分けられるよう、長くつながる選択肢から当てる
 * 戻り値: { found: [選択肢], other（選択肢にない答えがあったか） }
 */
function splitCheckbox_(value, choices) {
  const parts = value.split(', ');
  const found = [];
  let other = false;
  for (let i = 0; i < parts.length;) {
    let j = parts.length;
    while (j > i && !choices.includes(parts.slice(i, j).join(', '))) j--;
    if (j > i) {
      found.push(parts.slice(i, j).join(', '));
      i = j;
    } else {
      other = true; // 「その他」の欄に書かれた答え（「, 」が入っていても1つと数える）
      i++;
    }
  }
  return { found: [...new Set(found)], other };
}

/** 割合（%、小数なし）。分母が0なら0 */
function percent_(count, total) {
  return total ? Math.round((count / total) * 100) : 0;
}

// ---- 期間（シートに触らない計算だけ） ----

/** 日本時間の年・月・日・曜日 */
function jstParts_(ms) {
  const t = new Date(ms + JST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay(), h: t.getUTCHours(), min: t.getUTCMinutes() };
}

/** 日本時間の y年m月d日 0時（ミリ秒）。月や日があふれても、正しい日に繰り上がる */
function jstMidnight_(y, m, d) {
  return Date.UTC(y, m - 1, d) - JST_OFFSET_MS;
}

/**
 * now の時点で終わっている期間のうち、一番新しい期間の終わり（その日の0時）
 * honorHour が true なら、送る時刻（終わりの日の○時）を過ぎていない期間は、まだ終わっていないものとする
 */
function latestEnd_(now, settings, honorHour) {
  const p = jstParts_(now);
  const today = jstMidnight_(p.y, p.m, p.d);
  const hourMs = honorHour ? settings.hour * 60 * 60 * 1000 : 0;
  let end;
  if (settings.interval === '毎日') {
    end = today;
  } else if (settings.interval === '毎週') {
    end = today - ((p.wd - settings.weekday + 7) % 7) * DAY_MS;
  } else {
    end = jstMidnight_(p.y, p.m, 1);
  }
  if (now < end + hourMs) end = previousEnd_(end, settings);
  return end;
}

/** 1つ前の期間の終わり（＝この期間の始まり） */
function previousEnd_(end, settings) {
  if (settings.interval === '毎日') return end - DAY_MS;
  if (settings.interval === '毎週') return end - 7 * DAY_MS;
  const p = jstParts_(end);
  return jstMidnight_(p.y, p.m - 1, 1);
}

/** 1つ後の期間の終わり */
function nextEnd_(end, settings) {
  if (settings.interval === '毎日') return end + DAY_MS;
  if (settings.interval === '毎週') return end + 7 * DAY_MS;
  const p = jstParts_(end);
  return jstMidnight_(p.y, p.m + 1, 1);
}

/** 終わり（0時）から、期間 { start, end, label } を作る */
function periodOf_(end, settings) {
  const start = previousEnd_(end, settings);
  const s = jstParts_(start);
  const last = jstParts_(end - DAY_MS); // 期間の最後の日
  let label;
  if (settings.interval === '毎日') label = `${s.y}/${s.m}/${s.d}(${WEEKDAYS[s.wd]})`;
  else if (settings.interval === '毎週') label = `${s.y}/${s.m}/${s.d}(${WEEKDAYS[s.wd]})〜${last.m}/${last.d}(${WEEKDAYS[last.wd]})`;
  else label = `${s.y}年${s.m}月`;
  return { start, end, label };
}

/**
 * フォームの受付が終わったときに送る、最後の期間（start から受付が終わったと分かった now まで）
 * 「1回だけ」は最初の回答から全部、それ以外は最後に送った期間のあとから。集める期間がなければ null
 */
function finalPeriod_(start, now) {
  if (start >= now) return null;
  const s = jstParts_(start);
  const e = jstParts_(now);
  const endText = `${e.y === s.y ? '' : `${e.y}/`}${e.m}/${e.d}(${WEEKDAYS[e.wd]})`;
  return { start, end: now, label: `${s.y}/${s.m}/${s.d}(${WEEKDAYS[s.wd]})〜${endText}（受付終了まで）`, final: true };
}

/** まだ送っていない、送る時刻を過ぎた期間（古い順。多くても CONFIG.MAX_CATCH_UP 個） */
function duePeriods_(now, settings, lastEnd) {
  const list = [];
  for (let end = latestEnd_(now, settings, true); end > lastEnd && list.length < CONFIG.MAX_CATCH_UP; end = previousEnd_(end, settings)) {
    list.unshift(periodOf_(end, settings));
  }
  return list;
}

/** 次に送る日時（ミリ秒）。送る時刻を過ぎて、まだ送っていない期間があれば now */
function nextSendTime_(now, settings, lastEnd) {
  if (duePeriods_(now, settings, lastEnd).length) return now;
  const hourMs = settings.hour * 60 * 60 * 1000;
  let end = latestEnd_(now, settings, false);
  while (end + hourMs <= now) end = nextEnd_(end, settings);
  return end + hourMs;
}

/** 日時を「10/19(月) 9時台」の形にする */
function sendTimeText_(ms) {
  const p = jstParts_(ms);
  return `${p.m}/${p.d}(${WEEKDAYS[p.wd]}) ${p.h}時台`;
}

/** 「前の週」など、集計する期間の呼び方 */
function periodWord_(settings) {
  return { 毎日: '前の日', 毎週: '前の週', 毎月: '前の月' }[settings.interval];
}

// ---- メール ----

/** 集計のメール（件名・本文・HTMLの本文）を作る */
function buildMail_(report, responseSheet) {
  const { period, count, items } = report;
  const subject = `【アンケート集計】${period.label}　回答 ${count}件`;
  const url = `${SpreadsheetApp.getActive().getUrl()}#gid=${responseSheet.getSheetId()}`;
  const text = [`${period.label} のアンケートの集計です。`, `回答 ${count}件`, ''];
  const html = [
    `<p>${escapeHtml_(period.label)} のアンケートの集計です。</p>`,
    `<p style="font-size:16px"><b>回答 ${count}件</b></p>`,
  ];
  if (count === 0) {
    text.push('この期間の回答はありませんでした。');
    html.push('<p>この期間の回答はありませんでした。</p>');
  } else {
    items.forEach((item) => {
      const head = itemHeadline_(item);
      text.push(`■ ${item.title}`, `　${head}`);
      html.push(`<p style="margin:16px 0 4px"><b>${escapeHtml_(item.title)}</b><br>${escapeHtml_(head)}</p>`);
      if (item.buckets) {
        const total = item.kind === KIND.SCALE || item.kind === KIND.CHOICE ? item.buckets.reduce((a, b) => a + b.count, 0) : item.answered;
        const rowsHtml = item.buckets.map((b) => {
          const label = item.kind === KIND.SCALE ? `${b.label}点` : b.label;
          text.push(`　${label}：${b.count}件（${percent_(b.count, total)}%）`);
          return `<tr><td style="padding:2px 12px 2px 0">${escapeHtml_(label)}</td>`
            + `<td style="padding:2px 12px;text-align:right">${b.count}件</td>`
            + `<td style="padding:2px 0;text-align:right">${percent_(b.count, total)}%</td></tr>`;
        });
        html.push(`<table style="border-collapse:collapse;font-size:14px">${rowsHtml.join('')}</table>`);
      }
      text.push('');
    });
  }
  text.push('', `回答の一覧: ${url}`);
  html.push(`<p style="margin-top:24px"><a href="${escapeHtml_(url)}">回答の一覧を開く</a></p>`);
  return { subject, body: text.join('\n'), html: html.join('\n') };
}

/** 質問ごとの1行目（平均・回答の件数） */
function itemHeadline_(item) {
  if (item.kind === KIND.SCALE) {
    return item.answered ? `平均 ${item.average.toFixed(1)}点（${item.low}〜${item.high}点、回答 ${item.answered}件）` : '回答なし';
  }
  if (item.kind === KIND.CHECKBOX) return `回答 ${item.answered}件（複数選択。割合は回答した人のうち選んだ人）`;
  if (item.kind === KIND.CHOICE) return `回答 ${item.answered}件`;
  return `記入 ${item.answered}件（中身は回答の一覧で見られます）`;
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- エラーの知らせ ----

/** 管理者にメールで知らせる（同じ key は1日1通）。送れたら true */
function alertAdmin_(key, subject, lines) {
  let to = '';
  try {
    to = readSettings_().admin;
  } catch (e) {
    Logger.log(e.stack || e);
  }
  return sendAdminAlert_({ to, key, subject: `【アンケート集計】${subject}`, lines, senderName: CONFIG.MAIL_SENDER_NAME });
}

/** 自動の処理で起きたエラーを、「集計の履歴」の上に赤い帯で書く（空文字なら消す） */
function setHistoryAlert_(text) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.HISTORY_SHEET_NAME);
  if (!sheet || findHeaderRow_(sheet, HISTORY_HEAD[0]) <= HISTORY_ALERT_ROW) return;
  setAlertBand_(sheet, HISTORY_ALERT_ROW, text);
}

// ---- 「設定」シート ----

/**
 * 「設定」シートがなければ作る。設定の行（A列の名前で探す）が消されていたら、下に足し直す。見た目は毎回そろえる
 * 戻り値: { sheet, cells: { key: 値のセル } }
 */
function ensureSettingsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET_NAME);
  if (!sheet) {
    const current = ss.getActiveSheet();
    sheet = ss.insertSheet(CONFIG.SETTINGS_SHEET_NAME, 0);
    current.activate(); // insertSheet は新しいシートを開いてしまうので、元のシートに戻す
    sheet.getRange(1, 1).setValue('アンケート集計の設定').setFontSize(14).setFontWeight('bold');
    sheet.getRange(2, 1).setValue('薄い青のセルを書き換えてください。変えた内容は、次に送るときから使われます').setFontColor(NOTE_COLOR);
    sheet.getRange(SETTINGS_HEADER_ROW, 1, 1, 3).setValues([SETTINGS_HEADER]);
    sheet.getRange(SETTINGS_HEADER_ROW + 1, 1, SETTINGS.length, 3)
      .setValues(SETTINGS.map((s) => [s.label, asText_(s.initial), s.note]));
  }
  const labels = sheet.getLastRow() ? sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(([v]) => String(v).trim()) : [];
  const cells = {};
  SETTINGS.forEach((s) => {
    let row = labels.indexOf(s.label) + 1;
    if (!row) {
      row = Math.max(sheet.getLastRow(), SETTINGS_HEADER_ROW) + 1;
      sheet.getRange(row, 1, 1, 3).setValues([[s.label, asText_(s.initial), s.note]]);
      labels[row - 1] = s.label;
    }
    // 説明の文は毎回書き直す（あとで文を直したときも、今あるシートに届くように）
    sheet.getRange(row, 3).setValue(s.note).setFontColor(NOTE_COLOR).setWrap(true);
    sheet.getRange(row, 1).setFontWeight('bold');
    sheet.getRange(row, 1, 1, 3).setVerticalAlignment('middle'); // 説明が2行になっても、項目と内容が上下の真ん中にそろう
    const cell = sheet.getRange(row, 2).setWrap(true); // 「送信の状態」など、長い文も切れずに読める
    if (s.input) {
      cell.setBackground(INPUT_COLOR).setWrap(true).setHorizontalAlignment('left');
      if (s.choices) {
        cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(s.choices, true).setAllowInvalid(false).build());
      }
    }
    cells[s.key] = cell;
  });
  const headerRow = findHeaderRow_(sheet, SETTINGS_HEADER[0]);
  if (headerRow) {
    const header = sheet.getRange(headerRow, 1, 1, 3);
    styleHeader_(header);
    protectHeader_(sheet, header);
    sheet.setFrozenRows(headerRow);
  }
  [[1, 170], [2, 280], [3, 460]].forEach(([col, width]) => {
    if (sheet.getColumnWidth(col) === DEFAULT_COLUMN_WIDTH) sheet.setColumnWidth(col, width);
  });
  return { sheet, cells };
}

/**
 * 「設定」シートを読む
 * 戻り値: { to: [アドレス], admin, interval, weekday（0=日〜6=土）, hour, problems: [直してほしいこと] }
 */
function readSettings_() {
  const { cells } = ensureSettingsSheet_();
  const value = (key) => String(cells[key].getValue()).trim();
  const problems = [];

  const toText = value('to');
  const to = toText.split(/[\s,、，;；]+/).filter(Boolean);
  const badTo = to.filter((a) => !isEmail_(a));
  if (!to.length) problems.push('「送り先」に、集計を受け取る人のメールアドレスを書いてください');
  else if (badTo.length) problems.push(`「送り先」のメールアドレスの形が違います：${badTo.join('、')}`);

  const admin = value('admin');
  if (!isEmail_(admin)) problems.push('「管理者のメールアドレス」を書いてください（エラーが起きたときに、ここへ知らせます）');

  let interval = value('interval');
  if (interval === '') interval = '毎週';
  if (!INTERVALS.includes(interval)) problems.push(`「送る間隔」は ${INTERVALS.join('・')} から選んでください`);

  const dayText = value('weekday').replace(/曜日?$/, '');
  const weekday = dayText === '' ? 1 : WEEKDAYS.indexOf(dayText);
  if (weekday < 0) problems.push('「送る曜日」は 月〜日 から選んでください');

  // 「9時」が時刻（9:00）として入っていても読めるようにする
  const hourValue = cells.hour.getValue();
  const hourText = hourValue instanceof Date
    ? Utilities.formatDate(hourValue, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'HH')
    : value('hour').replace(/時$/, '');
  const hour = hourText === '' ? 9 : Number(hourText);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) problems.push('「送る時刻」は 0時〜23時 から選んでください');

  // 直してほしい行は黄色にする（直ったら色を戻す）
  [['to', !to.length || badTo.length], ['admin', !isEmail_(admin)], ['interval', !INTERVALS.includes(interval)],
    ['weekday', weekday < 0], ['hour', !Number.isInteger(hour) || hour < 0 || hour > 23]]
    .forEach(([key, bad]) => cells[key].setBackground(bad ? WARN_ROW_COLOR : INPUT_COLOR));

  return { to, admin, interval, weekday, hour, problems };
}

/** 文字のまま入れたい値（「9時」が時刻にならないように）。空なら空 */
function asText_(v) {
  return v ? `'${v}` : '';
}

function isEmail_(s) {
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(String(s));
}

/** 「送信の状態」を書き直す。次に送る日時の文（「10/19(月) 9時台に」「まもなく」）を返す */
function refreshState_(now) {
  const props = PropertiesService.getScriptProperties();
  const { cells } = ensureSettingsSheet_();
  const sender = props.getProperty(PROP.SENDER);
  let text;
  let next = '';
  if (!sender || props.getProperty(PROP.STOPPED) === '1') {
    text = '止めています。始めるときは、メニュー「送信を始める（管理者）」';
  } else {
    const settings = readSettings_();
    if (settings.problems.length) {
      text = `送信中（${sender} から）。設定に直すところがあるので、送れません`;
    } else if (props.getProperty(PROP.CLOSED_AT)) {
      const p = jstParts_(Number(props.getProperty(PROP.CLOSED_AT)));
      text = `フォームの受付が終わったので、最後の分を送りました（${p.m}/${p.d}）。受付を再開すると、また送ります`;
    } else if (settings.interval === ONCE) {
      text = `送信中（${sender} から）。フォームの受付が終わったら、1時間のうちに、それまでの分をまとめて送ります`;
    } else {
      const at = nextSendTime_(now, settings, Number(props.getProperty(PROP.LAST_END)) || 0);
      next = at <= now ? 'まもなく' : `${sendTimeText_(at)}に`;
      text = `送信中（${sender} から）。次は ${next}、${periodWord_(settings)}の分を送ります`;
    }
  }
  if (cells.state.getValue() !== text) cells.state.setValue(text);
  return next;
}

// ---- 「集計する質問」シート ----

/**
 * フォームの質問を「集計する質問」シートに並べ直す（チェックの状態は、質問の題で引き継ぐ。新しい質問はチェックあり）
 * 戻り値: [{ title, kind, choices, low, high, include }]（フォームの質問の順）
 */
function refreshQuestions_(form) {
  const questions = form.getItems().map(questionOf_).filter(Boolean);
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG.QUESTIONS_SHEET_NAME);
  if (!sheet) {
    const current = ss.getActiveSheet();
    sheet = ss.insertSheet(CONFIG.QUESTIONS_SHEET_NAME, 1);
    current.activate();
  }
  let headerRow = findHeaderRow_(sheet, QUESTIONS_HEADER[0]);
  const checked = new Map();
  if (headerRow) {
    const cols = headerMap_(sheet, headerRow);
    const last = sheet.getLastRow();
    if (last > headerRow && cols['質問'] && cols['集計する']) {
      const titles = sheet.getRange(headerRow + 1, cols['質問'], last - headerRow, 1).getValues();
      const marks = sheet.getRange(headerRow + 1, cols['集計する'], last - headerRow, 1).getValues();
      titles.forEach(([t], i) => { if (String(t).trim()) checked.set(String(t).trim(), marks[i][0] !== false); });
    }
  } else {
    headerRow = QUESTIONS_HEADER_ROW;
  }
  questions.forEach((q) => { q.include = checked.has(q.title) ? checked.get(q.title) : true; });

  // 表を書き直す（このシートは、ツールが毎回フォームから作り直す。使う人が変えるのは「集計する」だけ）
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), headerRow + questions.length, 1), 3).clearContent().clearDataValidations().setBackground(null);
  sheet.getRange(1, 1).setValue(QUESTIONS_NOTE).setFontColor(NOTE_COLOR);
  const header = sheet.getRange(headerRow, 1, 1, 3).setValues([QUESTIONS_HEADER]);
  styleHeader_(header);
  protectHeader_(sheet, header);
  sheet.setFrozenRows(headerRow);
  if (questions.length) {
    sheet.getRange(headerRow + 1, 1, questions.length, 3).setValues(questions.map((q) => [`'${q.title}`, q.kind, q.include]));
    sheet.getRange(headerRow + 1, 3, questions.length, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build())
      .setBackground(INPUT_COLOR).setHorizontalAlignment('center');
  }
  sheet.getRange(headerRow, 3).setHorizontalAlignment('center');
  [[1, 320], [2, 100], [3, 80]].forEach(([col, width]) => {
    if (sheet.getColumnWidth(col) === DEFAULT_COLUMN_WIDTH) sheet.setColumnWidth(col, width);
  });
  sheet.getRange(headerRow + 1, 1, Math.max(questions.length, 1), 1).setWrap(true);
  return questions;
}

/** フォームの質問1つを、集計のしかたつきの形にする（説明の文・区切りなど、答えのないものは null） */
function questionOf_(item) {
  const T = FormApp.ItemType;
  const type = item.getType();
  const title = String(item.getTitle()).trim();
  if (!title) return null;
  const base = { title, choices: [], low: 0, high: 0 };
  if (type === T.SCALE) {
    const s = item.asScaleItem();
    return { ...base, kind: KIND.SCALE, low: s.getLowerBound(), high: s.getUpperBound() };
  }
  if (T.RATING && type === T.RATING) {
    return { ...base, kind: KIND.SCALE, low: 1, high: item.asRatingItem().getRatingScaleLevel() };
  }
  if (type === T.MULTIPLE_CHOICE) return { ...base, kind: KIND.CHOICE, choices: item.asMultipleChoiceItem().getChoices().map((c) => c.getValue()) };
  if (type === T.LIST) return { ...base, kind: KIND.CHOICE, choices: item.asListItem().getChoices().map((c) => c.getValue()) };
  if (type === T.CHECKBOX) return { ...base, kind: KIND.CHECKBOX, choices: item.asCheckboxItem().getChoices().map((c) => c.getValue()) };
  if (type === T.TEXT || type === T.PARAGRAPH_TEXT) return { ...base, kind: KIND.TEXT };
  if ([T.SECTION_HEADER, T.PAGE_BREAK, T.IMAGE, T.VIDEO].includes(type)) return null;
  return { ...base, kind: KIND.OTHER }; // 日付・時刻・グリッドなど。記入の件数だけ数える
}

// ---- 「集計の履歴」シート ----

/** 「集計の履歴」がなければ作り、見た目をそろえる。戻り値: { sheet, headerRow, cols } */
function ensureHistorySheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG.HISTORY_SHEET_NAME);
  if (!sheet) {
    const current = ss.getActiveSheet();
    sheet = ss.insertSheet(CONFIG.HISTORY_SHEET_NAME);
    current.activate();
  }
  let headerRow = findHeaderRow_(sheet, HISTORY_HEAD[0]);
  if (!headerRow) {
    if (sheet.getLastRow() > 0) sheet.insertRowsBefore(1, HISTORY_HEADER_ROW);
    headerRow = HISTORY_HEADER_ROW;
    sheet.getRange(headerRow, 1, 1, HISTORY_HEAD.length).setValues([HISTORY_HEAD]);
  } else if (headerRow < HISTORY_HEADER_ROW) {
    // 上の説明の行が消されていたら、行を足して戻す（帯を書く行が、見出しやデータにならないように）
    sheet.insertRowsBefore(1, HISTORY_HEADER_ROW - headerRow);
    headerRow = HISTORY_HEADER_ROW;
  }
  sheet.getRange(1, 1).setValue('アンケート集計の履歴').setFontSize(14).setFontWeight('bold');
  sheet.getRange(2, 1).setValue(HISTORY_HELP.join('　')).setFontColor(NOTE_COLOR);
  const cols = headerMap_(sheet, headerRow);
  HISTORY_HEAD.forEach((name) => {
    if (!cols[name]) {
      const col = sheet.getLastColumn() + 1;
      sheet.getRange(headerRow, col).setValue(name);
      cols[name] = col;
    }
  });
  const header = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn());
  styleHeader_(header);
  protectHeader_(sheet, header);
  sheet.setFrozenRows(headerRow);
  ['回答数', '送った日時'].forEach((name) => sheet.getRange(headerRow, cols[name]).setHorizontalAlignment('right'));
  Object.entries(HISTORY_COLUMN_WIDTHS).forEach(([name, width]) => {
    if (sheet.getColumnWidth(cols[name]) === DEFAULT_COLUMN_WIDTH) sheet.setColumnWidth(cols[name], width);
  });
  // 長くなる列は折り返す（「〜10/17(土)（受付終了まで）」のような期間の名前や、確認事項の文が切れないように）
  ['期間', '確認事項'].forEach((name) => sheet.getRange(headerRow, cols[name], sheet.getMaxRows() - headerRow + 1, 1).setWrap(true));
  return { sheet, headerRow, cols };
}

/**
 * 期間の結果を「集計の履歴」に書く。同じ期間の行があれば書き直し、なければ下に足す
 * report が null（集計の前に止まった）なら、回答数などは空のまま。note があれば赤い行にする
 */
function recordHistory_(period, report, sentAt, note) {
  try {
    const { sheet, headerRow, cols } = ensureHistorySheet_();
    // 段階評価の質問ごとの「平均：〇〇」の列と、選択式・複数選択の選択肢ごとの「〇〇：選択肢」の列（なければ右に足す）
    const scales = report ? report.items.filter((i) => i.kind === KIND.SCALE) : [];
    const choices = report ? report.items.filter((i) => i.kind === KIND.CHOICE || i.kind === KIND.CHECKBOX) : [];
    const addColumn = (name) => {
      if (cols[name]) return;
      const col = sheet.getLastColumn() + 1;
      styleHeader_(sheet.getRange(headerRow, col).setValue(name).setWrap(true).setHorizontalAlignment('right'));
      sheet.setColumnWidth(col, AVERAGE_WIDTH);
      cols[name] = col;
    };
    scales.forEach((i) => addColumn(AVERAGE_PREFIX + i.title));
    choices.forEach((i) => i.buckets.forEach((b) => addColumn(i.title + CHOICE_SEPARATOR + b.label)));
    const width = sheet.getLastColumn();
    const last = sheet.getLastRow();
    let row = 0;
    if (last > headerRow) {
      const labels = sheet.getRange(headerRow + 1, cols['期間'], last - headerRow, 1).getValues();
      row = labels.findIndex(([v]) => String(v).trim() === period.label) + 1;
      if (row) row += headerRow;
    }
    if (!row) row = Math.max(last, headerRow) + 1;
    const values = sheet.getRange(row, 1, 1, width).getValues()[0];
    values[cols['期間'] - 1] = `'${period.label}`;
    if (report) {
      values[cols['回答数'] - 1] = report.count;
      scales.forEach((i) => { values[cols[AVERAGE_PREFIX + i.title] - 1] = i.average == null ? '' : i.average; });
      choices.forEach((i) => i.buckets.forEach((b) => { values[cols[i.title + CHOICE_SEPARATOR + b.label] - 1] = b.count; }));
    }
    if (sentAt) values[cols['送った日時'] - 1] = sentAt;
    values[cols['確認事項'] - 1] = note || '';
    sheet.getRange(row, 1, 1, width).setValues([values]).setBackground(note ? ERROR_ROW_COLOR : null);
    sheet.getRange(row, cols['回答数']).setNumberFormat('#,##0');
    sheet.getRange(row, cols['送った日時']).setNumberFormat('yyyy/mm/dd hh:mm');
    scales.forEach((i) => sheet.getRange(row, cols[AVERAGE_PREFIX + i.title]).setNumberFormat('0.0'));
    choices.forEach((i) => i.buckets.forEach((b) => sheet.getRange(row, cols[i.title + CHOICE_SEPARATOR + b.label]).setNumberFormat('#,##0')));
    sortHistory_(sheet, headerRow, cols);
  } catch (e) {
    Logger.log(e.stack || e); // 履歴を書けなくても、メールは送れている
  }
  if (report) refreshCharts_(report); // 集計できなかったとき（report が null）は、グラフはそのまま
}

/**
 * 「集計の履歴」の行を、期間の始まりの古い順に並べ直す（止めていた間の期間をあとから送ったときも、グラフの横軸が時間の順になるように）
 * 期間の始まりは「期間」の文字（2026/10/5(月)〜… や 2026年10月）から読む。読めない行は一番下にする
 */
function sortHistory_(sheet, headerRow, cols) {
  const last = sheet.getLastRow();
  if (last <= headerRow + 1) return;
  const width = sheet.getLastColumn();
  const range = sheet.getRange(headerRow + 1, 1, last - headerRow, width);
  const values = range.getValues();
  const backgrounds = range.getBackgrounds();
  const rows = values.map((v, i) => ({ v, bg: backgrounds[i], key: periodStartOf_(v[cols['期間'] - 1]) }));
  const sorted = rows.slice().sort((a, b) => a.key - b.key);
  if (sorted.every((r, i) => r === rows[i])) return; // もう並んでいる
  range.setValues(sorted.map((r) => r.v.map((x, j) => (j === cols['期間'] - 1 ? `'${x}` : x))));
  range.setBackgrounds(sorted.map((r) => r.bg));
}

/** 「期間」の文字から、始まりの日（比べるための数）を読む。読めなければ一番大きい数 */
function periodStartOf_(label) {
  const text = String(label);
  const day = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (day) return jstMidnight_(Number(day[1]), Number(day[2]), Number(day[3]));
  const month = text.match(/^(\d{4})年(\d{1,2})月/);
  if (month) return jstMidnight_(Number(month[1]), Number(month[2]), 1);
  return Number.MAX_SAFE_INTEGER;
}

// ---- 「推移のグラフ」シート ----

/**
 * 「集計の履歴」の数字から、「推移のグラフ」シートのグラフを作り直す
 * 集計している質問のうち、記述式・そのほか以外を全部グラフにする
 *   段階評価: 平均を1つの折れ線にまとめる（軸は1〜5点など、段階の範囲）
 *   選択式・複数選択: 質問ごとに、選択肢の割合の積み上げ棒（期間ごとに100%）
 *   回答数: 棒
 * 履歴の行や列が増えるたびに、グラフの範囲も合わせる。どの質問を描くかは、今集計している質問（report）で決める
 */
function refreshCharts_(report) {
  try {
    const ss = SpreadsheetApp.getActive();
    const history = ss.getSheetByName(CONFIG.HISTORY_SHEET_NAME);
    const headerRow = history ? findHeaderRow_(history, HISTORY_HEAD[0]) : 0;
    if (!headerRow) return;
    const cols = headerMap_(history, headerRow);
    let sheet = ss.getSheetByName(CONFIG.CHART_SHEET_NAME);
    if (!sheet) {
      const current = ss.getActiveSheet();
      sheet = ss.insertSheet(CONFIG.CHART_SHEET_NAME, history.getIndex());
      current.activate();
    }
    sheet.setHiddenGridlines(true);
    sheet.getRange(1, 1).setValue('アンケート集計の推移').setFontSize(14).setFontWeight('bold');
    sheet.getRange(2, 1).setValue(`「${CONFIG.HISTORY_SHEET_NAME}」の数字から、集計を送るたびに自動で作り直します`).setFontColor(NOTE_COLOR);
    sheet.getCharts().forEach((c) => sheet.removeChart(c));

    const rows = Math.max(history.getLastRow() - headerRow + 1, 2);
    const column = (name) => history.getRange(headerRow, cols[name], rows, 1);
    const scales = report.items.filter((i) => i.kind === KIND.SCALE && cols[AVERAGE_PREFIX + i.title]);
    const averages = scales.map((i) => AVERAGE_PREFIX + i.title);
    const chartRows = 20; // グラフ1つの高さ（行）
    let row = 4;
    if (averages.length) {
      const line = sheet.newChart().setChartType(Charts.ChartType.LINE).addRange(column('期間'));
      averages.forEach((name) => line.addRange(column(name)));
      line.setNumHeaders(1).setPosition(row, 1, 0, 0)
        .setOption('title', '段階評価の平均の推移（期間ごと）')
        .setOption('legend.position', 'bottom')
        .setOption('vAxis.title', '平均（点）')
        .setOption('vAxis.viewWindow.min', Math.min(...scales.map((i) => i.low)))
        .setOption('vAxis.viewWindow.max', Math.max(...scales.map((i) => i.high)));
      sheet.insertChart(line
        .setOption('interpolateNulls', true) // 送れなかった期間（空欄）は、前後の点をつなぐ
        .setOption('pointSize', 5)
        .setOption('width', 760).setOption('height', 360)
        .build());
      row += chartRows;
    }
    report.items.filter((i) => i.kind === KIND.CHOICE || i.kind === KIND.CHECKBOX).forEach((i) => {
      // この質問の選択肢の列（今の選択肢と、前にあった選択肢）。列の順に並べる
      const prefix = i.title + CHOICE_SEPARATOR;
      const names = Object.keys(cols).filter((name) => name.startsWith(prefix)).sort((a, b) => cols[a] - cols[b]);
      if (!names.length) return;
      const bar = sheet.newChart().setChartType(Charts.ChartType.COLUMN).addRange(column('期間'));
      names.forEach((name, k) => {
        bar.addRange(column(name));
        bar.setOption(`series.${k}.labelInLegend`, name.slice(prefix.length)); // 凡例は選択肢の名前だけ（質問の名前はタイトルにある）
      });
      sheet.insertChart(bar.setNumHeaders(1).setPosition(row, 1, 0, 0)
        .setOption('title', `「${i.title}」の割合の推移（期間ごと${i.kind === KIND.CHECKBOX ? '・複数選択' : ''}）`)
        .setOption('isStacked', 'percent') // 期間ごとに100%。回答数が違う期間どうしでも比べられる
        .setOption('legend.position', 'bottom')
        .setOption('vAxis.title', '割合')
        .setOption('width', 760).setOption('height', 360)
        .build());
      row += chartRows;
    });
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(column('期間')).addRange(column('回答数'))
      .setNumHeaders(1).setPosition(row, 1, 0, 0)
      .setOption('title', '回答数の推移（期間ごと）')
      .setOption('legend.position', 'none') // 1つだけなので、凡例の代わりにタイトルで分かる
      .setOption('vAxis.title', '回答数（件）')
      .setOption('vAxis.format', '#,##0')
      .setOption('vAxis.viewWindow.min', 0) // 0から始める（差が大げさに見えないように）
      .setOption('width', 760).setOption('height', 360)
      .build());
  } catch (e) {
    Logger.log(e.stack || e); // グラフを作れなくても、メールは送れている
  }
}

// ---- フォームの回答のシート ----

/**
 * フォームの回答のシートの列幅を、質問の種類に合わせて広げ、長い文が入る列は折り返す（見切れないように）
 * 一度整えた列は、次からは触らない（使う人があとで変えた幅を戻さないように）。新しい質問の列だけ整える
 */
function layoutAnswers_(sheet, questions) {
  try {
    const props = PropertiesService.getScriptProperties();
    let saved = {};
    try {
      saved = JSON.parse(props.getProperty(PROP.LAID_OUT) || '{}');
    } catch (e) {
      saved = {};
    }
    const done = saved.id === sheet.getSheetId() ? saved.titles || [] : [];
    const lastCol = sheet.getLastColumn();
    if (!lastCol) return;
    const titles = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => String(v).trim());
    const kinds = new Map(questions.map((q) => [q.title, q.kind]));
    let changed = false;
    titles.forEach((title, i) => {
      if (!title || done.includes(title)) return;
      const kind = i === 0 ? 'タイムスタンプ' : kinds.get(title);
      sheet.setColumnWidth(i + 1, ANSWER_WIDTHS[kind] || ANSWER_OTHER_WIDTH);
      sheet.getRange(1, i + 1).setWrap(true); // 長い質問の題も読めるように
      if (ANSWER_WRAP_KINDS.includes(kind)) sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setWrap(true);
      done.push(title);
      changed = true;
    });
    if (changed) props.setProperty(PROP.LAID_OUT, JSON.stringify({ id: sheet.getSheetId(), titles: done }));
  } catch (e) {
    Logger.log(e.stack || e); // 見た目を整えられなくても、集計には関係しない
  }
}

/** 送った日時のない赤い行（送れなかった期間）を、「送っていません（理由）」の黄色い行にする。keepLabels の期間は変えない */
function markSkipped_(reason, keepLabels) {
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.HISTORY_SHEET_NAME);
    if (!sheet) return;
    const headerRow = findHeaderRow_(sheet, HISTORY_HEAD[0]);
    const last = sheet.getLastRow();
    if (!headerRow || last <= headerRow) return;
    const cols = headerMap_(sheet, headerRow);
    const rows = sheet.getRange(headerRow + 1, 1, last - headerRow, sheet.getLastColumn()).getValues();
    rows.forEach((r, i) => {
      const note = String(r[cols['確認事項'] - 1]).trim();
      const label = String(r[cols['期間'] - 1]).trim();
      if (!note || note.startsWith(SKIPPED_PREFIX) || r[cols['送った日時'] - 1] !== '' || keepLabels.includes(label)) return;
      const row = headerRow + 1 + i;
      sheet.getRange(row, cols['確認事項']).setValue(`${SKIPPED_PREFIX}（${reason}）`);
      sheet.getRange(row, 1, 1, sheet.getLastColumn()).setBackground(WARN_ROW_COLOR);
    });
  } catch (e) {
    Logger.log(e.stack || e); // 書けなくても、送る動きには関係しない
  }
}
