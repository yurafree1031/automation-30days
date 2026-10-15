// AI.gs の手元テスト（node --test で実行）。GAS の部品（PropertiesService・UrlFetchApp など）は偽物に差し替える
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** AI.gs と Errors.gs を、偽物の GAS 部品と一緒に読み込む */
function load({ props = {}, responses = [] } = {}) {
  const calls = [];
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    Utilities: { base64Encode: () => 'BASE64', sleep: () => {} },
    UrlFetchApp: {
      fetch: (url, opt) => {
        calls.push({ url, opt, body: JSON.parse(opt.payload) });
        const r = responses[Math.min(calls.length - 1, responses.length - 1)];
        return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      },
    },
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..');
  // class・const はファイルの外から見えないので、最後に必要なものを ctx に出す
  const src = ['Errors.gs', 'AI.gs'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    + '\nObject.assign(globalThis, { UserError, RetryLaterError, AdminError, AIUnreadableError, AIUnsupportedFileError, AIBadRequestError, askAI_, chooseAIProvider_ });';
  vm.runInContext(src, ctx);
  return { ctx, calls };
}
const blob = (type = 'image/jpeg') => ({ getContentType: () => type, getBytes: () => [], getName: () => 'r.jpg' });
const schema = { type: 'object', properties: { a: { type: 'string' }, n: { type: 'integer' }, c: { type: 'string', enum: ['x', 'y'] } }, required: ['a', 'n', 'c'] };
const ok = { a: 'hi', n: 1, c: 'x' };
const plain = (o) => JSON.parse(JSON.stringify(o)); // vm の中で作ったオブジェクトを比べられる形にする

test('プロパティの名前でAIを決める。2つ以上あれば AI_PROVIDER で選ぶ', () => {
  const pick = (available, override) => load().ctx.chooseAIProvider_(available, override);
  assert.strictEqual(pick(['gemini']), 'gemini');
  assert.strictEqual(pick(['claude']), 'claude');
  assert.strictEqual(pick(['gemini', 'claude'], 'Claude'), 'claude');
  assert.throws(() => pick([]), (e) => e.code === 'E01' && /GEMINI_API_KEY・CLAUDE_API_KEY・OPENAI_API_KEY/.test(e.detail));
  assert.throws(() => pick(['gemini', 'claude']), (e) => e.code === 'E01' && /AI_PROVIDER/.test(e.detail));
  assert.throws(() => pick(['gemini'], 'foo'), (e) => e.code === 'E01');
  assert.throws(() => pick(['gemini'], 'claude'), (e) => e.code === 'E01' && /CLAUDE_API_KEY/.test(e.detail));
});

test('キーの形は問わない（AQ. で始まる Gemini のキーでも動く）', () => {
  const { ctx, calls } = load({ props: { GEMINI_API_KEY: 'AQ.NEWFORMAT' }, responses: [{ code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(ok) }] } }] } }] });
  ctx.askAI_({ prompt: 'p', schema });
  assert.strictEqual(calls[0].opt.headers['x-goog-api-key'], 'AQ.NEWFORMAT');
});

test('キーがなければ E01', () => {
  const { ctx } = load();
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.AdminError && e.code === 'E01');
});

test('Gemini: リクエストの形と答えの取り出し', () => {
  const { ctx, calls } = load({ props: { GEMINI_API_KEY: 'AIzaK' }, responses: [{ code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(ok) }] } }] } }] });
  assert.deepStrictEqual(plain(ctx.askAI_({ prompt: 'p', file: blob(), schema })), ok);
  const c = calls[0];
  assert.match(c.url, /gemini-3\.8-flash:generateContent$/);
  assert.strictEqual(c.opt.headers['x-goog-api-key'], 'AIzaK');
  const s = c.body.generationConfig.responseSchema;
  assert.strictEqual(s.type, 'OBJECT');
  assert.strictEqual(s.properties.n.type, 'INTEGER');
  assert.deepStrictEqual(s.properties.c.enum, ['x', 'y']);
  assert.deepStrictEqual(s.required, ['a', 'n', 'c']);
  assert.strictEqual(c.body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
});

test('Claude: リクエストの形と答えの取り出し（考えた部分のブロックを飛ばす）。フォールバック対応モデルでは付ける', () => {
  const { ctx, calls } = load({ props: { CLAUDE_API_KEY: 'sk-ant-K', AI_MODEL: 'claude-opus-5-5' }, responses: [{ code: 200, body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(ok) }] } }] });
  assert.deepStrictEqual(plain(ctx.askAI_({ prompt: 'p', file: blob('application/pdf'), schema })), ok);
  const c = calls[0];
  assert.strictEqual(c.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(c.opt.headers['x-api-key'], 'sk-ant-K');
  assert.strictEqual(c.opt.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(c.body.model, 'claude-opus-5-5');
  assert.strictEqual(c.body.fallbacks, 'default');
  assert.strictEqual(c.opt.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(c.body.output_config.format.type, 'json_schema');
  assert.strictEqual(c.body.output_config.format.schema.additionalProperties, false);
  assert.strictEqual(c.body.messages[0].content[0].type, 'document'); // PDF はファイルを先に
  assert.strictEqual(c.body.messages[0].content[1].type, 'text');
});

test('Claude: 初期は一番安い claude-haiku-5-5。フォールバックに対応しないので付けない', () => {
  const { ctx, calls } = load({ props: { CLAUDE_API_KEY: 'sk-ant-K' }, responses: [{ code: 200, body: { content: [{ type: 'text', text: JSON.stringify(ok) }] } }] });
  ctx.askAI_({ prompt: 'p', schema });
  assert.strictEqual(calls[0].body.model, 'claude-haiku-5-5');
  assert.strictEqual(calls[0].body.fallbacks, undefined);
  assert.strictEqual(calls[0].opt.headers['anthropic-beta'], undefined);
});

test('OpenAI: リクエストの形と答えの取り出し', () => {
  const { ctx, calls } = load({ props: { OPENAI_API_KEY: 'sk-proj-K' }, responses: [{ code: 200, body: { choices: [{ message: { content: JSON.stringify(ok), refusal: null } }] } }] });
  assert.deepStrictEqual(plain(ctx.askAI_({ prompt: 'p', file: blob('image/png'), schema })), ok);
  const c = calls[0];
  assert.strictEqual(c.opt.headers.Authorization, 'Bearer sk-proj-K');
  assert.strictEqual(c.body.response_format.json_schema.strict, true);
  assert.strictEqual(c.body.response_format.json_schema.schema.additionalProperties, false);
  assert.strictEqual(c.body.messages[0].content[1].image_url.url, 'data:image/png;base64,BASE64');
});

test('受け付けない形式のファイルは送らずに AIUnsupportedFileError', () => {
  const { ctx, calls } = load({ props: { CLAUDE_API_KEY: 'sk-ant-K' } });
  assert.throws(() => ctx.askAI_({ prompt: 'p', file: blob('image/heic'), schema }), (e) => e instanceof ctx.AIUnsupportedFileError);
  assert.strictEqual(calls.length, 0);
});

test('答えがJSONでない・断られたときは AIUnreadableError', () => {
  let { ctx } = load({ props: { GEMINI_API_KEY: 'AIzaK' }, responses: [{ code: 200, body: { candidates: [] } }] });
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.AIUnreadableError);
  ({ ctx } = load({ props: { CLAUDE_API_KEY: 'sk-ant-K' }, responses: [{ code: 200, body: { stop_reason: 'refusal', content: [] } }] }));
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.AIUnreadableError);
});

test('混雑は3回やり直してから RetryLaterError、途中で直れば成功', () => {
  let { ctx, calls } = load({ props: { CLAUDE_API_KEY: 'sk-ant-K' }, responses: [{ code: 529, body: {} }] });
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.RetryLaterError);
  assert.strictEqual(calls.length, 3);
  ({ ctx, calls } = load({ props: { GEMINI_API_KEY: 'AIzaK' }, responses: [{ code: 503, body: {} }, { code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(ok) }] } }] } }] }));
  assert.deepStrictEqual(plain(ctx.askAI_({ prompt: 'p', schema })), ok);
  assert.strictEqual(calls.length, 2);
});

test('エラーの振り分け（E02・E03・E04・E05）。料金切れ・キー違いはやり直さない', () => {
  const cases = [
    ['AIzaK', 400, { error: { message: 'API key not valid. Please pass a valid API key.' } }, 'E02'],
    ['sk-ant-K', 401, { error: { message: 'invalid x-api-key' } }, 'E02'],
    ['AIzaK', 404, { error: { message: 'models/x is not found' } }, 'E03'],
    ['sk-proj-K', 429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, 'E05'],
    ['sk-ant-K', 400, { error: { message: 'Your credit balance is too low' } }, 'E05'],
  ];
  for (const [key, code, body, want] of cases) {
    const { ctx, calls } = load({ props: { [key.startsWith('AIza') ? 'GEMINI_API_KEY' : key.startsWith('sk-ant') ? 'CLAUDE_API_KEY' : 'OPENAI_API_KEY']: key }, responses: [{ code, body }] });
    assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e.code === want, `${key} ${code} → ${want}`);
    assert.strictEqual(calls.length, 1, `${key} ${code} はやり直さない`);
  }
});

test('400・413・422（内容を受け付けない）は AIBadRequestError。続けて起きたときのために E04 を持つ。やり直さない', () => {
  for (const code of [400, 413, 422]) {
    const { ctx, calls } = load({ props: { CLAUDE_API_KEY: 'sk-ant-K' }, responses: [{ code, body: { error: { message: 'image exceeds 5 MB maximum' } } }] });
    assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.AIBadRequestError && e.adminError instanceof ctx.AdminError && e.adminError.code === 'E04', `${code}`);
    assert.strictEqual(calls.length, 1);
  }
});

test('利用枠の上限: 1日の上限はやり直さず E05。それ以外の quota の429は、3回やり直してから E05（混雑とは案内しない）', () => {
  let { ctx, calls } = load({ props: { GEMINI_API_KEY: 'AIzaK' }, responses: [{ code: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } } }] });
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.AdminError && e.code === 'E05' && e.message === 'AIの利用枠の上限に達しています');
  assert.strictEqual(calls.length, 1);
  ({ ctx, calls } = load({ props: { GEMINI_API_KEY: 'AIzaK' }, responses: [{ code: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } } }] }));
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.AdminError && e.code === 'E05');
  assert.strictEqual(calls.length, 3);
});

test('quota の文字がない回数制限（429）は、これまでどおり RetryLaterError', () => {
  const { ctx } = load({ props: { CLAUDE_API_KEY: 'sk-ant-K' }, responses: [{ code: 429, body: { error: { type: 'rate_limit_error', message: 'rate limited' } } }] });
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema }), (e) => e instanceof ctx.RetryLaterError);
});

test('deadline を過ぎるやり直しはせず、RetryLaterError で返す', () => {
  const { ctx, calls } = load({ props: { GEMINI_API_KEY: 'AIzaK' }, responses: [{ code: 503, body: 'busy' }] });
  assert.throws(() => ctx.askAI_({ prompt: 'p', schema, deadline: Date.now() + 1000 }), (e) => e instanceof ctx.RetryLaterError);
  assert.strictEqual(calls.length, 1);
});
