/**
 * エラーの種類（どのデモでも共通）
 * - UserError:       使う人がその場で直せる（設定の貼り忘れ、画像の撮り直しなど）→ 直し方を通知する
 * - RetryLaterError: 時間をおけば直る（AIの混雑・回数制限）→ あとで押し直してもらう
 * - AdminError:      管理者でないと直せない（APIキーなど）→ 「管理者に連絡」と番号・内容を通知する
 * - それ以外:        想定外のエラー（プログラムの不具合など）→ 製作者が直す
 *
 * AdminError の番号は、各デモの README の「管理者向け：エラー番号の一覧」と合わせる
 *   E01〜E05 は AI の部品（AI.gs）で使う。それ以外の番号は、各デモの Code.gs の先頭に書く
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
