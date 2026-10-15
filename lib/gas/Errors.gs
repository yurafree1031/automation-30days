/**
 * エラーの種類（どのデモでも共通）
 * - UserError:       使う人がその場で直せる（設定の貼り忘れ、画像の撮り直しなど）→ 直し方を通知する
 * - RetryLaterError: 時間をおけば直る（AIの混雑・回数制限）→ あとで押し直してもらう
 * - AdminError:      管理者でないと直せない（APIキーなど）→ 「管理者に連絡」と番号・内容を通知する
 * - それ以外:        想定外のエラー（プログラムの不具合など）→ 製作者が直す
 *
 * AdminError の番号（README の「管理者向け：エラー番号の一覧」と合わせる）
 *   E01 APIキーが設定されていない
 *   E02 APIキーが正しくない
 *   E03 AIのモデルが使えない
 *   E04 AIとの通信でそのほかのエラー
 *   E05 AIの利用枠（料金の残高・上限、無料枠の上限）に達している
 *   E06 処理済み／未処理フォルダの画像を移せない（編集権限がない、など）。Day 1 の Code.gs が投げる
 */
class UserError extends Error {}
class RetryLaterError extends Error {}
class AdminError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || '';
  }
}
