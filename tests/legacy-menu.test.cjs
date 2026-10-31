const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js']
  .map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');

function fixture() {
  const files = [1, 2].map(id => ({ id, isPDFAttachment: () => true, getField: () => `${id}.pdf` }));
  const parent = { isPDFAttachment: () => false, isRegularItem: () => true,
    getAttachments: () => [1, 2], getField: () => 'Paper' };
  const note = { isPDFAttachment: () => false, isRegularItem: () => false, getField: () => 'Note' };
  const c = vm.createContext({ APP_SHUTDOWN: -1, Zotero: { locale: 'zh-CN',
    Items: { get: ids => files.filter(file => ids.includes(file.id)) } } });
  vm.runInContext(source, c);
  c.addonRootURI = 'resource://sidebar/';
  function addWindow() {
    const { window: domWindow, document } = parseHTML('<html><body><menupopup id="zotero-itemmenu"></menupopup></body></html>');
    // Linkedom window proxies share a JS global; use isolated host globals to
    // model two real Zotero windows and their independent library selections.
    const window = { document, Event: domWindow.Event };
    Object.defineProperty(document, 'defaultView', { value: window });
    document.createXULElement = tag => document.createElement(tag);
    let selected = [files[0]];
    window.ZoteroPane = { getSelectedItems: () => selected };
    const calls = [];
    const state = { uploadSelectedPDFs: items => calls.push(items) };
    for (const name of ['panel', 'divider', 'button', 'popup']) state[name] = document.createElement('div');
    c.sidebarWindows.set(window, state);
    c.attachLegacyPDFContextMenu(window, state);
    const popup = document.getElementById('zotero-itemmenu');
    const menu = document.getElementById('ai-web-sidebar-upload-pdf');
    return { window, document, state, popup, menu, calls,
      select: items => { selected = items; },
      show: () => popup.dispatchEvent(new window.Event('popupshowing', { bubbles: true })),
      command: () => menu.dispatchEvent(new window.Event('command')) };
  }
  return { c, files, parent, note, addWindow };
}

test('Zotero 7 without MenuManager registers no native menu and creates one legacy menu per window', () => {
  const f = fixture();
  assert.doesNotThrow(() => f.c.registerPDFContextMenu('chatgpt-web-sidebar-demo@local'));
  assert.equal(f.c.pdfContextMenuID, null);
  const first = f.addWindow(), second = f.addWindow();
  f.c.attachLegacyPDFContextMenu(first.window, first.state);
  assert.equal(first.popup.children.length, 1);
  assert.equal(second.popup.children.length, 1);
  assert.equal(first.menu.getAttribute('image'), 'resource://sidebar/icons/upload.svg');
});

test('legacy upload uses the popup selection and owner window, ignoring submenu events and later selections', () => {
  const f = fixture(), first = f.addWindow(), second = f.addWindow();
  const selected = [f.files[1], f.parent];
  first.select(selected);
  first.show();
  selected.length = 0;
  first.select([f.files[0]]);
  first.menu.dispatchEvent(new first.window.Event('popupshowing', { bubbles: true }));
  first.popup.dispatchEvent(new first.window.Event('popuphidden'));
  first.command();
  assert.deepEqual(Array.from(first.calls[0]), [f.files[1], f.parent]);
  assert.equal(second.calls.length, 0);
  first.show();
  first.command();
  assert.deepEqual(Array.from(first.calls[1]), [f.files[0]]);
});

test('legacy menu shares PDF filtering, busy flags and language switching with the native API', () => {
  const f = fixture(), win = f.addWindow();
  win.show();
  assert.equal(win.menu.getAttribute('label'), '上传 PDF');
  assert.equal(win.menu.hidden, false);
  assert.equal(win.menu.disabled, false);
  f.c.Zotero.locale = 'en-US';
  win.select([f.parent]);
  for (const busy of ['uploading', 'savingBookmark', 'exporting']) {
    win.state[busy] = true;
    win.show();
    assert.equal(win.menu.disabled, true);
    assert.equal(win.menu.hidden, false);
    win.command();
    win.state[busy] = false;
  }
  assert.equal(win.menu.getAttribute('label'), 'Upload PDF');
  for (const items of [[], [f.note]]) {
    win.select(items);
    win.show();
    assert.equal(win.menu.hidden, true);
    win.command();
  }
  assert.equal(win.calls.length, 0);
});

test('window unload and plugin shutdown remove legacy listeners, allow re-enable and never unregister an absent API', () => {
  const f = fixture(), first = f.addWindow(), second = f.addWindow();
  first.show();
  f.c.onMainWindowUnload({ window: first.window });
  assert.equal(first.popup.children.length, 0);
  first.show();
  first.command();
  assert.equal(first.calls.length, 0);
  assert.equal(second.popup.children.length, 1);
  f.c.shutdown({}, 0);
  assert.equal(second.popup.children.length, 0);
  assert.equal(f.c.sidebarWindows.size, 0);
  f.c.sidebarWindows.set(first.window, first.state);
  f.c.attachLegacyPDFContextMenu(first.window, first.state);
  assert.equal(first.popup.children.length, 1);
  f.c.shutdown({}, 0);
  assert.equal(first.popup.children.length, 0);
});

test('capability detection keeps Zotero 8–10 and backported MenuManager builds on the native path', () => {
  const f = fixture();
  const registrations = [];
  f.c.Zotero.MenuManager = {
    registerMenu: options => { registrations.push(options); return 'native'; }, unregisterMenu() {},
  };
  const win = f.addWindow();
  f.c.registerPDFContextMenu('chatgpt-web-sidebar-demo@local');
  f.c.registerPDFContextMenu('chatgpt-web-sidebar-demo@local');
  assert.equal(win.popup.children.length, 0);
  assert.equal(registrations.length, 1);
  // Zotero 10 throws on this old context field. The plugin must never read it.
  const menuElem = win.document.createElement('menuitem');
  const context = { menuElem, items: [f.files[0]], setVisible() {}, setEnabled() {},
    get collectionTreeRow() { throw new Error('removed in Zotero 10'); } };
  registrations[0].menus[0].onShowing(null, context);
  registrations[0].menus[0].onCommand(null, context);
  assert.deepEqual(Array.from(win.calls[0]), [f.files[0]]);
});
