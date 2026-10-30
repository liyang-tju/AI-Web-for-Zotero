const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');

function scope(extra = {}, initial = {}) {
  let stored = JSON.stringify(initial);
  const c = vm.createContext({
    Services: { prefs: { getStringPref: () => stored, setStringPref: (key, value) => { stored = value; } }, uuid: { generateUUID: () => 'test-channel' } },
    Zotero: { logError() {} }, ...extra,
  });
  vm.runInContext(source, c);
  return c;
}
const pdf = (key, libraryID = 1) => ({ key, libraryID, attachmentFilename: `${key}.pdf`, isPDFAttachment: () => true });

test('multiple conversations are retained per PDF and duplicate saves do not add entries', () => {
  const c = scope();
  const a = c.snapshotPDFs([pdf('A'), pdf('A')]);
  assert.equal(a.length, 1);
  c.savePDFBookmarks(a, 'https://chatgpt.com/c/one?model=test#fragment', '第一篇讨论 - ChatGPT');
  c.savePDFBookmarks(a, 'https://chatgpt.com/c/two', '第二篇讨论');
  c.savePDFBookmarks(a, 'https://chatgpt.com/c/one', '更新标题');
  c.savePDFBookmarks(c.snapshotPDFs([pdf('A', 2)]), 'https://chatgpt.com/c/other');
  const saved = c.readPDFBookmarks();
  assert.deepEqual(Array.from(saved['1:A'], x => x.url), ['https://chatgpt.com/c/one', 'https://chatgpt.com/c/two']);
  assert.equal(saved['1:A'][0].title, '更新标题');
  assert.equal(saved['2:A'].length, 1);
  for (const url of ['https://chatgpt.com/', 'http://chatgpt.com/c/a', 'https://chatgpt.com.evil/c/a', 'javascript:alert(1)']) {
    c.savePDFBookmarks(a, url);
  }
  assert.equal(c.readPDFBookmarks()['1:A'].length, 2);
});

test('legacy single bookmarks survive migration, new saves, deletion and reopening', () => {
  const old = { '1:A': { url: 'https://chatgpt.com/c/old', label: 'A.pdf', updatedAt: 123 },
    '1:B': { url: 'https://chatgpt.com/c/shared', label: 'B.pdf', updatedAt: 456 } };
  const c = scope({}, old);
  assert.equal(c.readPDFBookmarks()['1:A'][0].createdAt, 123);
  c.savePDFBookmarks(c.snapshotPDFs([pdf('A')]), 'https://chatgpt.com/c/new', 'New');
  const persisted = JSON.parse(c.Services.prefs.getStringPref());
  const reopened = scope({}, persisted);
  assert.equal(reopened.readPDFBookmarks()['1:A'].length, 2);
  assert.equal(reopened.readPDFBookmarks()['1:B'][0].url, 'https://chatgpt.com/c/shared');
  assert.equal(reopened.deletePDFBookmark('1:A', 'https://chatgpt.com/c/new'), true);
  assert.equal(reopened.readPDFBookmarks()['1:A'][0].url, 'https://chatgpt.com/c/old');
});

test('delete removes only the selected PDF/link and keeps other PDFs sharing the chat', () => {
  const c = scope();
  c.savePDFBookmarks(c.snapshotPDFs([pdf('A'), pdf('B')]), 'https://chatgpt.com/c/shared');
  c.savePDFBookmarks(c.snapshotPDFs([pdf('A')]), 'https://chatgpt.com/c/second');
  assert.equal(c.deletePDFBookmark('1:A', 'https://chatgpt.com/c/shared'), true);
  assert.equal(c.readPDFBookmarks()['1:A'][0].url, 'https://chatgpt.com/c/second');
  assert.equal(c.readPDFBookmarks()['1:B'][0].url, 'https://chatgpt.com/c/shared');
  assert.equal(c.deletePDFBookmark('1:A', 'https://chatgpt.com/c/shared'), false);
  c.deletePDFBookmark('1:A', 'https://chatgpt.com/c/second');
  assert.equal(c.readPDFBookmarks()['1:A'], undefined);
});

test('invalid stored data is not overwritten by a save or delete', () => {
  const c = scope();
  c.Services.prefs.setStringPref('', 'broken JSON');
  assert.throws(() => c.savePDFBookmarks(c.snapshotPDFs([pdf('A')]), 'https://chatgpt.com/c/one'));
  assert.throws(() => c.deletePDFBookmark('1:A', 'https://chatgpt.com/c/one'));
  assert.equal(c.Services.prefs.getStringPref(), 'broken JSON');
});

test('menu lists multiple conversations for current PDF and selected library attachments only', () => {
  const c = scope();
  const a = pdf('A'), b = pdf('B');
  c.Zotero.Reader = { getByTabID: () => ({ itemID: 1 }) };
  c.Zotero.Items = { get: ids => Array.isArray(ids) ? [a, b] : a };
  c.savePDFBookmarks(c.snapshotPDFs([a, b]), 'https://chatgpt.com/c/shared');
  c.savePDFBookmarks(c.snapshotPDFs([a]), 'https://chatgpt.com/c/second');
  const window = { Zotero_Tabs: { selectedID: 'reader' }, ZoteroPane: { getSelectedItems: () => [b] } };
  assert.deepEqual(Array.from(c.currentPDFBookmarks(window), x => x.url), ['https://chatgpt.com/c/shared', 'https://chatgpt.com/c/second']);
  window.Zotero_Tabs.selectedID = 'zotero-pane';
  assert.deepEqual(Array.from(c.currentPDFBookmarks(window), x => x.label), ['B.pdf']);
});

test('manual save works without automatic detection and never uploads or navigates', async () => {
  const c = scope();
  const window = {};
  const state = { browser: { currentURI: { spec: 'https://chatgpt.com/c/manual' } } };
  c.sidebarWindows.set(window, state);
  c.selectPDFAttachments = async (owner, purpose) => {
    assert.equal(owner, window);
    assert.equal(purpose, 'bookmark');
    return [pdf('A'), pdf('B'), pdf('A')];
  };
  c.attachFilesToChatGPT = () => { throw new Error('manual bookmark must not upload'); };
  assert.equal(await c.saveCurrentConversationBookmark(window, state), 2);
  assert.equal(c.readPDFBookmarks()['1:A'][0].url, 'https://chatgpt.com/c/manual');
  assert.equal(c.readPDFBookmarks()['1:B'][0].url, 'https://chatgpt.com/c/manual');
});

test('manual save rejects home and navigation during PDF selection and respects cancellation', async () => {
  const c = scope();
  const window = {};
  const state = { browser: { currentURI: { spec: 'https://chatgpt.com/' } } };
  c.sidebarWindows.set(window, state);
  c.selectPDFAttachments = async () => { throw new Error('must validate URL before selection'); };
  await assert.rejects(c.saveCurrentConversationBookmark(window, state), /正式会话地址/);
  state.browser.currentURI.spec = 'https://chatgpt.com/c/original';
  c.selectPDFAttachments = async () => null;
  assert.equal(await c.saveCurrentConversationBookmark(window, state), 0);
  c.selectPDFAttachments = async () => {
    state.browser.currentURI.spec = 'https://chatgpt.com/c/changed';
    return [pdf('A')];
  };
  await assert.rejects(c.saveCurrentConversationBookmark(window, state), /网页已切换/);
  assert.equal(Object.keys(c.readPDFBookmarks()).length, 0);
});
