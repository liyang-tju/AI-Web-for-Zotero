const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');
function scope(globals = {}) { const c = vm.createContext(globals); vm.runInContext(source, c); return c; }
function dataFixture() {
  const msg = (role, parts, extra = {}) => ({ author: { role }, recipient: 'all', content: { content_type: 'text', parts }, ...extra });
  return { conversation_id: 'test', title: '原始讨论', current_node: 'a2', mapping: {
    root: { parent: null, message: msg('system', ['PRIVATE SYSTEM']) },
    u1: { parent: 'root', message: msg('user', [], { metadata: { attachments: [{ name: 'paper.pdf' }] } }) },
    a1: { parent: 'u1', message: msg('assistant', ['```python\nprint(1)\n```\n\n$$E=mc^2$$']) },
    u2: { parent: 'a1', message: msg('user', ['继续']) },
    thought: { parent: 'u2', message: msg('assistant', ['PRIVATE REASONING'], { channel: 'analysis' }) },
    a2: { parent: 'thought', message: msg('assistant', ['当前答案'], { channel: 'final' }) },
    sibling: { parent: 'u2', message: msg('assistant', ['OTHER BRANCH']) },
  } };
}

test('structured export follows the active branch, preserves Markdown and omits hidden messages', () => {
  const c = scope();
  const snapshot = c.conversationDataSnapshot(dataFixture(), 'https://chatgpt.com/c/test');
  assert.equal(snapshot.messages.length, 4);
  assert.equal(snapshot.scope, 'conversation-branch');
  assert.match(snapshot.messages[0].markdown, /paper.pdf/);
  assert.equal(snapshot.messages[1].markdown, '```python\nprint(1)\n```\n\n$$E=mc^2$$');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|OTHER BRANCH/);
  const md = c.conversationMarkdown({ title: '文献' }, snapshot, '讨论');
  assert.doesNotMatch(md, /提取范围|本文件按会话|附件仅记录/);
  assert.doesNotMatch(md, /仅当前网页已加载/);
});

test('missing nodes, cycles, missing active branch and wrong conversation are rejected', () => {
  const c = scope();
  const missing = dataFixture(); delete missing.mapping.u1;
  assert.throws(() => c.conversationDataSnapshot(missing, 'https://chatgpt.com/c/test'), /缺少/);
  const cycle = dataFixture(); cycle.mapping.root.parent = 'a2';
  assert.throws(() => c.conversationDataSnapshot(cycle, 'https://chatgpt.com/c/test'), /结构异常/);
  const branch = dataFixture(); delete branch.current_node;
  assert.throws(() => c.conversationDataSnapshot(branch, 'https://chatgpt.com/c/test'), /不完整/);
  assert.throws(() => c.conversationDataSnapshot(dataFixture(), 'https://chatgpt.com/c/other'), /不匹配/);
});

test('widget Markdown fallback and source links are retained without exporting internal context', () => {
  const c = scope();
  const data = dataFixture();
  const message = data.mapping.a2.message;
  message.content.parts = ['RAW WIDGET'];
  message.metadata = { model_dil_v2: { fallbackMarkdown: '**结论** SOURCE' }, content_references: [{ matched_text: 'SOURCE', items: [{ title: '论文', url: 'https://example.org/paper' }] }] };
  const snapshot = c.conversationDataSnapshot(data, 'https://chatgpt.com/c/test');
  assert.match(snapshot.messages.at(-1).markdown, /\*\*结论\*\* \[论文\]\(<https:\/\/example.org\/paper>\)/);
  assert.doesNotMatch(JSON.stringify(snapshot), /RAW WIDGET/);
});

function frameFixture(mode = 'success') {
  const messages = [], calls = [], listeners = new Map(), events = new Map(), timers = new Map();
  const doc = { title: 'Chat', location: { href: 'https://chatgpt.com/c/test', origin: 'https://chatgpt.com' }, querySelectorAll: () => [] };
  let controller;
  const page = { document: doc, AbortController: class { constructor() { this.signal = {}; controller = this; } abort() { this.aborted = true; } },
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id),
    addEventListener: (event, fn) => events.set(event, fn), removeEventListener: event => events.delete(event),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/session')) return { ok: true, json: async () => ({ accessToken: 'fixture-token', user: { email: 'not-exported@example.org' } }) };
      if (mode === 'navigation') doc.location.href = 'https://chatgpt.com/c/another';
      if (mode === 'failure') return { ok: false };
      return { ok: true, json: async () => dataFixture() };
    } };
  const c = scope({ content: page, addMessageListener: (id, fn) => listeners.set(id, fn), removeMessageListener: id => listeners.delete(id), sendAsyncMessage: (id, value) => messages.push(value) });
  let fallbackCalls = 0;
  const collect = () => { fallbackCalls++; return { url: doc.location.href, messages: [{ role: 'user', markdown: '已加载' }], scope: 'loaded-page' }; };
  return { c, doc, page, messages, calls, listeners, timers, events, collect, fallbackCalls: () => fallbackCalls, controller: () => controller };
}

test('only current conversation is fetched; credentials stay in same-origin requests, never in export', async () => {
  const f = frameFixture();
  await f.c.extractConversationInFrame('test', f.collect, f.c.conversationDataSnapshot);
  assert.deepEqual(f.calls.map(call => call.url), ['https://chatgpt.com/api/auth/session', 'https://chatgpt.com/backend-api/conversation/test']);
  assert.ok(f.calls.every(call => call.options.method === 'GET' && call.options.redirect === 'error' && call.options.credentials === 'include'));
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(f.fallbackCalls(), 0);
  assert.equal(f.messages[0].scope, 'conversation-branch');
  assert.doesNotMatch(JSON.stringify(f.messages), /fixture-token|not-exported|PRIVATE/);
  assert.equal(f.listeners.size + f.timers.size + f.events.size, 0);
});

test('API failure uses explicitly labeled loaded-page fallback', async () => {
  const f = frameFixture('failure');
  await f.c.extractConversationInFrame('test', f.collect, f.c.conversationDataSnapshot);
  assert.equal(f.messages[0].scope, 'loaded-page');
  assert.match(f.messages[0].sourceNotice, /仅提取当前网页已加载/);
  assert.equal(f.fallbackCalls(), 1);
});

test('navigation during retrieval never exports a different chat', async () => {
  const f = frameFixture('navigation');
  await f.c.extractConversationInFrame('test', f.collect, f.c.conversationDataSnapshot);
  assert.match(f.messages[0].error, /网页已切换/);
  assert.equal(f.fallbackCalls(), 0);
});

test('cancelling aborts the pending request and cannot produce an export', async () => {
  const f = frameFixture();
  let resolve;
  f.page.fetch = () => new Promise(done => { resolve = done; });
  const job = f.c.extractConversationInFrame('test', f.collect, f.c.conversationDataSnapshot);
  [...f.listeners.values()][0]();
  assert.equal(f.controller().aborted, true);
  resolve({ ok: false });
  await job;
  assert.equal(f.messages.length, 0);
  assert.equal(f.fallbackCalls(), 0);
});

test('structured file citations are removed without replacing them with attachment names or losing web sources', () => {
  const c = scope();
  const data = dataFixture();
  const message = data.mapping.a2.message;
  message.content.parts = ['结论 FILE。参考 WEB。'];
  message.metadata = { content_references: [
    { type: 'file', matched_text: 'FILE', name: 'citation-only.pdf', url: 'https://example.org/internal-file' },
    { type: 'webpage', matched_text: 'WEB', title: '网页', url: 'https://example.org/source' },
  ] };
  const snapshot = c.conversationDataSnapshot(data, 'https://chatgpt.com/c/test');
  const md = c.conversationMarkdown({ title: '文献' }, snapshot, '讨论');
  assert.match(md, /结论。参考 \[网页\]\(<https:\/\/example.org\/source>\)。/);
  assert.match(md, /附件：\n- paper.pdf/);
  assert.doesNotMatch(md, /FILE|citation-only|internal-file/);
});
