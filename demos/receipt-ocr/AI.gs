/**
 * どのAI（Gemini・Claude・OpenAI）でも同じ書き方で呼べる共通部品。Errors.gs と一緒に使う。
 *
 * 使い方:
 *   const result = askAI_({ prompt: '…', file: blob, schema: { type: 'object', properties: {…}, required: [...] } });
 *   - prompt: AIへの指示
 *   - file:   画像やPDF（なくてもよい）
 *   - schema: 返してほしいJSONの形（JSON Schema。type は小文字で書く）
 *   - deadline: やり直しを始めてよい最後の時刻（Date.now() の値。なくてもよい）。GASの6分の上限の前に止めたいときに渡す
 *   戻り値は schema の形のオブジェクト。
 *
 * 設定（スクリプトプロパティ）:
 *   GEMINI_API_KEY / CLAUDE_API_KEY / OPENAI_API_KEY … 使うAIのAPIキー。書いてあるキーのAIを使う
 *     （キーの形はAIの会社が変えることがあるので、キーの中身ではなく、プロパティの名前でAIを決める）
 *   AI_PROVIDER … キーを2つ以上書いたときだけ、使うAIを書く（gemini／claude／openai）
 *   AI_MODEL    … 使うモデルを変えたいときだけ書く（書かなければ AI_DEFAULT_MODELS を使う）
 *
 * 投げるエラー:
 *   AIUnreadableError        … AIが答えを返さなかった、決まった形で返さなかった
 *   AIUnsupportedFileError   … そのAIが受け付けない形式のファイル
 *   AIBadRequestError        … AIが「この内容は受け付けない」と返した（画像が大きすぎる等）。画像1枚ごとの問題のことが多い。
 *                              同じエラーが続くときは設定やプログラムの問題なので、呼び出し側で .adminError（E04）を投げる
 *   RetryLaterError          … 混雑・回数制限で、やり直してもだめだった
 *   AdminError(E01〜E05)     … APIキーやモデル、利用枠の上限など、管理者が直すもの
 */

// AIごとの初期のモデル。業務ツールのタスク（読み取り・分類・要約）をこなせる中で、一番安いものにする
// 精度が足りないデモだけ、スクリプトプロパティ AI_MODEL で上のモデルに変える
const AI_DEFAULT_MODELS = {
  gemini: 'gemini-3.8-flash', // より安い lite 版があれば、精度を確かめてから切り替える
  claude: 'claude-haiku-5-5',
  openai: 'gpt-5-mini', // OpenAI の今のモデル名と単価は料金ページで確認する
};

// AIごとの、APIキーを書くスクリプトプロパティの名前
const AI_KEY_PROPERTIES = {
  gemini: 'GEMINI_API_KEY',
  claude: 'CLAUDE_API_KEY',
  openai: 'OPENAI_API_KEY',
};

// AIごとに受け付けるファイルの形式
const AI_SUPPORTED_TYPES = {
  gemini: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  claude: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
  openai: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
};

// 時間をおけば直る応答（混雑・回数制限・一時的なサーバーエラー）。529 は Claude の「混雑」
const AI_RETRY_CODES = [429, 500, 502, 503, 504, 529];

class AIUnreadableError extends Error {}
class AIUnsupportedFileError extends Error {}
class AIBadRequestError extends Error {
  constructor(message, adminError) {
    super(message);
    this.adminError = adminError; // 続けて起きたときに投げる、管理者向けのエラー（E04）
  }
}

/** APIキーとAIの種類の設定を確かめて、{ key, provider, model } を返す。処理を始める前に呼ぶと、設定の不備を先に知らせられる */
function getAIConfig_() {
  const props = PropertiesService.getScriptProperties();
  const keys = {};
  for (const [p, name] of Object.entries(AI_KEY_PROPERTIES)) {
    const k = (props.getProperty(name) || '').trim();
    if (k) keys[p] = k;
  }
  const provider = chooseAIProvider_(Object.keys(keys), props.getProperty('AI_PROVIDER'));
  const model = (props.getProperty('AI_MODEL') || '').trim() || AI_DEFAULT_MODELS[provider];
  return { key: keys[provider], provider, model };
}

/** AIに質問して、schema の形の答えを受け取る */
function askAI_({ prompt, file, schema, deadline }) {
  const { key, provider, model } = getAIConfig_();

  if (file && !AI_SUPPORTED_TYPES[provider].includes(file.getContentType())) {
    throw new AIUnsupportedFileError(file.getContentType());
  }
  const req = AI_REQUESTS[provider]({ key, model, prompt, file, schema });

  // 時間をおけば直るものは、待ち時間を延ばしながら最大3回やり直す
  // deadline を過ぎてしまうやり直しはせず、混雑（RetryLaterError）として呼び出し側に返す
  let res;
  for (let i = 0; i < 3; i++) {
    res = UrlFetchApp.fetch(req.url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: req.headers, payload: JSON.stringify(req.body) });
    const code = res.getResponseCode();
    if (!AI_RETRY_CODES.includes(code) || isOutOfCredit_(provider, res) || i === 2) break;
    const wait = 5000 * (i + 1);
    if (deadline && Date.now() + wait > deadline) break;
    Utilities.sleep(wait);
  }
  const code = res.getResponseCode();
  if (code === 200) return AI_READERS[provider](JSON.parse(res.getContentText()));
  throw toAIError_(provider, model, res);
}

/**
 * キーが書いてあるAI（available）の中から、使うAIを決める
 * 1つだけならそれを使う。2つ以上なら AI_PROVIDER で選ぶ
 */
function chooseAIProvider_(available, override) {
  const names = Object.values(AI_KEY_PROPERTIES).join('・');
  if (!available.length) throw new AdminError('E01', 'APIキーが設定されていません', `スクリプトプロパティに ${names} のどれかを追加してください`);
  const o = String(override || '').trim().toLowerCase();
  if (o) {
    if (!AI_KEY_PROPERTIES[o]) throw new AdminError('E01', 'AIの種類の設定が正しくありません', `AI_PROVIDER は gemini／claude／openai のどれかにしてください（今の値: ${o}）`);
    if (!available.includes(o)) throw new AdminError('E01', 'APIキーが設定されていません', `AI_PROVIDER が ${o} ですが、スクリプトプロパティに ${AI_KEY_PROPERTIES[o]} がありません`);
    return o;
  }
  if (available.length > 1) {
    throw new AdminError('E01', '使うAIが決められません', `APIキーが2つ以上あります（${available.map((p) => AI_KEY_PROPERTIES[p]).join('・')}）。スクリプトプロパティ AI_PROVIDER に、使うAI（gemini／claude／openai）を書いてください`);
  }
  return available[0];
}

const toBase64_ = (file) => Utilities.base64Encode(file.getBytes());

/** AIごとのリクエストの形 */
const AI_REQUESTS = {
  gemini: ({ key, model, prompt, file, schema }) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'x-goog-api-key': key },
    body: {
      contents: [{ parts: [{ text: prompt }, ...(file ? [{ inlineData: { mimeType: file.getContentType(), data: toBase64_(file) } }] : [])] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema_(schema) },
    },
  }),

  claude: ({ key, model, prompt, file, schema }) => {
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const body = {
      model,
      max_tokens: 16000,
      output_config: { format: { type: 'json_schema', schema: strictSchema_(schema) } },
      messages: [{ role: 'user', content: [...(file ? [claudeFileBlock_(file)] : []), { type: 'text', text: prompt }] }],
    };
    // 安全のためにAIが答えを断ったとき、別のモデルで自動でやり直す（対応しているモデルだけ）
    if (/^claude-(opus-5|fable-5|sonnet-5-5)/.test(model)) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    return { url: 'https://api.anthropic.com/v1/messages', headers, body };
  },

  openai: ({ key, model, prompt, file, schema }) => ({
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...(file ? [openaiFileBlock_(file)] : [])] }],
      response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: strictSchema_(schema) } },
    },
  }),
};

/** AIごとの答えの取り出し方。答えがない・JSONでないときは AIUnreadableError */
const AI_READERS = {
  gemini: (body) => parseAIJson_(() => body.candidates[0].content.parts[0].text),
  claude: (body) => {
    if (body.stop_reason === 'refusal') throw new AIUnreadableError('refusal');
    return parseAIJson_(() => body.content.find((b) => b.type === 'text').text);
  },
  openai: (body) => {
    const msg = body.choices[0].message;
    if (msg.refusal) throw new AIUnreadableError('refusal');
    return parseAIJson_(() => msg.content);
  },
};

function parseAIJson_(getText) {
  try {
    return JSON.parse(getText());
  } catch (e) {
    throw new AIUnreadableError(e.message);
  }
}

function claudeFileBlock_(file) {
  const type = file.getContentType();
  const source = { type: 'base64', media_type: type, data: toBase64_(file) };
  return type === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
}

function openaiFileBlock_(file) {
  const type = file.getContentType();
  const dataUrl = `data:${type};base64,${toBase64_(file)}`;
  return type === 'application/pdf'
    ? { type: 'file', file: { filename: file.getName() || 'file.pdf', file_data: dataUrl } }
    : { type: 'image_url', image_url: { url: dataUrl } };
}

/** Gemini は型の名前を大文字で書く（'string' → 'STRING'）。additionalProperties は使えないので外す */
function toGeminiSchema_(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema_);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toGeminiSchema_(s)]));
    else out[k] = typeof v === 'object' && k !== 'enum' && k !== 'required' ? toGeminiSchema_(v) : v;
  }
  return out;
}

/** Claude・OpenAI は、決まった形を守らせるために、すべての object に additionalProperties: false が必要 */
function strictSchema_(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema_);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, strictSchema_(s)]));
    else out[k] = typeof v === 'object' && k !== 'enum' && k !== 'required' ? strictSchema_(v) : v;
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/** 料金の残高・上限切れ、または1日の利用枠切れか（やり直しても直らないので、すぐに管理者向けのエラーにする） */
function isOutOfCredit_(provider, res) {
  const text = res.getContentText();
  if (provider === 'openai') return /insufficient_quota/.test(text);
  if (provider === 'claude') return /credit balance/i.test(text);
  return res.getResponseCode() === 429 && /PerDay|per day|daily/i.test(text); // Gemini の1日あたりの上限
}

/** 失敗した応答を、エラーの種類に振り分ける */
function toAIError_(provider, model, res) {
  const code = res.getResponseCode();
  const text = res.getContentText();
  let message = text.slice(0, 150);
  try { message = JSON.parse(text).error.message || message; } catch (e) { /* JSONでなければ本文の先頭を使う */ }
  const detail = `${provider} ${model} ${code}: ${message}`;

  const outOfQuota = () => new AdminError('E05', 'AIの利用枠の上限に達しています', detail);
  if (isOutOfCredit_(provider, res)) return outOfQuota();
  // 回数制限（429）のうち、利用枠（quota）の上限に当たったものは、混雑ではなく管理者が直すもの（3回やり直したあと）
  if (code === 429 && /quota|RESOURCE_EXHAUSTED/i.test(text)) return outOfQuota();
  if (AI_RETRY_CODES.includes(code)) return new RetryLaterError(detail);
  if (code === 401 || code === 403 || /api[ _-]?key/i.test(message)) return new AdminError('E02', 'APIキーが正しくありません', detail);
  if (code === 404 || /model/i.test(message) && code === 400) return new AdminError('E03', 'AIのモデルが使えません', detail);
  const e04 = new AdminError('E04', `AIとの通信でエラー（${code}）`, detail);
  // 内容を受け付けないという返事は、その画像・その内容だけの問題のことが多い。呼び出し側が1件ずつ扱えるようにする
  if ([400, 413, 422].includes(code)) return new AIBadRequestError(detail, e04);
  return e04;
}
