/**
 * 「グラフ」シート: 経費表を勘定科目ごとに集計して、グラフにする
 *
 * C2 のプルダウンで集計の単位（月別・四半期別・年度別）、D2 のプルダウンでグラフの種類（棒グラフ・円グラフ）を切り替える。
 * - 棒グラフ: 期間ごとの推移を、勘定科目で積み上げて表示する
 * - 円グラフ: E2 で選んだ期間（空欄ならいちばん新しい期間）の、勘定科目ごとの内訳を表示する
 * 年度と四半期は、「設定」シートの「年度の始まりの月」から数える（4なら、2026年4月〜2027年3月が「2026年度」）。
 *
 * 集計は QUERY 関数で行うので、プルダウンを選び直したり、経費表の行が増えたり手で直したりすると、表は自動で更新される。
 * グラフの種類だけは関数で変えられないので、D2 を変えたときに onEdit から applyChartType_ でグラフを作り替える。
 * 使う人が見る集計表（期間ごと）は「グラフ」シートに、円グラフ用の表などの作業用の表は、非表示の「集計用」シートに置く。
 */

const CHART_SHEET_NAME = 'グラフ';
const CHART_WORK_SHEET_NAME = '集計用'; // 作業用の表を置く、非表示のシート
const CHART_PERIODS = ['月別', '四半期別', '年度別'];
const CHART_TYPES = ['棒グラフ', '円グラフ'];
const CHART_PERIOD_CELL = 'C2'; // 集計の単位を選ぶプルダウン
const CHART_TYPE_CELL = 'D2'; // グラフの種類を選ぶプルダウン
const CHART_PIE_PERIOD_CELL = 'E2'; // 円グラフで見る期間を選ぶプルダウン
const CHART_TABLE_ROW = 26; // 集計表を置く行（グラフの下）
const CHART_TABLE_WIDTH = 14; // 棒グラフ用の集計表に使う列数（B〜O列。期間＋勘定科目13個まで）
// 「集計用」シートの中の場所
const WORK_FISCAL_CELL = 'B1'; // 年度の始まりの月
const WORK_LATEST_CELL = 'B2'; // 円グラフで見る期間（E2 が空欄なら、いちばん新しい期間）
const WORK_TABLE_ROW = 4; // 期間の一覧（A列）と、円グラフ用の表（C〜D列）を置く行

/**
 * 「グラフ」シートと「集計用」シートを用意する。どちらかがなければ、両方を作り直す
 * （集計の式は2つのシートをまたいで使うので、片方だけ残っていると式が壊れたままになる）
 */
function ensureChartSheet_() {
  const ss = SpreadsheetApp.getActive();
  const chartSheet = ss.getSheetByName(CHART_SHEET_NAME);
  const workSheet = ss.getSheetByName(CHART_WORK_SHEET_NAME);
  if (chartSheet && workSheet) return;
  const current = ss.getActiveSheet();
  if (chartSheet) ss.deleteSheet(chartSheet);
  if (workSheet) ss.deleteSheet(workSheet);
  const sheet = ss.insertSheet(CHART_SHEET_NAME, ss.getSheets().length);
  const work = ss.insertSheet(CHART_WORK_SHEET_NAME, ss.getSheets().length);
  work.hideSheet();
  current.activate(); // insertSheet は新しいシートを開いてしまうので、元のシートに戻す

  // 経費表・設定は INDIRECT で参照する。消して作り直されても、式が壊れずにそのまま集計できるように
  const ref = (a1) => `INDIRECT("'${a1.split('!')[0]}'!${a1.split('!')[1]}")`;
  const d = ref(`${CONFIG.SHEET_NAME}!B2:B`); // 日付
  const w = `'${CHART_WORK_SHEET_NAME}'!`;

  // 年度の始まりの月（「設定」シートの項目の行から探す。見つからなければ初期値）
  work.getRange('A1').setValue('年度の始まりの月');
  work.getRange(WORK_FISCAL_CELL).setFormula(`=IFERROR(INDEX(${ref(`${CONFIG.SETTINGS_SHEET_NAME}!B:B`)},`
    + `MATCH("${CONFIG.FISCAL_START_LABEL}",${ref(`${CONFIG.SETTINGS_SHEET_NAME}!A:A`)},0)),${CONFIG.DEFAULT_FISCAL_START})`);
  const s = `${w}$B$1`; // WORK_FISCAL_CELL の絶対参照

  // 切り替え用のプルダウン（入力・選択するセルは薄い青）
  const list = (values) => SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sheet.getRange('B2').setValue('表示').setFontWeight('bold');
  // プルダウンの上に、何を選ぶものかを書く
  sheet.getRange(1, 3, 1, 3).setValues([['集計の単位', 'グラフの種類', '円グラフの期間']]).setFontColor(NOTE_COLOR);
  sheet.getRange(CHART_PERIOD_CELL).setValue(CHART_PERIODS[0]).setDataValidation(list(CHART_PERIODS)).setBackground(INPUT_COLOR);
  sheet.getRange(CHART_TYPE_CELL).setValue(CHART_TYPES[0]).setDataValidation(list(CHART_TYPES)).setBackground(INPUT_COLOR);

  // 日付が入っている行の「期間」の列。C2 に合わせて 2026-10 / 2026年度-Q3 / 2026年度 の形にする
  const sel = `'${CHART_SHEET_NAME}'!$C$2`; // CHART_PERIOD_CELL の絶対参照
  const fy = `(YEAR(${d})-(MONTH(${d})<${s}))`; // 年度（始まりの月より前の月は、前の年度）
  const q = `(INT(MOD(MONTH(${d})-${s},12)/3)+1)`; // 年度の中の四半期
  const period = `IF(${sel}="年度別",${fy}&"年度",IF(${sel}="四半期別",${fy}&"年度-Q"&${q},TEXT(${d},"yyyy-mm")))`;
  const periods = `ARRAYFORMULA(IF(ISNUMBER(${d}),${period},""))`;
  const data = `{${periods},${ref(`${CONFIG.SHEET_NAME}!E2:E`)},${ref(`${CONFIG.SHEET_NAME}!D2:D`)}}`; // 期間・勘定科目・金額

  // 棒グラフ用: 期間ごと×勘定科目ごとの合計（使う人も見る表なので、グラフの下に置く）
  sheet.getRange(CHART_TABLE_ROW - 1, 2).setValue('集計表（期間ごと）').setFontWeight('bold');
  sheet.getRange(CHART_TABLE_ROW, 2).setFormula(`=IFERROR(QUERY(${data},`
    + `"select Col1, sum(Col3) where Col1 <> '' and Col3 is not null group by Col1 pivot Col2 order by Col1 label Col1 '期間'",0),`
    + `"まだデータがありません")`);
  styleHeader_(sheet.getRange(CHART_TABLE_ROW, 2, 1, CHART_TABLE_WIDTH));
  sheet.getRange(CHART_TABLE_ROW + 1, 3, 1000, CHART_TABLE_WIDTH - 1).setNumberFormat('#,##0').setHorizontalAlignment('right');

  // E2 のプルダウンの候補: 期間の一覧（新しい順）
  work.getRange(WORK_TABLE_ROW - 1, 1).setValue('期間の一覧');
  work.getRange(WORK_TABLE_ROW, 1).setFormula(`=IFERROR(SORT(UNIQUE(FILTER(${periods},${periods}<>"")),1,FALSE),"")`);
  const periodList = work.getRange(WORK_TABLE_ROW, 1, 1000, 1);
  sheet.getRange(CHART_PIE_PERIOD_CELL)
    .setNumberFormat('@') // 「2026-10」が日付に変換されないよう、文字として扱う
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(periodList, true).setAllowInvalid(false).build())
    .setBackground(INPUT_COLOR);
  sheet.getRange('F2').setValue('← 円グラフで見る期間（空欄なら最新）').setFontColor(NOTE_COLOR);

  // 円グラフ用: E2 の期間（一覧にないか空欄なら、いちばん新しい期間）の、勘定科目ごとの合計
  const list1 = `${w}$A$${WORK_TABLE_ROW}:$A$${WORK_TABLE_ROW + 999}`;
  work.getRange('A2').setValue('内訳の期間');
  work.getRange(WORK_LATEST_CELL).setFormula(`=IF(AND('${CHART_SHEET_NAME}'!$E$2<>"",COUNTIF(${list1},'${CHART_SHEET_NAME}'!$E$2)>0),`
    + `'${CHART_SHEET_NAME}'!$E$2,${w}$A$${WORK_TABLE_ROW})`);
  const latest = `${w}$B$2`; // WORK_LATEST_CELL の絶対参照
  work.getRange(WORK_TABLE_ROW, 3).setFormula(`=IFERROR(QUERY(${data},`
    + `"select Col2, sum(Col3) where Col1 = '"&${latest}&"' and Col3 is not null group by Col2 order by sum(Col3) desc label Col2 '勘定科目', sum(Col3) '金額'",0),`
    + `"")`);

  applyChartType_(sheet);
}

/** D2 の選択に合わせて、グラフを棒グラフか円グラフで作り直す */
function applyChartType_(sheet) {
  SpreadsheetApp.flush(); // 集計表の計算を終わらせてから、タイトルの期間を読む
  sheet.getCharts().forEach((c) => sheet.removeChart(c));
  const work = SpreadsheetApp.getActive().getSheetByName(CHART_WORK_SHEET_NAME);
  const isPie = sheet.getRange(CHART_TYPE_CELL).getValue() === '円グラフ';
  const builder = sheet.newChart()
    .setNumHeaders(1)
    // 円グラフの表は非表示のシートにあるので、非表示のデータもグラフに出す
    .setHiddenDimensionStrategy(Charts.ChartHiddenDimensionStrategy.SHOW_BOTH)
    // 凡例は下に置く。右に置くと、画面が狭いときに凡例が画面の外に出て切れる
    .setOption('legend', { position: 'bottom' })
    .setOption('width', 760)
    .setOption('height', 420)
    .setPosition(4, 2, 0, 0);
  if (isPie) {
    builder.setChartType(Charts.ChartType.PIE)
      .addRange(work.getRange(WORK_TABLE_ROW, 3, 1000, 2))
      .setOption('title', `経費の内訳（${work.getRange(WORK_LATEST_CELL).getDisplayValue()}）`)
      .setOption('pieSliceText', 'percentage');
  } else {
    builder.setChartType(Charts.ChartType.COLUMN)
      .addRange(sheet.getRange(CHART_TABLE_ROW, 2, 1000, CHART_TABLE_WIDTH))
      .setOption('title', '経費の推移（勘定科目ごと）')
      .setOption('isStacked', true)
      .setOption('vAxis', { format: '#,##0' });
  }
  sheet.insertChart(builder.build());
}

/** 集計の単位（C2）を変えたら、円グラフの期間（E2）を空欄＝最新に戻す。前の単位の期間（2026-10 など）が残らないように */
function resetPiePeriod_(sheet) {
  sheet.getRange(CHART_PIE_PERIOD_CELL).clearContent();
  if (sheet.getRange(CHART_TYPE_CELL).getValue() === '円グラフ') applyChartType_(sheet); // 円グラフのタイトルの期間を更新する
}
