const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js']
  .map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');

function fixture() {
  const menus = new Map();
  const files = [1, 2].map(id => ({ id, attachmentFilename: `${id}.pdf`,
    isPDFAttachment: () => true, getField: () => `${id}.pdf` }));
  const parent = { isPDFAttachment: () => false, isRegularItem: () => true,
    getAttachments: () => [1, 2], getField: () => 'Paper' };
  const note = { isPDFAttachment: () => false, isRegularItem: () => false, getField: () => 'Note' };
  const c = vm.createContext({ APP_SHUTDOWN: -1, Zotero: {
    locale: 'zh-CN', Items: { get: ids => files.filter(file => ids.includes(file.id)) },
    MenuManager: { registerMenu(options) { menus.set(options.menuID, options); return options.menuID; },
      unregisterMenu(id) { return menus.delete(id); } },
  } });
  vm.runInContext(source, c);
  c.addonRootURI = 'resource://sidebar/';
  c.registerPDFContextMenu('chatgpt-web-sidebar-demo@local');
  const menu = [...menus.values()][0];
  return { c, files, parent, note, menus, menu, action: menu.menus[0] };
}

test('native library context menu registration is unique and removed on shutdown', () => {
  const f = fixture();
  assert.equal(f.menu.target, 'main/library/item');
  assert.equal(f.menu.pluginID, 'chatgpt-web-sidebar-demo@local');
  assert.equal(f.action.icon, 'resource://sidebar/icons/upload.svg');
  f.c.registerPDFContextMenu('chatgpt-web-sidebar-demo@local');
  assert.equal(f.menus.size, 1);
  f.c.shutdown({}, 0);
  assert.equal(f.menus.size, 0);
  f.c.registerPDFContextMenu('chatgpt-web-sidebar-demo@local');
  assert.equal(f.menus.size, 1);
});

test('right-click upload follows the owning window, supports PDFs and parents, and hides for notes', async () => {
  const f = fixture();
  const window = {};
  const calls = [];
  const state = { uploadSelectedPDFs: items => calls.push(items) };
  f.c.sidebarWindows.set(window, state);
  f.c.sidebarWindows.set({}, { uploadSelectedPDFs: () => assert.fail('wrong window') });
  const context = { items: [f.files[1]], menuElem: { ownerDocument: { defaultView: window },
    setAttribute: (key, value) => { context[key] = value; } },
    setVisible: visible => { context.visible = visible; }, setEnabled: enabled => { context.enabled = enabled; } };
  f.action.onShowing(null, context);
  assert.equal(context.label, '上传 PDF');
  assert.equal(context.visible, true);
  assert.equal(context.enabled, true);
  await f.action.onCommand(null, context);
  context.items.length = 0;
  assert.deepEqual(Array.from(calls[0]), [f.files[1]]);
  for (const busy of ['uploading', 'exporting', 'savingBookmark']) {
    state[busy] = true;
    context.items = [f.parent];
    f.action.onShowing(null, context);
    assert.equal(context.visible, true);
    assert.equal(context.enabled, false);
    state[busy] = false;
  }
  f.c.Zotero.locale = 'en-US';
  f.action.onShowing(null, context);
  assert.equal(context.label, 'Upload PDF');
  for (const items of [[], [f.note]]) {
    context.items = items;
    f.action.onShowing(null, context);
    assert.equal(context.visible, false);
  }
  f.c.sidebarWindows.clear(); // window was closed before command delivery
  assert.equal(f.action.onCommand(null, context), undefined);
});

test('explicit context selection overrides a reader, but ordinary toolbar upload still uses its current PDF', async () => {
  const f = fixture();
  const window = { Zotero_Tabs: { selectedID: 'reader-A' }, ZoteroPane: {
    getSelectedItems: () => { throw new Error('must use captured context selection'); } } };
  f.c.Zotero.Reader = { getByTabID: () => ({ itemID: 1 }) };
  f.c.Zotero.Items.get = ids => Array.isArray(ids) ? f.files.filter(file => ids.includes(file.id)) : f.files.find(file => file.id === ids);
  assert.equal((await f.c.selectPDFAttachments(window, 'upload', [f.files[1]]))[0], f.files[1]);
  assert.equal((await f.c.selectPDFAttachments(window))[0], f.files[0]);
  f.c.choosePDFs = async (_owner, groups) => {
    assert.equal(groups[0].title, 'Paper');
    assert.deepEqual(Array.from(groups[0].files, file => file.id), [1, 2]);
    return [2, 1, 2];
  };
  assert.deepEqual(Array.from(await f.c.selectPDFAttachments(window, 'upload', [f.parent, f.files[1]]), item => item.id), [2, 1]);
  await assert.rejects(f.c.selectPDFAttachments(window, 'upload', []), /请先在文献库/);
});
