// アンケート集計のデモの手元テスト用の共通部品。GAS の部品を、メモリ上の偽物に差し替えて Code.gs を動かす
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeSpreadsheet, gasContext, newEnv } = require('../../../lib/gas/tests/fake-gas');

const DEMO_DIR = path.join(__dirname, '..');
const SOURCES = ['Errors.gs', 'Sheet.gs', 'Alert.gs', 'Code.gs'];
// class・const はファイルの外から見えないので、最後に必要なものを globalThis に出す
const EXPORTS = ['UserError', 'AdminError', 'CONFIG', 'PROP', 'KIND', 'ERROR_ROW_COLOR', 'WARN_ROW_COLOR', 'INPUT_COLOR', 'HISTORY_HEADER_ROW', 'HISTORY_ALERT_ROW'];

const DAY = 24 * 60 * 60 * 1000;
/** 日本時間の日時（ミリ秒）。jst(2026, 10, 19, 9) は 2026/10/19 9:00 */
const jst = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 9, min);

// ---- 偽のフォーム ----
const ItemType = {
  TEXT: 'TEXT', PARAGRAPH_TEXT: 'PARAGRAPH_TEXT', MULTIPLE_CHOICE: 'MULTIPLE_CHOICE', CHECKBOX: 'CHECKBOX', LIST: 'LIST',
  SCALE: 'SCALE', RATING: 'RATING', DATE: 'DATE', GRID: 'GRID',
  SECTION_HEADER: 'SECTION_HEADER', PAGE_BREAK: 'PAGE_BREAK', IMAGE: 'IMAGE', VIDEO: 'VIDEO',
};
class FakeItem {
  constructor(title, type, opts = {}) { Object.assign(this, { title, type, choices: opts.choices || [], low: opts.low || 1, high: opts.high || 5 }); }
  getTitle() { return this.title; }
  getType() { return this.type; }
  choiceItem() { return { getChoices: () => this.choices.map((c) => ({ getValue: () => c })) }; }
  asMultipleChoiceItem() { return this.choiceItem(); }
  asListItem() { return this.choiceItem(); }
  asCheckboxItem() { return this.choiceItem(); }
  asScaleItem() { return { getLowerBound: () => this.low, getUpperBound: () => this.high }; }
  asRatingItem() { return { getRatingScaleLevel: () => this.high }; }
}

/** デモと同じ質問（tools/DemoData.gs と同じ） */
function demoItems() {
  return [
    new FakeItem('本日のご満足度', ItemType.SCALE),
    new FakeItem('スタッフの対応', ItemType.SCALE),
    new FakeItem('ご来店のきっかけ', ItemType.MULTIPLE_CHOICE, { choices: ['ホームページ', 'SNS', '知人の紹介', '通りがかり'] }),
    new FakeItem('よかった点（いくつでも）', ItemType.CHECKBOX, { choices: ['料理の味', 'スタッフの対応', '店内の雰囲気', '価格', '提供の早さ'] }),
    new FakeItem('ご意見・ご感想', ItemType.PARAGRAPH_TEXT),
    new FakeItem('お名前（任意）', ItemType.TEXT),
  ];
}

const FORM_URL = 'https://docs.google.com/forms/d/FORM1/edit';

/**
 * Code.gs を偽の GAS 部品と一緒に読み込む。今の時刻は env.now（初めは 2026/10/17(土) 12:00）
 * 戻り値: { ctx, ss, form, env, answers（回答のシート）, clock(ms)（今の時刻を変える）, respond(time, row)（回答を足す） }
 */
function load({ me = 'office@example.com', now = jst(2026, 10, 17, 12) } = {}) {
  const ss = new FakeSpreadsheet({ firstSheet: 'フォームの回答 1', formUrl: FORM_URL });
  const answers = ss.getSheetByName('フォームの回答 1');
  answers.formUrl = 'https://docs.google.com/forms/d/FORM1/viewform';
  const form = { items: demoItems(), getItems() { return this.items; }, getId: () => 'FORM1', isAcceptingResponses: () => !env.formClosed };
  const env = newEnv(me);
  env.now = now;
  const ctx = {
    ...gasContext(ss, env),
    FormApp: {
      ItemType,
      openByUrl: () => { if (env.formError) throw env.formError; return form; },
    },
  };
  vm.createContext(ctx);
  const code = SOURCES.map((f) => fs.readFileSync(path.join(DEMO_DIR, f), 'utf8')).join('\n');
  vm.runInContext(`${code}\n${EXPORTS.map((n) => `globalThis.${n} = ${n};`).join('\n')}\nglobalThis.VMDate = Date;`, ctx, { filename: 'form-report' });
  // 今の時刻を env.now にする（Date.now と new Date()）
  vm.runInContext(`(() => {
    const R = Date;
    globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(globalThis.__now()); else super(...a); } static now() { return globalThis.__now(); } };
  })()`, ctx);
  ctx.__now = () => env.now;
  answers.getRange(1, 1, 1, 7).setValues([['タイムスタンプ', ...form.items.map((i) => i.title)]]);
  const t = {
    ctx, ss, form, env, answers,
    clock(ms) { env.now = ms; },
    /** 回答を1行足す。row は [満足度, スタッフ, きっかけ, よかった点, ご意見, お名前] */
    respond(time, row) { answers.getRange(answers.getLastRow() + 1, 1, 1, 7).setValues([[new ctx.Date(time), ...row]]); },
    sheet(name) { return ss.getSheetByName(name); },
  };
  return t;
}

/** 「設定」シートの項目の行に値を書く */
function setSetting(t, label, value) {
  const sheet = t.sheet('設定');
  const row = findLabel(sheet, label);
  if (!row) throw new Error(`設定の行がありません: ${label}`);
  sheet.set(row, 2, value);
}

/** 設定を書いて、送信を始めた状態にする（確認は「はい」） */
function start(t, { to = 'owner@example.com', admin = 'admin@example.com' } = {}) {
  t.ctx.onOpen();
  setSetting(t, '送り先', to);
  setSetting(t, '管理者のメールアドレス', admin);
  t.ctx.startReports();
}

function findLabel(sheet, label) {
  for (let r = 1; r <= Math.min(sheet.getLastRow(), 40); r++) for (let c = 1; c <= 5; c++) if (sheet.get(r, c) === label) return r;
  return 0;
}

/** 「集計の履歴」のデータの行（見出しの名前 → 値）。背景の色も bg に入れる */
function historyRows(t) {
  const sheet = t.sheet('集計の履歴');
  const header = findLabel(sheet, '期間');
  const out = [];
  for (let r = header + 1; r <= sheet.getLastRow(); r++) out.push({ ...sheet.rowObj(r, header), bg: sheet.bgOf(r, 1), row: r });
  return out;
}

module.exports = { load, start, setSetting, findLabel, historyRows, jst, DAY, ItemType, FakeItem };
