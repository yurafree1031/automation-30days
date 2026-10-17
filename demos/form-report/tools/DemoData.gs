/**
 * デモ用：アンケートのフォームを作ってこのスプレッドシートにつなぎ、過去3週間分の架空の回答を書き込む（開発用。納品物には入れない）
 * フォームから送った回答は「今」の日時にしかならないため、過去の回答は回答のシートに直接書く
 * clasp で送るときだけ、デモのフォルダの直下にコピーする。終わったら消して、もう一度 push する
 */
function createDemoData() {
  const ss = SpreadsheetApp.getActive();
  if (ss.getFormUrl()) throw new Error('すでにフォームがつながっています');

  const form = FormApp.create('ご来店アンケート（デモ）');
  form.setDescription('本日はご来店ありがとうございました。今後のサービス向上のため、アンケートへのご協力をお願いします。');
  form.addScaleItem().setTitle('本日のご満足度').setBounds(1, 5).setLabels('不満', '満足').setRequired(true);
  form.addScaleItem().setTitle('スタッフの対応').setBounds(1, 5).setLabels('悪い', '良い').setRequired(true);
  form.addMultipleChoiceItem().setTitle('ご来店のきっかけ')
    .setChoiceValues(['ホームページ', 'SNS', '知人の紹介', '通りがかり']).showOtherOption(true);
  form.addCheckboxItem().setTitle('よかった点（いくつでも）')
    .setChoiceValues(['料理の味', 'スタッフの対応', '店内の雰囲気', '価格', '提供の早さ']);
  form.addParagraphTextItem().setTitle('ご意見・ご感想');
  form.addTextItem().setTitle('お名前（任意）');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  SpreadsheetApp.flush();

  const sheet = ss.getSheets().find((s) => s.getFormUrl() && s.getFormUrl().indexOf(form.getId()) >= 0);
  if (!sheet) throw new Error('回答のシートが見つかりません。少し待ってから、もう一度実行してください');

  // 毎回同じ回答になるよう、決まった順の乱数を使う
  let seed = 20261017;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const weighted = (pairs) => { let r = rand() * pairs.reduce((a, p) => a + p[1], 0); for (const [v, w] of pairs) { r -= w; if (r < 0) return v; } return pairs[0][0]; };
  const comments = ['また来ます', '料理がおいしかったです', '提供まで少し時間がかかりました', '店員さんが親切でした', '席が少し狭く感じました',
    '季節のメニューが楽しみです', '駐車場がわかりにくかったです', '値段の割に量が多くて満足です', '子ども連れでも過ごしやすかったです'];

  const rows = [];
  const now = Date.now();
  const days = 21;
  for (let d = days; d >= 1; d--) {
    const count = 2 + Math.floor(rand() * 4); // 1日2〜5件
    for (let i = 0; i < count; i++) {
      const time = new Date(now - d * 24 * 60 * 60 * 1000 + Math.floor(rand() * 10) * 60 * 60 * 1000);
      // 新しい週ほど、満足度が少しずつ上がるようにする
      const lift = d < 8 ? 1 : d < 15 ? 0.5 : 0;
      const sat = weighted([[5, 4 + lift * 2], [4, 5], [3, 2], [2, 1 - lift * 0.5], [1, 0.5]]);
      const staff = weighted([[5, 5], [4, 4], [3, 2], [2, 0.5], [1, 0.3]]);
      const trigger = weighted([['ホームページ', 3], ['SNS', 4], ['知人の紹介', 2], ['通りがかり', 2], ['チラシ', 0.5], ['', 0.5]]);
      const good = ['料理の味', 'スタッフの対応', '店内の雰囲気', '価格', '提供の早さ'].filter(() => rand() < 0.45).join(', ');
      const comment = rand() < 0.4 ? pick(comments) : '';
      rows.push([time, sat, staff, trigger, good, comment, '']);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy/mm/dd hh:mm:ss');
  Logger.log(`フォーム: ${form.getEditUrl()}　回答: ${rows.length}件`);
}
