// 問い合わせ通知のデモの手元テスト用の共通部品。GAS の部品（スプレッドシート・フォーム・メールなど）を、メモリ上の偽物に差し替えて Code.gs を動かす
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const DEMO_DIR = path.join(__dirname, '..');
const SOURCES = ['Errors.gs', 'Sheet.gs', 'Alert.gs', 'Code.gs'];
// class・const はファイルの外から見えないので、最後に必要なものを globalThis に出す
const EXPORTS = ['UserError', 'AdminError', 'CONFIG', 'PROP', 'STATUSES', 'STATUS_COLORS', 'ERROR_ROW_COLOR', 'WARN_ROW_COLOR', 'INPUT_COLOR',
  'LIST_HEADER_ROW', 'LIST_ALERT_ROW', 'STAFF_HEADER_ROW', 'SENT', 'UNSENT'];

const { FakeSpreadsheet, formatDate, gasContext, newEnv } = require('../../../lib/gas/tests/fake-gas');

// ---- 偽のフォーム ----
const ItemType = {
  TEXT: 'TEXT', PARAGRAPH_TEXT: 'PARAGRAPH_TEXT', MULTIPLE_CHOICE: 'MULTIPLE_CHOICE', CHECKBOX: 'CHECKBOX', LIST: 'LIST',
  FILE_UPLOAD: 'FILE_UPLOAD', SECTION_HEADER: 'SECTION_HEADER', PAGE_BREAK: 'PAGE_BREAK', IMAGE: 'IMAGE', VIDEO: 'VIDEO',
};
class FakeItem {
  constructor(id, title, type, choices = []) { Object.assign(this, { id, title, type, choices }); }
  getId() { return this.id; }
  getTitle() { return this.title; }
  getType() { return this.type; }
  typed() { return { getChoices: () => this.choices.map((c) => ({ getValue: () => c })) }; }
  asMultipleChoiceItem() { return this.typed(); }
  asListItem() { return this.typed(); }
  asCheckboxItem() { return this.typed(); }
}
class FakeForm {
  constructor() {
    this.items = [
      new FakeItem(1, 'お名前', ItemType.TEXT),
      new FakeItem(2, 'メールアドレス', ItemType.TEXT),
      new FakeItem(3, '電話番号', ItemType.TEXT),
      new FakeItem(4, 'お問い合わせの種類', ItemType.MULTIPLE_CHOICE, ['商品について', 'ご予約・ご注文', 'お見積もり', 'その他']),
      new FakeItem(5, 'お問い合わせ内容', ItemType.PARAGRAPH_TEXT),
    ];
    this.responses = [];
    this.collects = false;
    this.nextId = 1;
    this.DateCtor = Date; // load() で、GAS 側（vm の中）の Date に差し替える
  }
  getItems() { return this.items; }
  collectsEmail() { return this.collects; }
  getResponses(after) { return this.responses.filter((r) => !after || r.time >= after.getTime()); }
  /** テスト用：回答を足す。answers は {質問の名前: 答え} */
  submit(answers, time = Date.now(), email = '') {
    const form = this;
    const r = {
      id: `R${this.nextId++}`, time, answers, email,
      getId() { return this.id; },
      getTimestamp() { return new form.DateCtor(this.time); },
      getRespondentEmail() { return this.email; },
    };
    r.getItemResponses = function () {
      return Object.entries(this.answers).map(([title, value]) => {
        const item = form.items.find((i) => i.title === title);
        return { getItem: () => item, getResponse: () => value };
      });
    };
    this.responses.push(r);
    return r;
  }
}

function sampleAnswers(over = {}) {
  return { お名前: '山田 太郎', メールアドレス: 'taro@example.com', 電話番号: '09012345678', お問い合わせの種類: 'お見積もり', お問い合わせ内容: '見積もりをお願いします', ...over };
}

/**
 * Code.gs を偽の GAS 部品と一緒に読み込む
 * 戻り値: { ctx（読み込んだ関数）, ss, form, env（メール・トリガー・プロパティなどの記録） }
 */
function load({ me = 'office@example.com' } = {}) {
  const ss = new FakeSpreadsheet({ firstSheet: 'フォームの回答 1' });
  const form = new FakeForm();
  const env = newEnv(me);
  const ctx = {
    ...gasContext(ss, env),
    FormApp: {
      ItemType,
      openByUrl: (url) => { if (env.formError) throw env.formError; return form; },
    },
    HtmlService: {
      createHtmlOutput: (html) => {
        const out = { html, title: '' };
        out.setTitle = (t) => { out.title = t; return out; };
        out.addMetaTag = () => out;
        return out;
      },
    },
  };
  ctx.Utilities = {
    formatDate,
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()],
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  };
  vm.createContext(ctx);
  const code = SOURCES.map((f) => fs.readFileSync(path.join(DEMO_DIR, f), 'utf8')).join('\n');
  vm.runInContext(`${code}\n${EXPORTS.map((n) => `globalThis.${n} = ${n};`).join('\n')}\nglobalThis.VMDate = Date;`, ctx, { filename: 'form-notify' });
  // Code.gs の「instanceof Date」が効くよう、テストで作る日付は GAS 側の Date で作る
  form.DateCtor = ctx.VMDate;
  return { ctx, ss, form, env };
}

/** 「担当者」シートに管理者と担当者を書き、通知を始めた状態にする（ui の確認は「はい」） */
function setup(t, { people = [['お見積もり', '佐藤', 'sato@example.com'], ['（それ以外）', '事務', 'jimu@example.com']], admin = 'admin@example.com', webappUrl = 'https://script.google.com/macros/s/DEMO/exec' } = {}) {
  t.ctx.onOpen();
  const staff = t.ss.getSheetByName('担当者');
  const adminRow = findLabel(staff, '管理者のメールアドレス');
  staff.set(adminRow, 2, admin);
  staff.set(findLabel(staff, 'ボタンのURL'), 2, webappUrl);
  t.ctx.startNotifications();
  const header = findLabel(staff, '答え');
  // 表を書き直す
  for (let r = header + 1; r <= staff.getLastRow(); r++) for (let c = 1; c <= 4; c++) staff.set(r, c, '');
  people.forEach((p, i) => p.forEach((v, j) => staff.set(header + 1 + i, j + 1, v)));
  return staff;
}

function findLabel(sheet, label) {
  for (let r = 1; r <= Math.min(sheet.getLastRow(), 30); r++) for (let c = 1; c <= 5; c++) if (sheet.get(r, c) === label) return r;
  return 0;
}

module.exports = { load, setup, sampleAnswers, findLabel, ItemType, FakeItem };
