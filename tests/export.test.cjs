const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');
function scope(globals = {}) { const c = vm.createContext({ ...globals, Zotero: { locale: 'zh-CN', ...globals.Zotero } }); vm.runInContext(source, c); return c; }

// A small DOM fixture. Text nodes and attributes stay separate so serialization
// tests exercise escaping, selection scope, roles and nested block structure.
function text(value) { return { nodeType: 3, nodeValue: value, get textContent() { return value; } }; }
function element(tag, attrs = {}, ...children) {
  const node = { nodeType: 1, localName: tag, attrs, style: {}, handlers: {}, childNodes: [],
    get children() { return this.childNodes.filter(n => n.nodeType === 1); },
    get textContent() { return this.childNodes.map(n => n.textContent).join(''); },
    set textContent(value) { this.childNodes = [text(value)]; },
    get href() { return this.attrs.href || ''; },
    getAttribute(key) { return this.attrs[key] ?? null; },
    setAttribute(key, value) { this.attrs[key] = value; },
    append(...nodes) { this.childNodes.push(...nodes); },
    remove() { this.removed = true; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    focus() {}, getClientRects() { return [{}]; },
    contains(other) { return this === other || this.children.some(child => child.contains(other)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const matches = n => selector.split(',').some(raw => {
        const part = raw.trim();
        const tagName = part.match(/^[a-z][a-z0-9-]*/)?.[0];
        if (tagName && n.localName !== tagName) return false;
        for (const match of part.matchAll(/\[([^\s=*^\]]+)([*^]?=)?(?:"([^"]*)")?\]/g)) {
          const value = n.getAttribute(match[1]);
          if (value == null) return false;
          if (match[2] === '=' && value !== match[3]) return false;
          if (match[2] === '^=' && !value.startsWith(match[3])) return false;
          if (match[2] === '*=' && !value.includes(match[3])) return false;
        }
        return true;
      });
      const result = [];
      const walk = n => n.children.forEach(child => { if (matches(child)) result.push(child); walk(child); });
      walk(this);
      return result;
    } };
  node.append(...children.map(n => typeof n === 'string' ? text(n) : n));
  return node;
}
function documentFor(...turns) {
  const body = element('body', {}, ...turns);
  return { title: '测试讨论 - ChatGPT', location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/test' },
    querySelectorAll: selector => body.querySelectorAll(selector) };
}
function turn(role, ...nodes) { return element('article', { 'data-turn': role, 'data-testid': 'conversation-turn-1' }, ...nodes); }

test('extraction preserves roles, file-only messages and text while excluding composer and scripts', () => {
  const c = scope();
  const doc = documentFor(
    turn('user', element('button', { title: 'paper.pdf' }, 'paper.pdf')),
    turn('assistant', element('div', { 'data-message-author-role': 'assistant' }, element('p', {}, '结果 <script>不执行</script>'), element('script', {}, 'ignored()'))),
    element('textarea', {}, 'UNSENT DRAFT'));
  const snapshot = c.collectConversationSnapshot(doc);
  assert.equal(snapshot.messages.length, 2);
  assert.match(snapshot.messages[0].markdown, /附件：\n- paper.pdf/);
  assert.match(snapshot.messages[1].markdown, /&lt;script&gt;/);
  assert.doesNotMatch(JSON.stringify(snapshot), /UNSENT DRAFT|ignored\(\)/);
  assert.equal(snapshot.scope, 'loaded-page');
});

test('code, formula, table, list and link serialize into Markdown', () => {
  const c = scope();
  const doc = documentFor(turn('assistant',
    element('pre', {}, element('code', { class: 'language-python' }, 'print("```")\n\n\nprint(2)\n')),
    element('span', { class: 'katex-display' }, element('span', { class: 'katex' }, element('annotation', { encoding: 'application/x-tex' }, 'E=mc^2'))),
    element('table', {}, element('tr', {}, element('th', {}, 'A'), element('th', {}, 'B')), element('tr', {}, element('td', {}, 'x|y'), element('td', {}, '2'))),
    element('ul', {}, element('li', {}, 'first'), element('li', {}, 'second')),
    element('a', { href: 'https://example.org/paper' }, '论文'), element('a', { href: 'javascript:bad()' }, 'unsafe')));
  const md = c.collectConversationSnapshot(doc).messages[0].markdown;
  assert.match(md, /````python\nprint\("```"\)\n\n\nprint\(2\)\n````/);
  assert.equal((md.match(/E=mc\^2/g) || []).length, 1);
  assert.match(md, /\$\$\nE=mc\^2\n\$\$/);
  assert.match(md, /\| A \| B \|\n\| --- \| --- \|\n\| x\\\|y \| 2 \|/);
  assert.match(md, /- first\n- second/);
  assert.match(md, /\[论文\]\(<https:\/\/example.org\/paper>\)/);
  assert.doesNotMatch(md, /javascript:/);
});

test('fallback message containers work and an empty conversation is rejected', () => {
  const c = scope();
  assert.equal(c.collectConversationSnapshot(documentFor(element('div', { 'data-message-author-role': 'user' }, '你好'))).messages[0].role, 'user');
  assert.throws(() => c.collectConversationSnapshot(documentFor(element('textarea', {}, 'draft'))), /没有找到/);
});

function saveFixture(fail = false) {
  const parent = { id: 10, libraryID: 1, isRegularItem: () => true, getField: () => '文献标题' };
  const attachment = { id: 20, parentItemID: 10, isRegularItem: () => false };
  const items = new Map([[10, parent], [20, attachment]]);
  const library = { editable: true, filesEditable: true };
  const writes = [], imports = [], temps = [];
  let serial = 0;
  const c = scope({ Zotero: { Items: { get: id => items.get(id) }, Libraries: { get: () => library },
    Reader: { getByTabID: () => ({ itemID: 20 }) }, logError() {},
    getTempDirectory: () => { const file = { append(name) { this.name = name; }, exists: () => true, remove() { this.removed = true; } }; temps.push(file); return file; },
    File: { putContentsAsync: async (file, content) => writes.push(content), getValidFileName: name => name },
    Attachments: { importFromFile: async options => { if (fail) throw new Error('import failed'); imports.push(options); return { id: 100 + imports.length }; } } },
    Services: { uuid: { generateUUID: () => `uuid-${++serial}` } } });
  const snapshot = { title: '讨论', url: 'https://chatgpt.com/c/test', capturedAt: '2026-10-26T12:00:00Z', messages: [{ role: 'user', markdown: '你好' }, { role: 'assistant', markdown: '结果' }] };
  return { c, parent, items, library, writes, imports, temps, snapshot };
}

test('reader export targets the PDF parent; invalid or read-only targets are rejected', () => {
  const f = saveFixture();
  const target = f.c.currentExportParent({ Zotero_Tabs: { selectedID: 'reader' } });
  assert.equal(target.id, 10);
  assert.equal(target.title, '文献标题');
  assert.throws(() => f.c.currentExportParent({ ZoteroPane: { getSelectedItems: () => [] } }), /一篇文献/);
  assert.throws(() => f.c.currentExportParent({ ZoteroPane: { getSelectedItems: () => [{ isRegularItem: () => false }] } }), /独立附件/);
  f.library.editable = false;
  assert.throws(() => f.c.currentExportParent({ Zotero_Tabs: { selectedID: 'reader' } }), /不允许/);
});

test('each save imports a new Markdown attachment with metadata and cleans temporary files', async () => {
  const f = saveFixture();
  const parent = { id: 10, title: '文献 "一"\n换行' };
  await f.c.saveConversationMarkdown(parent, f.snapshot, '讨论');
  await f.c.saveConversationMarkdown(parent, f.snapshot, '讨论');
  assert.equal(f.imports.length, 2);
  assert.equal(f.imports[0].parentItemID, 10);
  assert.equal(f.imports[0].contentType, 'text/markdown');
  assert.equal(f.imports[0].charset, 'utf-8');
  assert.match(f.writes[0], /文献: "文献 \\"一\\"\\n换行"/);
  assert.doesNotMatch(f.writes[0], /提取范围|本文件|附件仅记录/);
  assert.match(f.writes[0], /## 我\n\n你好/);
  assert.match(f.writes[0], /## ChatGPT\n\n结果/);
  assert.ok(f.temps.every(file => file.removed));
  assert.notEqual(f.temps[0].name, f.temps[1].name);
});

test('failed attachment import cleans up the temporary file and reports failure', async () => {
  const f = saveFixture(true);
  await assert.rejects(f.c.saveConversationMarkdown({ id: 10, title: '文献' }, f.snapshot, '讨论'), /import failed/);
  assert.equal(f.temps[0].removed, true);
  assert.equal(f.imports.length, 0);
});

test('preview stays read-only until confirmation and cancellation cleans up the overlay', async () => {
  for (const accept of [false, true]) {
    const c = scope();
    const root = element('window');
    const events = new Map();
    const doc = { documentElement: root, createElementNS: (ns, tag) => element(tag) };
    const window = { document: doc, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
    const state = {};
    const promise = c.previewConversation(window, state, { title: '文献' }, { title: '讨论', url: 'https://chatgpt.com/c/test', messages: [{ role: 'user', markdown: '<script>literal</script>' }] });
    const buttons = root.querySelectorAll('button');
    assert.equal(buttons.length, 2);
    assert.equal(root.querySelectorAll('script').length, 0);
    buttons.find(button => button.textContent === (accept ? '新增 Zotero 笔记' : '取消')).handlers.click();
    const result = await promise;
    if (accept) {
      assert.equal(result.title, 'ChatGPT 对话 — 讨论');
      assert.equal(result.snapshot.messages.length, 1);
      assert.deepEqual(Array.from(result.snapshot.selection.rounds), [1]);
    } else assert.equal(result, null);
    assert.equal(state.cancelExportPreview, null);
    assert.equal(events.size, 0);
  }
});


test('frame extraction rejects other sites and an in-progress response before reading messages', async () => {
  const results = [];
  let collected = false;
  const doc = documentFor();
  const c = scope({ content: { document: doc, removeEventListener() {} }, removeMessageListener() {}, sendAsyncMessage: (channel, value) => results.push(value) });
  doc.location.origin = 'https://example.org';
  await c.extractConversationInFrame('test', () => { collected = true; });
  assert.match(results.at(-1).error, /尚未适配/);
  doc.location.origin = 'https://chatgpt.com';
  doc.querySelectorAll = () => [{ getClientRects: () => [{}] }];
  await c.extractConversationInFrame('test', () => { collected = true; });
  assert.match(results.at(-1).error, /仍在生成/);
  assert.equal(collected, false);
});

test('request cancellation and successful reply both remove listeners and timers', async () => {
  for (const cancel of [true, false]) {
    const listeners = new Map(), timers = new Map();
    const c = scope({ Services: { uuid: { generateUUID: () => 'export-test' } } });
    const state = { browser: { messageManager: {
      addMessageListener: (name, fn) => listeners.set(name, fn), removeMessageListener: name => listeners.delete(name), loadFrameScript() {},
    } } };
    const window = { setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) };
    const promise = c.requestConversationSnapshot(window, state);
    if (cancel) {
      state.cancelExportRequest();
      await assert.rejects(promise, /取消/);
    } else {
      [...listeners.values()][0]({ data: { url: 'https://chatgpt.com/c/test', messages: [{ role: 'user', markdown: 'hello' }] } });
      assert.equal((await promise).messages.length, 1);
    }
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
    assert.equal(state.cancelExportRequest, null);
  }
});


test('preview selects whole question/answer rounds and prevents an empty save', async () => {
  const c = scope();
  const root = element('window');
  const window = { document: { documentElement: root, createElementNS: (ns, tag) => element(tag) }, addEventListener() {}, removeEventListener() {} };
  const snapshot = { title: '讨论', url: 'https://chatgpt.com/c/test', messages: [
    { role: 'user', markdown: 'question A' }, { role: 'assistant', markdown: 'answer A' },
    { role: 'user', markdown: 'question B' }, { role: 'assistant', markdown: 'answer B' },
  ] };
  const promise = c.previewConversation(window, {}, { title: '文献' }, snapshot);
  assert.doesNotMatch(root.textContent, /提取到|来源：|长对话|Markdown 源文|附件仅记录|可编辑|Zotero 阅读器/);
  assert.deepEqual(root.querySelectorAll('option').map(node => node.textContent), ['Zotero 笔记', 'HTML', 'Markdown 文件']);
  const buttons = root.querySelectorAll('button');
  const save = buttons.find(button => button.textContent === '新增 Zotero 笔记');
  const [all, ...boxes] = root.querySelectorAll('input').filter(input => input.type === 'checkbox');
  assert.equal(boxes.length, 2);
  assert.equal(all.checked, true);
  assert.equal(all.indeterminate, false);
  all.checked = false;
  all.handlers.change();
  assert.ok(boxes.every(box => !box.checked));
  assert.equal(all.indeterminate, false);
  assert.equal(save.disabled, true);
  let settled = false;
  promise.then(() => { settled = true; });
  save.handlers.click();
  await Promise.resolve();
  assert.equal(settled, false);
  all.checked = true;
  all.handlers.change();
  assert.equal(save.disabled, false);
  assert.ok(boxes.every(box => box.checked));
  boxes[0].checked = false;
  boxes[0].handlers.change();
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true);
  // Activating a mixed checkbox selects all, as a native HTML checkbox does.
  all.checked = true;
  all.handlers.change();
  assert.equal(all.indeterminate, false);
  assert.ok(boxes.every(box => box.checked));
  boxes[0].checked = false;
  boxes[0].handlers.change();
  save.handlers.click();
  const result = await promise;
  assert.deepEqual(Array.from(result.snapshot.messages, message => message.markdown), ['question B', 'answer B']);
  assert.deepEqual(Array.from(result.snapshot.selection.rounds), [2]);
  const markdown = c.conversationMarkdown({ title: '文献' }, result.snapshot, result.title);
  assert.doesNotMatch(markdown, /question A|answer A/);
  assert.match(markdown, /导出轮次: "2"/);
});


test('preview returns the chosen save format while retaining the same selected messages', async () => {
  for (const format of ['note', 'html', 'markdown']) {
    const c = scope();
    const root = element('window');
    const window = { document: { documentElement: root, createElementNS: (ns, tag) => element(tag) }, addEventListener() {}, removeEventListener() {} };
    const pending = c.previewConversation(window, {}, { title: '文献' }, { title: '讨论', url: 'https://chatgpt.com/c/test', messages: [{ role: 'user', markdown: '选择' }] });
    const select = root.querySelector('select');
    assert.equal(select.value, 'note');
    assert.deepEqual(select.children.map(option => option.value), ['note', 'html', 'markdown']);
    select.value = format;
    select.handlers.change();
    const label = { note: '新增 Zotero 笔记', html: '新增 HTML 附件', markdown: '新增 Markdown 附件' }[format];
    root.querySelectorAll('button').find(button => button.textContent === label).handlers.click();
    const selection = await pending;
    assert.equal(selection.format, format);
    assert.equal(selection.snapshot.messages[0].markdown, '选择');
  }
});

test('custom URL entry cancels cleanly and validates the address and busy state before opening', () => {
  const writes = [];
  const c = scope({ Services: { io: { newURI(value) { const u = new URL(value); return { spec: u.href, scheme: u.protocol.slice(0,-1), host: u.hostname }; } },
    prefs: { getStringPref: (_, fallback) => fallback } } });
  const root = element('window');
  const window = { document: { documentElement: root, createElementNS: (_, tag) => element(tag),
    createXULElement: tag => Object.assign(element(tag), {
      openPopup() {}, hidePopup() { this.handlers.popuphidden?.(); },
    }) } };
  const state = {};
  c.showSidebarURLInput(window, state, url => writes.push(url));
  root.querySelectorAll('button').find(node => node.textContent === '取消').handlers.click();
  assert.equal(writes.length, 0);
  assert.equal(state.cancelSiteInput, null);
  // This fixture marks removed nodes rather than mutating the parent.
  root.childNodes = [];
  c.showSidebarURLInput(window, state, url => writes.push(url));
  const input = root.querySelector('input');
  assert.equal(input.value, 'https://chatgpt.com/');
  input.value = 'javascript:alert(1)';
  const save = root.querySelectorAll('button').find(node => node.textContent === '打开');
  save.handlers.click();
  assert.equal(writes.length, 0);
  assert.ok(state.cancelSiteInput);
  input.value = 'https://chat.deepseek.com/'; state.uploading = true;
  save.handlers.click(); assert.equal(writes.length, 0);
  state.uploading = false; save.handlers.click();
  assert.deepEqual(writes, ['https://chat.deepseek.com/']);
  assert.equal(state.cancelSiteInput, null);
});

test('English export preview localizes controls but never translates conversation content', async () => {
  const c = scope({ Zotero: { locale: 'en-US' } });
  const root = element('window');
  const window = { document: { documentElement: root, createElementNS: (_, tag) => element(tag) }, addEventListener() {}, removeEventListener() {} };
  const pending = c.previewConversation(window, {}, { title: '原始文献标题' }, {
    title: '原始聊天标题', url: 'https://chatgpt.com/c/test', scope: 'loaded-page',
    messages: [{ role: 'user', markdown: '全选' }, { role: 'assistant', markdown: '取消' }],
  });
  assert.ok(root.querySelector('h2').textContent.includes('Export conversation preview'));
  assert.ok(root.textContent.includes('原始文献标题'));
  const articles = root.querySelectorAll('article');
  assert.ok(articles[0].textContent.includes('全选'));
  assert.ok(articles[1].textContent.includes('取消'));
  root.querySelectorAll('button').find(node => node.textContent === 'Add Zotero note').handlers.click();
  const selection = await pending;
  assert.equal(selection.snapshot.messages[0].markdown, '全选');
  assert.equal(selection.snapshot.messages[1].markdown, '取消');
  assert.equal(selection.format, 'note');
});
