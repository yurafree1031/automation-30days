// Day 1 の手元テスト用の共通部品。GAS の部品（スプレッドシート・ドライブなど）を、メモリ上の偽物に差し替えて Code.gs などを動かす
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEMO_DIR = path.join(__dirname, '..');
const SOURCES = ['Errors.gs', 'AI.gs', 'Code.gs', 'Chart.gs', 'Button.gs'];
// class・const はファイルの外から見えないので、最後に必要なものを globalThis に出す
const EXPORTS = [
  'UserError', 'RetryLaterError', 'AdminError', 'AIUnreadableError', 'AIUnsupportedFileError', 'AIBadRequestError',
  'CONFIG', 'HEADER', 'ERROR_ROW_COLOR', 'WARN_ROW_COLOR', 'STORE_RULES_HEADER_ROW', 'RUN_BUTTON_PNG_BASE64',
];

// ---- 偽のスプレッドシート ----
const colToNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  each(fn) {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) fn(this.row + r, this.col + c, r, c);
  }
  getValue() { return this.sheet.cells.has(this.key(0, 0)) ? this.sheet.cells.get(this.key(0, 0)) : ''; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      out.push([]);
      for (let c = 0; c < this.numCols; c++) {
        const k = `${this.row + r},${this.col + c}`;
        out[r].push(this.sheet.cells.has(k) ? this.sheet.cells.get(k) : '');
      }
    }
    return out;
  }
  key(r, c) { return `${this.row + r},${this.col + c}`; }
  setValue(v) { this.sheet.cells.set(this.key(0, 0), v); return this; }
  setFormula(v) { return this.setValue(v); }
  setValues(rows) { this.each((_r, _c, i, j) => this.sheet.cells.set(this.key(i, j), rows[i][j])); return this; }
  clearContent() { this.each((r, c) => this.sheet.cells.delete(`${r},${c}`)); return this; }
  setBackground(color) {
    this.each((r, c) => (color == null ? this.sheet.bg.delete(`${r},${c}`) : this.sheet.bg.set(`${r},${c}`, color)));
    return this;
  }
  setRichTextValue(rich) {
    this.sheet.cells.set(this.key(0, 0), rich.text);
    this.sheet.links.set(this.key(0, 0), rich.url);
    return this;
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getSheet() { return this.sheet; }
  getA1Notation() {
    const letters = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
    const a = `${letters(this.col)}${this.row}`;
    return this.numRows * this.numCols === 1 ? a : `${a}:${letters(this.col + this.numCols - 1)}${this.row + this.numRows - 1}`;
  }
}
// 折り返しは、どの列に付けたかをテストで確かめる
FakeRange.prototype.setWrap = function (on) {
  (this.sheet.wraps = this.sheet.wraps || []).push({ row: this.row, col: this.col, numRows: this.numRows, on });
  return this;
};
FakeRange.prototype.setDataValidation = function (rule) {
  this.sheet.validations.push({ row: this.row, col: this.col, numRows: this.numRows, rule });
  return this;
};
// 見た目だけの設定は何もしない（テストでは確かめない）
['setFontWeight', 'setFontSize', 'setFontColor', 'setNumberFormat', 'setBorder', 'setHorizontalAlignment'].forEach((m) => {
  FakeRange.prototype[m] = function () { return this; };
});

class FakeSheet {
  constructor(ss, name) {
    Object.assign(this, { ss, name, cells: new Map(), bg: new Map(), links: new Map(), images: [], charts: [], validations: [] });
  }
  getName() { return this.name; }
  activate() { this.ss.active = this; return this; }
  getLastRow() {
    let max = 0;
    for (const [k, v] of this.cells) if (v !== '' && v != null) max = Math.max(max, Number(k.split(',')[0]));
    return max;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'number') return new FakeRange(this, a, b, c || 1, d || 1);
    const m = String(a).match(/^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);
    const c1 = colToNum(m[1]);
    const r1 = m[2] ? Number(m[2]) : 1;
    const c2 = m[3] ? colToNum(m[3]) : c1;
    const r2 = m[3] ? (m[4] ? Number(m[4]) : 1000) : r1;
    return new FakeRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
  }
  getDataRange() {
    let lastCol = 1;
    for (const k of this.cells.keys()) lastCol = Math.max(lastCol, Number(k.split(',')[1]));
    return new FakeRange(this, 1, 1, Math.max(this.getLastRow(), 1), lastCol);
  }
  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this.cells.set(`${row},${i + 1}`, v));
  }
  getMaxRows() { return 1000; }
  getImages() { return this.images; }
  insertImage(blob, col, row) {
    const image = { blob, col, row, script: null };
    image.setWidth = () => image;
    image.setHeight = () => image;
    image.assignScript = (name) => { image.script = name; return image; };
    this.images.push(image);
    return image;
  }
  getCharts() { return this.charts; }
  removeChart() {}
  setHiddenGridlines() {}
  setColumnWidth(col, width) { (this.columnWidths = this.columnWidths || {})[col] = width; }
  getColumnWidth(col) { return (this.columnWidths || {})[col] || 100; }
  setRowHeight() {}
  setFrozenRows() {}
  /** テスト用: 値の入った行を、見出しも含めて二次元配列で返す */
  rows() {
    const out = [];
    for (let r = 1; r <= this.getLastRow(); r++) out.push(this.getRange(r, 1, 1, 7).getValues()[0]);
    return out;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
    this.toasts = [];
    this.alerts = [];
    this.nextAnswer = 'YES';
    this.menus = [];
    this.active = this.add('シート1');
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
  toast(message, title, seconds) { this.toasts.push({ message, title, seconds }); }
  get lastToast() { return this.toasts[this.toasts.length - 1]; }
}

// ---- 偽のドライブ ----
class FakeFile {
  constructor(folder, { name, mime = 'image/jpeg', size = 1000, moveError = null }) {
    Object.assign(this, { folder, name, mime, size, moveError });
  }
  getName() { return this.name; }
  getMimeType() { return this.mime; }
  getSize() { return this.size; }
  getUrl() { return `https://drive.example/file/${this.name}`; }
  getBlob() { return { getContentType: () => this.mime, getBytes: () => [1, 2, 3], getName: () => this.name }; }
  moveTo(dest) {
    if (this.moveError) throw this.moveError;
    this.folder.files = this.folder.files.filter((f) => f !== this);
    dest.files.push(this);
    this.folder = dest;
    return this;
  }
}
class FakeFolder {
  constructor(id) { this.id = id; this.files = []; }
  getId() { return this.id; }
  getUrl() { return `https://drive.example/folder/${this.id}`; }
  getFiles() {
    const list = [...this.files];
    let i = 0;
    return { hasNext: () => i < list.length, next: () => list[i++] };
  }
  addFile(spec) { const f = new FakeFile(this, spec); this.files.push(f); return f; }
  names() { return this.files.map((f) => f.name); }
}

/**
 * Code.gs などを偽の GAS 部品と一緒に読み込む。
 * 戻り値: { ctx（読み込んだ関数が globalThis に入っている）, ss, drive, props, ai, ... }
 */
function load({ props = { GEMINI_API_KEY: 'TEST' }, realAI = false } = {}) {
  const ss = new FakeSpreadsheet();
  const folders = new Map();
  const env = {
    ss, props: { ...props }, folders, logs: [], sleeps: [], fetchCalls: [], fetchQueue: [], aiCalls: [], prompts: [], deadlines: [], ai: {},
    today: '2026-10-15', lockBusy: false, lockReleased: 0,
  };

  const ui = {
    ButtonSet: { YES_NO: 'YES_NO' },
    Button: { YES: 'YES', NO: 'NO' },
    createMenu(title) {
      const menu = { title, items: [] };
      const chain = { addItem(label, fn) { menu.items.push([label, fn]); return chain; }, addToUi() { ss.menus.push(menu); return chain; } };
      return chain;
    },
    alert(title, message) { ss.alerts.push({ title, message }); return ss.nextAnswer; },
  };

  const ctx = {
    SpreadsheetApp: {
      getActive: () => ss,
      getUi: () => ui,
      newDataValidation() {
        const v = {};
        const b = {
          requireDate: () => { v.kind = 'date'; return b; },
          requireValueInRange: (range) => { v.kind = 'range'; v.range = range; return b; },
          requireNumberGreaterThan: (n) => { v.kind = 'number>'; v.min = n; return b; },
          requireNumberBetween: (lo, hi) => { v.kind = 'between'; v.min = lo; v.max = hi; return b; },
          setAllowInvalid: (x) => { v.allowInvalid = x; return b; },
          setHelpText: (t) => { v.help = t; return b; },
          build: () => v,
        };
        return b;
      },
      newRichTextValue() {
        const v = {};
        const b = { setText: (t) => { v.text = t; return b; }, setLinkUrl: (u) => { v.url = u; return b; }, build: () => v };
        return b;
      },
    },
    DriveApp: {
      getFolderById(id) {
        if (!folders.has(id)) throw new Error(`No item with the given ID could be found: ${id}`);
        return folders.get(id);
      },
    },
    MimeType: { PDF: 'application/pdf' },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    LockService: {
      getScriptLock: () => ({ tryLock: () => !env.lockBusy, releaseLock: () => { env.lockReleased++; } }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in env.props ? env.props[k] : null) }) },
    Utilities: {
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      sleep: (ms) => env.sleeps.push(ms),
      formatDate: (date, _tz, pattern) => {
        const iso = date.toISOString();
        return pattern === 'yyyy-MM-dd' ? iso.slice(0, 10) : `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} 12:00`;
      },
    },
    UrlFetchApp: {
      fetch(url, opt) {
        env.fetchCalls.push({ url, opt, body: JSON.parse(opt.payload) });
        const r = env.fetchQueue.shift();
        if (!r) throw new Error('テストで用意した応答がありません');
        return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      },
    },
    Logger: { log: (m) => env.logs.push(String(m)) },
    Charts: { ChartType: { PIE: 'PIE', COLUMN: 'COLUMN' } },
  };
  vm.createContext(ctx);
  const src = SOURCES.map((f) => fs.readFileSync(path.join(DEMO_DIR, f), 'utf8')).join('\n')
    + `\nObject.assign(globalThis, { ${EXPORTS.join(', ')} });`;
  vm.runInContext(src, ctx);

  // 画像の読み取り（AI）は偽物に差し替える。env.ai[ファイル名] に答えのオブジェクト、または { throws: エラー } を入れておく
  if (!realAI) { // realAI のときは AI.gs の askAI_ をそのまま使う（accuracy.js が、実際のAIで確かめるとき）
    ctx.askAI_ = ({ file, prompt, deadline }) => {
      env.aiCalls.push(file.getName());
      env.prompts.push(prompt);
      env.deadlines.push(deadline);
      const v = env.ai[file.getName()];
      if (v === undefined) throw new Error(`テストで ${file.getName()} の答えを用意していません`);
      if (v && v.throws) throw v.throws;
      return { ...v };
    };
  }
  // グラフシートの作成は、ブラウザでのテストで確かめる。ここでは何もしない
  ctx.ensureChartSheet_ = () => {};
  // 「今日」は固定する（env.today を変えると変わる）
  ctx.todayString_ = () => env.today;

  env.ctx = ctx;
  /** 実行時間を進める。1回 Date.now を呼ぶごとに stepMs ずつ進む */
  env.tickClock = (stepMs) => vm.runInContext(`(() => { let t = 0; Date.now = () => { const v = t; t += ${stepMs}; return v; }; })()`, ctx);
  /** 「設定」シートに2つのフォルダを登録し、空のフォルダを作る。C列以降（勘定科目の候補など）は触らない */
  env.setup = ({ inboxUrl = 'https://drive.google.com/drive/folders/INBOX?usp=sharing', doneUrl = 'https://drive.google.com/drive/folders/DONE' } = {}) => {
    folders.set('INBOX', new FakeFolder('INBOX'));
    folders.set('DONE', new FakeFolder('DONE'));
    const settings = ss.add('設定');
    settings.getRange(1, 1, 3, 2).setValues([['項目', '値'], [ctx.CONFIG.INBOX_LABEL, inboxUrl], [ctx.CONFIG.DONE_LABEL, doneUrl]]);
    return { inbox: folders.get('INBOX'), done: folders.get('DONE'), settings };
  };
  /** 「店別勘定科目」シートを作り、ルールを書き込む（見出しの下から） */
  env.setStoreRules = (rules) => {
    const sheet = ss.getSheetByName('店別勘定科目') || ss.add('店別勘定科目');
    const first = ctx.STORE_RULES_HEADER_ROW + 1;
    rules.forEach(([store, category], i) => sheet.getRange(first + i, 1, 1, 2).setValues([[store, category]]));
    return sheet;
  };
  return env;
}

/** vm の中で作ったオブジェクトを、そのまま比べられる形にする */
const plain = (o) => JSON.parse(JSON.stringify(o));

module.exports = { load, plain, DEMO_DIR };
