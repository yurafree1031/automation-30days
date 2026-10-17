// 問い合わせ通知のデモの手元テスト用の共通部品。GAS の部品（スプレッドシート・フォーム・メールなど）を、メモリ上の偽物に差し替えて Code.gs を動かす
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const DEMO_DIR = path.join(__dirname, '..');
const SOURCES = ['Errors.gs', 'Code.gs'];
// class・const はファイルの外から見えないので、最後に必要なものを globalThis に出す
const EXPORTS = ['UserError', 'AdminError', 'CONFIG', 'PROP', 'STATUSES', 'STATUS_COLORS', 'ERROR_ROW_COLOR', 'WARN_ROW_COLOR', 'INPUT_COLOR',
  'LIST_HEADER_ROW', 'LIST_ALERT_ROW', 'STAFF_HEADER_ROW', 'SENT', 'UNSENT'];

const colToNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

// ---- 偽のスプレッドシート ----
class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1) throw new Error(`範囲がシートの外です: ${row},${col}`);
    if (row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  each(fn) { for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) fn(this.row + r, this.col + c, r, c); }
  getValue() { return this.sheet.get(this.row, this.col); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) { out.push([]); for (let c = 0; c < this.numCols; c++) out[r].push(this.sheet.get(this.row + r, this.col + c)); }
    return out;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  setValues(rows) {
    if (rows.length !== this.numRows || rows.some((r) => r.length !== this.numCols)) throw new Error('setValues の大きさが範囲と違います');
    this.each((r, c, i, j) => this.sheet.set(r, c, rows[i][j]));
    return this;
  }
  clearContent() { this.each((r, c) => this.sheet.cells.delete(`${r},${c}`)); return this; }
  setBackground(color) {
    this.each((r, c) => (color == null ? this.sheet.bg.delete(`${r},${c}`) : this.sheet.bg.set(`${r},${c}`, color)));
    return this;
  }
  setBackgrounds(rows) { this.each((r, c, i, j) => (rows[i][j] == null ? this.sheet.bg.delete(`${r},${c}`) : this.sheet.bg.set(`${r},${c}`, rows[i][j]))); return this; }
  setDataValidation(rule) { this.sheet.validations.push({ row: this.row, col: this.col, numRows: this.numRows, rule }); return this; }
  clearDataValidations() { this.sheet.validations = this.sheet.validations.filter((v) => !(v.col === this.col && v.row === this.row)); return this; }
  setWrap() { return this; }
  clearFormat() { this.setBackground(null); (this.sheet.cleared = this.sheet.cleared || []).push(this.row); return this; }
  setFontWeight() { return this; }
  setFontColor() { return this; }
  setFontSize() { return this; }
  setNumberFormat() { return this; }
  setBorder() { return this; }
  setHorizontalAlignment(a) { this.sheet.aligns.push({ row: this.row, col: this.col, numRows: this.numRows, a }); return this; }
  protect() {
    const p = { description: '', warningOnly: false, range: this };
    p.setDescription = (d) => { p.description = d; return p; };
    p.setWarningOnly = (w) => { p.warningOnly = w; return p; };
    p.getDescription = () => p.description;
    this.sheet.protections.push(p);
    return p;
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getSheet() { return this.sheet; }
}

class FakeSheet {
  constructor(ss, name) {
    Object.assign(this, { ss, name, cells: new Map(), bg: new Map(), validations: [], protections: [], aligns: [], rules: [], hidden: [], widths: {} });
    this.maxRows = 1000;
    this.maxCols = 26;
    this.id = ss.nextId++;
  }
  get(r, c) { const k = `${r},${c}`; return this.cells.has(k) ? this.cells.get(k) : ''; }
  set(r, c, v) {
    // 本物と同じく、先頭の ' は「文字として入れる」印で、値には残らない
    if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1);
    if (v === '' || v == null) this.cells.delete(`${r},${c}`); else this.cells.set(`${r},${c}`, v);
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getIndex() { return this.ss.sheets.indexOf(this) + 1; }
  activate() { this.ss.active = this; return this; }
  getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[0])); return m; }
  getLastColumn() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[1])); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getRange(a, b, c, d) {
    if (typeof a === 'number') return new FakeRange(this, a, b, c || 1, d || 1);
    const m = String(a).match(/^([A-Z]+)(\d+)$/);
    return new FakeRange(this, Number(m[2]), colToNum(m[1]));
  }
  getDataRange() { return new FakeRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  // 行・列を足すと、それより下（右）の値と色がずれる
  shift(map, axis, at, n) {
    const out = new Map();
    for (const [k, v] of map) {
      const [r, c] = k.split(',').map(Number);
      const nr = axis === 'row' && r >= at ? r + n : r;
      const nc = axis === 'col' && c >= at ? c + n : c;
      out.set(`${nr},${nc}`, v);
    }
    return out;
  }
  insertRowsBefore(row, n) { this.cells = this.shift(this.cells, 'row', row, n); this.bg = this.shift(this.bg, 'row', row, n); this.maxRows += n; }
  insertRowBefore(row) { this.insertRowsBefore(row, 1); }
  insertRowsAfter(row, n) { this.insertRowsBefore(row + 1, n); }
  deleteRow(row) {
    const out = new Map();
    for (const [k, v] of this.cells) {
      const [r, c] = k.split(',').map(Number);
      if (r === row) continue;
      out.set(`${r > row ? r - 1 : r},${c}`, v);
    }
    this.cells = out;
    this.maxRows--;
  }
  insertColumnBefore(col) { this.cells = this.shift(this.cells, 'col', col, 1); this.bg = this.shift(this.bg, 'col', col, 1); this.maxCols++; }
  insertColumnAfter(col) { this.insertColumnBefore(col + 1); }
  hideColumns(col) { if (!this.hidden.includes(col)) this.hidden.push(col); }
  setFrozenRows(n) { this.frozen = n; }
  setColumnWidth(col, w) { this.widths[col] = w; }
  getColumnWidth(col) { return this.widths[col] || 100; }
  setHiddenGridlines() {}
  getConditionalFormatRules() { return this.rules; }
  setConditionalFormatRules(rules) { this.rules = rules; }
  getProtections() { return this.protections; }
  // ---- テスト用 ----
  header(row) { const out = []; for (let c = 1; c <= this.getLastColumn(); c++) out.push(this.get(row, c)); return out; }
  col(name, headerRow) { return this.header(headerRow).indexOf(name) + 1; }
  rowObj(row, headerRow) { const h = this.header(headerRow); const o = {}; h.forEach((n, i) => { if (n) o[n] = this.get(row, i + 1); }); return o; }
  bgOf(row, col) { return this.bg.get(`${row},${col}`) || null; }
}

class FakeSpreadsheet {
  constructor() {
    this.nextId = 100;
    this.sheets = [];
    this.toasts = [];
    this.alerts = [];
    this.answers = [];
    this.menus = [];
    this.formUrl = 'https://docs.google.com/forms/d/FORM/edit';
    this.tz = 'Asia/Tokyo';
    this.active = this.add('フォームの回答 1');
  }
  add(name) { const s = new FakeSheet(this, name); this.sheets.push(s); return s; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  getSheets() { return this.sheets; }
  getActiveSheet() { return this.active; }
  insertSheet(name, index) {
    const s = new FakeSheet(this, name);
    this.sheets.splice(index == null ? this.sheets.length : index, 0, s);
    this.active = s; // 本物と同じく、作ったシートが開かれる
    return s;
  }
  getFormUrl() { return this.formUrl; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/SS/edit'; }
  getSpreadsheetTimeZone() { return this.tz; }
  toast(message, title, seconds) { this.toasts.push({ message, title, seconds }); }
  get lastToast() { return this.toasts[this.toasts.length - 1]; }
}

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

// ---- ほかの GAS の部品 ----
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function formatDate(date, tz, fmt) {
  // テストでは日本時間（UTC+9）だけを扱う
  const d = new Date(date.getTime() + 9 * 3600 * 1000);
  return fmt.replace('yyyy', d.getUTCFullYear()).replace('MM', pad(d.getUTCMonth() + 1)).replace('dd', pad(d.getUTCDate()))
    .replace('HH', pad(d.getUTCHours())).replace('mm', pad(d.getUTCMinutes()))
    .replace(/\bM\b/, d.getUTCMonth() + 1).replace(/\bd\b/, d.getUTCDate());
}

function validationBuilder() {
  const rule = {};
  const b = {
    requireValueInList(list, show) { rule.list = list; rule.show = show; return b; },
    requireTextIsEmail() { rule.email = true; return b; },
    requireNumberBetween(a, z) { rule.between = [a, z]; return b; },
    setAllowInvalid(v) { rule.allowInvalid = v; return b; },
    setHelpText(t) { rule.help = t; return b; },
    build() { return rule; },
  };
  return b;
}
function conditionalBuilder() {
  const rule = {};
  const b = {
    whenTextEqualTo(t) { rule.text = t; return b; },
    setBackground(c) { rule.bg = c; return b; },
    setRanges(r) { rule.ranges = r; return b; },
    build() {
      return { ...rule, getBooleanCondition: () => ({ getCriteriaType: () => 'TEXT_EQUAL_TO', getCriteriaValues: () => [rule.text] }) };
    },
  };
  return b;
}

/**
 * Code.gs を偽の GAS 部品と一緒に読み込む
 * 戻り値: { ctx（読み込んだ関数）, ss, form, env（メール・トリガー・プロパティなどの記録） }
 */
function load({ me = 'office@example.com' } = {}) {
  const ss = new FakeSpreadsheet();
  const form = new FakeForm();
  const env = {
    me, props: {}, mails: [], triggers: [], logs: [], quota: 100, mailError: null,
    scriptLockBusy: false, docLockBusy: false, uiAnswers: [], alerts: [],
  };
  const ui = {
    ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' },
    Button: { YES: 'YES', NO: 'NO' },
    createMenu(title) {
      const menu = { title, items: [] };
      const chain = {
        addItem(label, fn) { menu.items.push([label, fn]); return chain; },
        addSeparator() { menu.items.push(['---']); return chain; },
        addToUi() { ss.menus.push(menu); return chain; },
      };
      return chain;
    },
    alert(title, message) { env.alerts.push({ title, message }); return env.uiAnswers.length ? env.uiAnswers.shift() : 'YES'; },
  };
  const lock = (key) => ({ tryLock: () => !env[key], waitLock: () => { if (env[key]) throw new Error('Lock timeout'); }, releaseLock() {} });
  const triggerBuilder = (handler) => {
    const t = { handler, kind: null };
    const b = {
      forSpreadsheet() { t.kind = 'formSubmit'; return b; },
      onFormSubmit() { return b; },
      timeBased() { t.kind = 'time'; return b; },
      everyDays(n) { t.every = n; return b; },
      onWeekDay(d) { t.weekDay = d; return b; },
      atHour(h) { t.hour = h; return b; },
      inTimezone() { return b; },
      after(ms) { t.after = ms; return b; },
      create() { t.owner = env.me; t.getHandlerFunction = () => handler; env.triggers.push(t); return t; },
    };
    return b;
  };
  const ctx = {
    console,
    Logger: { log: (m) => env.logs.push(String(m)) },
    SpreadsheetApp: {
      getActive: () => ss,
      getUi: () => ui,
      newDataValidation: validationBuilder,
      newConditionalFormatRule: conditionalBuilder,
      BooleanCriteria: { TEXT_EQUAL_TO: 'TEXT_EQUAL_TO' },
      ProtectionType: { RANGE: 'RANGE' },
    },
    FormApp: {
      ItemType,
      openByUrl: (url) => { if (env.formError) throw env.formError; return form; },
    },
    MailApp: {
      getRemainingDailyQuota: () => env.quota,
      sendEmail: (m) => {
        if (env.mailError) throw env.mailError;
        env.quota -= String(m.to).split(',').length;
        env.mails.push(m);
      },
    },
    LockService: { getScriptLock: () => lock('scriptLockBusy'), getDocumentLock: () => lock('docLockBusy') },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in env.props ? env.props[k] : null),
        setProperty: (k, v) => { env.props[k] = String(v); },
        setProperties: (o) => { Object.entries(o).forEach(([k, v]) => { env.props[k] = String(v); }); },
        deleteProperty: (k) => { delete env.props[k]; },
      }),
    },
    ScriptApp: {
      // 本物と同じく、見えるのは今のアカウントのトリガーだけ
      getProjectTriggers: () => env.triggers.filter((t) => t.owner === env.me),
      newTrigger: triggerBuilder,
      deleteTrigger: (t) => { env.triggers = env.triggers.filter((x) => x !== t); },
      WeekDay: { SUNDAY: 'SUNDAY', MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY' },
    },
    HtmlService: {
      createHtmlOutput: (html) => {
        const out = { html, title: '' };
        out.setTitle = (t) => { out.title = t; return out; };
        out.addMetaTag = () => out;
        return out;
      },
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => env.me }) },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    },
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
