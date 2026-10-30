const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');

function scope(globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(source, context);
  return context;
}

test('active non-PDF reader must not upload an unrelated library selection', async () => {
  const c = scope({ Zotero: { Reader: { getByTabID: () => ({ itemID: 1 }) }, Items: { get: () => ({ isPDFAttachment: () => false }) } } });
  await assert.rejects(c.selectPDFAttachments({ Zotero_Tabs: { selectedID: 'reader-1' } }), /不是 PDF/);
});

test('reader selection takes priority over hidden library selection', async () => {
  const item = { isPDFAttachment: () => true };
  const c = scope({ Zotero: { Reader: { getByTabID: () => ({ itemID: 4 }) }, Items: { get: () => item } } });
  assert.equal((await c.selectPDFAttachments({ Zotero_Tabs: { selectedID: 'reader-1' } }))[0], item);
});

test('switching Zotero readers resolves the new PDF on each upload', async () => {
  const items = { a: { isPDFAttachment: () => true }, b: { isPDFAttachment: () => true } };
  const c = scope({ Zotero: { Reader: { getByTabID: id => ({ itemID: id }) }, Items: { get: id => items[id] } } });
  const window = { Zotero_Tabs: { selectedID: 'a' } };
  assert.equal((await c.selectPDFAttachments(window))[0], items.a);
  window.Zotero_Tabs.selectedID = 'b';
  assert.equal((await c.selectPDFAttachments(window))[0], items.b);
});

function libraryFixture() {
  const pdf = id => ({ id, isPDFAttachment: () => true, attachmentFilename: `${id}.pdf`, getField: () => `${id}.pdf` });
  const files = [pdf(1), pdf(2), pdf(3), { id: 4, isPDFAttachment: () => false }];
  const parent = (title, ids) => ({ isPDFAttachment: () => false, isRegularItem: () => true, getField: () => title, getAttachments: () => ids });
  const parents = [parent('Article A', [1, 2]), parent('Article B', [3, 4]), parent('Article C', [])];
  const c = scope({ Zotero: { Items: { get: ids => files.filter(file => ids.includes(file.id)) } } });
  c.choosePDFs = async () => null;
  const window = { ZoteroPane: { getSelectedItems: () => parents } };
  return { c, window, files, parents };
}

test('empty library selection asks for an item', async () => {
  const c = scope();
  await assert.rejects(c.selectPDFAttachments({ ZoteroPane: { getSelectedItems: () => [] } }), /请先/);
});

test('PDF chooser cancellation does not choose default files', async () => {
  const { c, window } = libraryFixture();
  assert.equal(await c.selectPDFAttachments(window), null);
});

test('three selected articles have three groups with only their own PDF children', async () => {
  const { c, window } = libraryFixture();
  c.choosePDFs = async (owner, groups) => {
    assert.equal(owner, window);
    assert.deepEqual(Array.from(groups, group => group.title), ['Article A', 'Article B', 'Article C']);
    assert.deepEqual(Array.from(groups, group => Array.from(group.files, file => file.id)), [[1, 2], [3], []]);
    return [2, 3];
  };
  assert.deepEqual(Array.from(await c.selectPDFAttachments(window), file => file.id), [2, 3]);
});

test('parent and directly selected attachment are deduplicated and unknown IDs ignored', async () => {
  const { c, window, files, parents } = libraryFixture();
  window.ZoteroPane.getSelectedItems = () => [parents[0], files[0]];
  c.choosePDFs = async () => [1, 1, 2, 999];
  assert.deepEqual(Array.from(await c.selectPDFAttachments(window), file => file.id), [1, 2]);
});

test('single PDF shortcut remains and an article without PDFs is rejected', async () => {
  const { c, window, files, parents } = libraryFixture();
  c.choosePDFs = () => { throw new Error('single file must not prompt'); };
  window.ZoteroPane.getSelectedItems = () => [parents[1]];
  assert.equal((await c.selectPDFAttachments(window))[0], files[2]);
  window.ZoteroPane.getSelectedItems = () => [parents[2]];
  await assert.rejects(c.selectPDFAttachments(window), /没有 PDF/);
});

function frameFixture(options = {}) {
  const listeners = new Map();
  const results = [];
  const events = [];
  const cards = [];
  const visible = { isConnected: true, getClientRects: () => [{}] };
  const card = name => ({ ...visible, getAttribute: key => key === 'aria-label' ? `移除 ${name}` : null });
  if (options.existingCard) cards.push(card(options.existingCard));
  const composer = { contains: node => [editor, plus, input].includes(node), querySelectorAll: () => cards };
  composer.querySelector = () => options.historyInComposer ? {} : null;
  const editor = { ...visible, closest: selector => selector.includes('form') || selector === options.adapter?.composer ? composer : null };
  const plus = { ...visible, click: () => { throw new Error('must not simulate webpage menu clicks'); } };
  const input = { ...visible, accept: '.pdf', multiple: options.multiple !== false, disabled: false, form: composer, value: 'previous.pdf', files: [{ name: 'previous.pdf' }],
    closest: selector => selector === 'form' || selector === options.adapter?.fileInputScope ? composer : null,
    mozSetFileArray: files => { input.files = files; events.push(...files); },
    dispatchEvent: event => {
      events.push(event.type);
      if (event.type === 'change' && options.navigate) doc.location.href = 'https://chatgpt.com/c/other';
      if (event.type === 'change' && !options.silent && !options.failure) input.files.slice(0, options.partial ? 1 : undefined).forEach(file => cards.push(card(file.name)));
    } };
  const foreign = { ...input, form: {}, closest: selector => selector === 'form' ? {} : null, mozSetFileArray: () => { throw new Error('wrong composer'); } };
  const second = { ...input };
  const notice = { textContent: '因网络问题，上传未成功。请检查网络连接后重试。' };
  const doc = { body: {}, location: { origin: options.origin || 'https://chatgpt.com', href: 'https://chatgpt.com/c/test' },
    querySelectorAll: selector => {
      if (selector.startsWith('#prompt-textarea') || (options.adapter && selector === options.adapter.editor)) return options.duplicateEditor ? [editor, editor] : [editor];
      if (selector.startsWith('button[data-testid')) return [plus];
      if (selector === 'input[type="file"]') return options.ambiguous ? [foreign, input, second] : [foreign, input];
      return options.failure && events.length ? [notice] : [];
    } };
  const page = { document: doc, Event: class { constructor(type) { this.type = type; } }, setTimeout: fn => {
    if (options.navigate) doc.location.href = 'https://chatgpt.com/c/other';
    fn();
  } };
  const c = scope({ content: page,
    addMessageListener: (name, fn) => listeners.set(name, fn), removeMessageListener: name => listeners.delete(name),
    sendAsyncMessage: (name, value) => results.push(value) });
  let count = 0;
  async function upload(name = 'test.pdf') {
    const channel = `test-${++count}`;
    c.uploadFileInFrame(channel, options.adapter);
    await listeners.get(`${channel}:file`)({ data: { files: (Array.isArray(name) ? name : [name]).map(name => ({ name })) } });
    return results.at(-1);
  }
  return { upload, events, cards, input, listeners, results };
}

test('file is attached only on exact HTTPS ChatGPT origin', async () => {
  for (const origin of ['https://chatgpt.com.evil.example', 'http://chatgpt.com', 'https://auth.openai.com']) {
    const f = frameFixture({ origin });
    assert.equal((await f.upload()).ok, false);
    assert.equal(f.events.length, 0);
    assert.equal(f.listeners.size, 0);
  }
});

test('direct upload selects the current composer and clears the old chooser selection', async () => {
  const f = frameFixture({ existingCard: 'existing.pdf' });
  assert.equal((await f.upload()).ok, true);
  assert.equal(f.input.value, '');
  assert.equal(f.events[0].name, 'test.pdf');
  assert.deepEqual(f.events.slice(1), ['input', 'change']);
  assert.equal(f.cards.length, 2);
  assert.equal(f.cards[0].getAttribute('aria-label'), '移除 existing.pdf');
  assert.equal(f.listeners.size, 0);
});

test('sequential A -> A -> B uploads use the new file without reusing previous selection', async () => {
  const f = frameFixture();
  for (const name of ['A.pdf', 'A.pdf', 'B.pdf']) {
    assert.equal((await f.upload(name)).ok, true);
    assert.equal(f.input.files[0].name, name);
    f.cards.length = 0; // Simulate sending the previous message, keeping input.files stale.
  }
  assert.deepEqual(f.events.filter(event => typeof event === 'object').map(file => file.name), ['A.pdf', 'A.pdf', 'B.pdf']);
});

test('existing same-name cards do not prevent delivery without a new preview', async () => {
  const f = frameFixture({ existingCard: 'A.pdf', silent: true });
  const result = await f.upload('A.pdf');
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'delivered');
  assert.equal(f.cards.length, 1);
});

test('same-name upload preserves the existing card', async () => {
  const f = frameFixture({ existingCard: 'A.pdf' });
  assert.equal((await f.upload('A.pdf')).ok, true);
  assert.equal(f.cards.length, 2);
});

test('ambiguous file controls are not guessed', async () => {
  const f = frameFixture({ ambiguous: true });
  assert.equal((await f.upload()).ok, false);
  assert.equal(f.events.length, 0);
});

test('website progress and navigation after delivery are left to the website', async () => {
  const f = frameFixture({ failure: true });
  assert.equal((await f.upload()).stage, 'delivered');
  const moved = frameFixture({ silent: true, navigate: true });
  assert.equal((await moved.upload()).stage, 'delivered');
  assert.equal(moved.listeners.size, 0);
});

test('batch upload delivers every PDF without waiting for previews', async () => {
  const f = frameFixture({ existingCard: 'old.pdf' });
  assert.equal((await f.upload(['main.pdf', 'supplement.pdf'])).ok, true);
  assert.deepEqual(f.input.files.map(file => file.name), ['main.pdf', 'supplement.pdf']);
  assert.equal(f.cards.length, 3);
  const partial = frameFixture({ partial: true });
  assert.equal((await partial.upload(['main.pdf', 'supplement.pdf'])).stage, 'delivered');
});

test('batch upload refuses single-file controls without clearing previous selection', async () => {
  const f = frameFixture({ multiple: false });
  assert.equal((await f.upload(['main.pdf', 'supplement.pdf'])).ok, false);
  assert.equal(f.input.value, 'previous.pdf');
  assert.equal(f.events.length, 0);
});


test('non-ChatGPT providers reuse exact-origin upload and stale-input reset', async () => {
  const c = scope();
  for (const url of ['https://gemini.google.com/app/test', 'https://chat.deepseek.com/a/chat/s/test', 'https://www.kimi.com/chat/test', 'https://chat.z.ai/c/test', 'https://chatglm.cn/main/alltoolsdetail?cid=test']) {
    const adapter = c.siteAdapter(url);
    const f = frameFixture({ adapter, origin: adapter.origin, existingCard: 'A.pdf' });
    assert.equal((await f.upload('A.pdf')).ok, true, adapter.id);
    assert.equal(f.cards.length, 2);
    const wrong = frameFixture({ adapter, origin: adapter.origin + '.evil.example' });
    assert.equal((await wrong.upload()).ok, false);
    assert.equal(wrong.events.length, 0);
    const history = frameFixture({ adapter, origin: adapter.origin, historyInComposer: true });
    assert.equal((await history.upload()).ok, false);
    assert.equal(history.events.length, 0);
    const ambiguous = frameFixture({ adapter, origin: adapter.origin, duplicateEditor: true });
    assert.equal((await ambiguous.upload()).ok, adapter.id === 'gemini');
    assert.equal(ambiguous.events.length, adapter.id === 'gemini' ? 3 : 0);
  }
});
