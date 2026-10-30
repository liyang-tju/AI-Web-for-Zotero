const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(localName = '') { this.localName = localName; this.style = { setProperty(k, v) { this[k] = v; } }; this.attrs = {}; this.children = []; this.listeners = new Map(); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  prepend(node) { this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  loadURI(uri) { (this.loadedURLs ||= []).push(uri.spec); this.currentURI = uri; }
  reload() { this.reloads = (this.reloads || 0) + 1; }
  preserveLayers(value) { (this.preservedLayers ||= []).push(value); }
  openPopup() { this.emit('popupshown', { target: this }); }
  hidePopup() { this.emit('popuphidden', { target: this }); }
  select() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  addEventListener(k, fn) { if (!this.listeners.has(k)) this.listeners.set(k, new Set()); this.listeners.get(k).add(fn); }
  removeEventListener(k, fn) { this.listeners.get(k)?.delete(fn); }
  emit(k, e = {}) { for (const fn of [...(this.listeners.get(k) || [])]) fn(e); }
  getBoundingClientRect() { return { width: parseFloat(this.style.width) || 1200, right: 1200, left: 0, top: 40, bottom: 840, height: parseFloat(this.style.height) || 800 }; }
  focus() {}
  setPointerCapture(id) { this.pointer = id; }
  hasPointerCapture(id) { return this.pointer === id; }
  releasePointerCapture() { this.pointer = null; this.emit('lostpointercapture'); }
}

function fixture({ coverStyle = null, locale = 'zh-CN', language = '' } = {}) {
  const window = new Element();
  const elements = Object.fromEntries(['browser', 'appcontent', 'zotero-tabs-toolbar', 'zotero-tab-cover', 'menu_ToolsPopup'].map(id => [id, new Element()]));
  if (coverStyle !== null) elements['zotero-tab-cover'].setAttribute('style', coverStyle);
  elements['zotero-tab-cover'].setAttribute('class', 'hidden');
  elements.browser.append(elements.appcontent);
  elements.appcontent.append(elements['zotero-tab-cover']);
  window.innerWidth = 1200;
  window.innerHeight = 840;
  window.document = { getElementById: id => elements[id], createXULElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), documentElement: new Element() };
  window.Zotero_Tabs = { selectedID: 'reader' };
  let fitCount = 0;
  let pdfZoom = 1.35;
  const prefs = [];
  const stringPrefs = new Map();
  if (language) stringPrefs.set('extensions.chatgpt-web-sidebar-demo.language', language);
  const timers = new Map();
  let timerID = 0;
  window.setTimeout = fn => { timers.set(++timerID, fn); return timerID; };
  window.clearTimeout = id => timers.delete(id);
  const scope = vm.createContext({
    Zotero: { locale, Reader: { getByTabID: () => ({ itemID: 1, zoomPageWidth: () => { fitCount++; pdfZoom = 'page-width'; } }) }, Items: { get: () => ({ isPDFAttachment: () => true, libraryID: 1, key: "A", attachmentFilename: "A.pdf" }) }, logError: error => { throw error; } },
    Services: { io: { newURI: value => { const url = new URL(value); return { spec: url.href, host: url.hostname, scheme: url.protocol.slice(0, -1) }; } }, scriptSecurityManager: { getSystemPrincipal: () => ({}) }, prefs: { getStringPref: (key, fallback) => stringPrefs.get(key) ?? fallback, setStringPref: (key, value) => stringPrefs.set(key, value), getIntPref: (key, fallback) => fallback, getBoolPref: () => false, setBoolPref: () => {}, setIntPref: (key, value) => prefs.push(value) } },
  });
  vm.runInContext(['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n'), scope);
  scope.attachSidebar(window);
  const state = scope.sidebarWindows.get(window);
  state.loaded = true;
  state.popup.children[0].emit('command');
  timers.clear();
  const pointer = (x, y = 400) => ({ button: 0, pointerId: 1, screenX: x, screenY: y, preventDefault() {}, stopPropagation() {} });
  return { window, state, prefs, stringPrefs, pointer, elements, scope, fitCount: () => fitCount, pdfZoom: () => pdfZoom,
    flush: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}

test('continuous drag and internal resize notifications leave both pages stationary until release', () => {
  const f = fixture();
  f.state.divider.emit('pointerdown', f.pointer(600));
  for (const x of [500, 700, 400, 650, 550]) {
    f.state.divider.emit('pointermove', f.pointer(x));
    f.window.emit('resize', { target: f.window });
    f.flush();
    assert.equal(f.state.panel.style.width, '520px');
    assert.equal(f.fitCount(), 0);
    assert.equal(f.prefs.length, 0);
  }
  f.state.divider.emit('pointerup', f.pointer(550));
  assert.equal(f.state.panel.style.width, '570px');
  assert.deepEqual(f.prefs, [570]);
  f.flush();
  assert.equal(f.fitCount(), 0);
});

test('cancelled drag preserves saved width and removes the overlay', () => {
  const f = fixture();
  const count = f.window.document.documentElement.children.length;
  f.state.divider.emit('pointerdown', f.pointer(600));
  f.state.divider.emit('pointermove', f.pointer(300));
  f.state.divider.emit('pointercancel');
  f.flush();
  assert.equal(f.state.panel.style.width, '520px');
  assert.equal(f.window.document.documentElement.children.length, count);
  assert.equal(f.fitCount(), 0);
  assert.equal(f.prefs.length, 0);
});

test('right edge closes only on release and reopening restores the ordinary width', () => {
  const f = fixture();
  f.state.divider.emit('pointerdown', f.pointer(600));
  f.state.divider.emit('pointermove', f.pointer(1120));
  assert.equal(f.state.panel.hidden, false);
  f.state.divider.emit('pointerup', f.pointer(1120));
  assert.equal(f.state.panel.hidden, true);
  assert.equal(f.state.divider.hidden, true);
  assert.deepEqual(f.prefs, []);
  f.state.popup.children[0].emit('command');
  assert.equal(f.state.panel.hidden, false);
  assert.equal(f.state.panel.style.width, '520px');
});

test('left edge fills the content area and can be dragged back to split view', () => {
  const f = fixture();
  f.state.divider.emit('pointerdown', f.pointer(600));
  f.state.divider.emit('pointermove', f.pointer(-60));
  assert.equal(f.elements.appcontent.style.display, '');
  f.state.divider.emit('pointerup', f.pointer(-60));
  assert.equal(f.elements.appcontent.style.display, 'none');
  assert.equal(f.state.panel.style.width, '1188px');
  assert.equal(f.state.divider.hidden, false);
  f.flush();
  assert.equal(f.fitCount(), 0);
  assert.deepEqual(f.prefs, []);
  f.window.innerWidth = 1250;
  f.window.emit('resize', { target: f.window });
  assert.equal(f.elements.appcontent.style.display, 'none');
  f.state.divider.emit('pointerdown', f.pointer(6));
  f.state.divider.emit('pointerup', f.pointer(674));
  assert.equal(f.elements.appcontent.style.display, '');
  assert.equal(f.state.panel.style.width, '520px');
  f.flush();
  assert.equal(f.fitCount(), 0);
});

test('cancelling an edge preview does not collapse or maximize the panel', () => {
  for (const endpoint of [-60, 1120]) {
    const f = fixture();
    f.state.divider.emit('pointerdown', f.pointer(600));
    f.state.divider.emit('pointermove', f.pointer(endpoint));
    f.window.emit('keydown', { key: 'Escape', preventDefault() {} });
    assert.equal(f.state.panel.hidden, false);
    assert.equal(f.elements.appcontent.style.display, '');
    assert.equal(f.state.panel.style.width, '520px');
    assert.deepEqual(f.prefs, []);
  }
});

test('closing full view restores Zotero content and reopening uses the saved split width', () => {
  const f = fixture();
  f.state.divider.emit('pointerdown', f.pointer(600));
  f.state.divider.emit('pointerup', f.pointer(-60));
  f.state.popup.children[0].emit('command');
  assert.equal(f.elements.appcontent.style.display, '');
  f.state.popup.children[0].emit('command');
  assert.equal(f.state.panel.style.width, '520px');
});

test('bottom position keeps the browser and independently remembers height and width', () => {
  const f = fixture();
  const browser = f.state.browser;
  f.state.popup.children[2].emit('command');
  assert.equal(f.elements.browser.style['flex-direction'], 'column');
  assert.equal(f.state.divider.attrs['aria-orientation'], 'horizontal');
  assert.equal(f.state.panel.style.width, 'auto');
  assert.equal(f.state.panel.style.height, '400px');
  f.state.divider.emit('pointerdown', f.pointer(600, 440));
  f.state.divider.emit('pointermove', f.pointer(0, 340));
  assert.equal(f.state.panel.style.height, '400px');
  f.state.divider.emit('pointerup', f.pointer(0, 340));
  assert.equal(f.state.panel.style.height, '500px');
  f.state.popup.children[2].emit('command');
  assert.equal(f.state.panel.style.width, '520px');
  assert.equal(f.state.panel.style.height, 'auto');
  f.state.popup.children[2].emit('command');
  assert.equal(f.state.panel.style.height, '500px');
  assert.equal(f.state.browser, browser);
  assert.equal(f.state.loaded, true);
});

test('bottom drag supports top expansion and bottom collapse without losing split height', () => {
  const f = fixture();
  f.state.popup.children[2].emit('command');
  f.state.divider.emit('pointerdown', f.pointer(600, 440));
  f.state.divider.emit('pointerup', f.pointer(600, 50));
  assert.equal(f.state.panel.style.height, '788px');
  assert.equal(f.elements.appcontent.style.display, 'none');
  f.state.divider.emit('pointerdown', f.pointer(600, 46));
  f.state.divider.emit('pointerup', f.pointer(600, 830));
  assert.equal(f.state.panel.hidden, true);
  assert.equal(f.elements.appcontent.style.display, '');
  f.state.popup.children[0].emit('command');
  assert.equal(f.state.panel.style.height, '400px');
});


test('bookmark menu is read-only until the user explicitly chooses a saved conversation', () => {
  const f = fixture();
  f.scope.savePDFBookmarks([{ identity: '1:A', label: 'A.pdf' }], 'https://chatgpt.com/c/saved', '测试对话');
  const entries = f.state.popup.children.find(node => node.getAttribute('data-sidebar-menu') === 'bookmarks').children[0];
  entries.emit('popupshowing', { target: entries });
  assert.equal(entries.children.length, 1);
  assert.ok(f.state.popup.children.some(item => item.getAttribute('label') === '保存书签'));
  assert.equal(entries.children[0].getAttribute('tooltiptext'), null);
  assert.equal(entries.children[0].getAttribute('label'), '测试对话 · ChatGPT');
  assert.equal(f.state.browser.loadedURLs, undefined);
  f.window.emit('resize');
  f.flush();
  assert.equal(f.state.browser.loadedURLs, undefined);
  entries.children[0].children[0].children[0].emit('command');
  assert.deepEqual(f.state.browser.loadedURLs, ['https://chatgpt.com/c/saved']);
});


test('bookmark delete action removes the entry without navigating or deleting other bookmarks', () => {
  const f = fixture();
  f.scope.savePDFBookmarks([{ identity: '1:A' }, { identity: '1:B' }], 'https://chatgpt.com/c/shared');
  const entries = f.state.popup.children.find(node => node.getAttribute('data-sidebar-menu') === 'bookmarks').children[0];
  entries.emit('popupshowing', { target: entries });
  const remove = entries.children[0].children[0].children[1];
  assert.equal(remove.getAttribute('label'), '删除此书签');
  remove.emit('command');
  assert.equal(f.scope.readPDFBookmarks()['1:A'], undefined);
  assert.equal(f.scope.readPDFBookmarks()['1:B'].length, 1);
  assert.equal(f.state.browser.loadedURLs, undefined);
  entries.emit('popupshowing', { target: entries });
  assert.equal(entries.children[0].getAttribute('disabled'), 'true');
});

test('uploading a PDF no longer creates bookmarks or launches a conversation watcher', async () => {
  const f = fixture();
  f.scope.selectPDFAttachments = async () => [{ getFilePathAsync: async () => '/test.pdf' }];
  f.window.File = { createFromFileName: async () => ({ name: 'test.pdf' }) };
  f.state.browser.currentURI = { scheme: 'https', host: 'chatgpt.com', spec: 'https://chatgpt.com/c/existing' };
  f.state.browser.messageManager = { loadFrameScript: () => { throw new Error('must not start bookmark watcher'); } };
  f.scope.attachFilesToWebsite = async () => ({ ok: true });
  f.scope.savePDFBookmarks = () => { throw new Error('must not automatically save'); };
  const upload = [...f.state.popup.children[1].listeners.get('command')][0];
  await upload();
  assert.equal(f.state.uploading, false);
  assert.match(f.state.button.title, /已向网页提交/);
  assert.equal(Object.keys(f.scope.readPDFBookmarks()).length, 0);
});


test('export command uses the original parent and writes only after preview confirmation', async () => {
  const f = fixture();
  let currentID = 10;
  let confirm;
  let reached;
  const previewReached = new Promise(resolve => { reached = resolve; });
  let saves = 0;
  f.scope.Zotero.alert = () => {};
  f.scope.currentExportParent = () => ({ id: currentID, title: 'Original paper' });
  f.scope.requestConversationSnapshot = async () => ({ messages: [{ role: 'user', markdown: 'hello' }] });
  f.scope.previewConversation = async () => {
    currentID = 20;
    return new Promise(resolve => { confirm = resolve; reached(); });
  };
  f.scope.saveConversation = async (parent, snapshot, title, format) => { assert.equal(format, 'html'); assert.equal(parent.id, 10); assert.equal(snapshot.messages[0].markdown, 'selected'); saves++; };
  const item = f.state.popup.children.find(node => node.getAttribute('label') === '导出对话');
  const run = [...item.listeners.get('command')][0]();
  await previewReached;
  assert.equal(saves, 0);
  assert.equal(f.state.exporting, true);
  confirm({ title: 'Export', format: 'html', snapshot: { messages: [{ role: 'user', markdown: 'selected' }] } });
  await run;
  assert.equal(saves, 1);
  assert.equal(f.state.exporting, false);
});

test('website submenu navigates directly and persists home without discarding unrelated preferences', () => {
  const f = fixture();
  const store = new Map();
  f.scope.Services.io.newURI = value => { const u = new URL(value); return { spec: u.href, host: u.hostname, scheme: u.protocol.slice(0,-1) }; };
  f.scope.Services.prefs.getStringPref = (key, fallback) => store.get(key) ?? fallback;
  f.scope.Services.prefs.setStringPref = (key, value) => store.set(key, value);
  const sites = f.state.popup.children.find(node => node.getAttribute('label') === '切换网页').children[0];
  sites.children.find(node => node.getAttribute('label') === 'Gemini').emit('command');
  assert.equal(f.state.browser.loadedURLs.at(-1), 'https://gemini.google.com/app');
  assert.equal(f.state.button.textContent, 'Gemini ▾');
  assert.equal(f.scope.sidebarHomeURL(), 'https://gemini.google.com/app');
  assert.equal(f.state.panel.style.width, '520px');
  const home = f.state.popup.children.find(node => node.getAttribute('label') === '打开首页');
  home.emit('command');
  assert.equal(f.state.browser.loadedURLs.at(-1), 'https://gemini.google.com/app');
  assert.equal(store.size, 1);
});

test('saving a bookmark is a top-level command without hover text or automatic navigation', async () => {
  const f = fixture();
  let saves = 0;
  f.scope.Zotero.alert = () => {};
  f.scope.saveCurrentConversationBookmark = async () => { saves++; return 1; };
  const save = f.state.popup.children.find(node => node.getAttribute('label') === '保存书签');
  assert.ok(save);
  assert.equal(save.getAttribute('tooltiptext'), null);
  await [...save.listeners.get('command')][0]();
  assert.equal(saves, 1);
  assert.equal(f.state.browser.loadedURLs, undefined);
  f.state.uploading = true;
  await [...save.listeners.get('command')][0]();
  assert.equal(saves, 1);
});

test('bookmark labels show only chat title and provider without filename or URL tooltip', () => {
  const f = fixture();
  f.scope.savePDFBookmarks([{ identity: '1:A', label: 'Very long paper.pdf' }], 'https://gemini.google.com/app/abc', 'Discussion - Gemini');
  f.scope.savePDFBookmarks([{ identity: '1:A' }], 'https://aistudio.google.com/prompts/abc', 'Other - Google AI Studio');
  const entries = f.state.popup.children.find(node => node.getAttribute('data-sidebar-menu') === 'bookmarks').children[0];
  entries.emit('popupshowing', { target: entries });
  assert.deepEqual(entries.children.map(node => node.getAttribute('label')), ['Discussion · Gemini', 'Other · Google AI Studio']);
  assert.ok(entries.children.every(node => node.getAttribute('tooltiptext') === null));
});

test('manual PDF zoom survives sidebar drag, position changes, collapse, expansion and window resizing', () => {
  const f = fixture();
  const unchanged = () => {
    f.flush();
    assert.equal(f.pdfZoom(), 1.35);
    assert.equal(f.fitCount(), 0);
  };
  unchanged();
  f.state.divider.emit('pointerdown', f.pointer(600));
  f.state.divider.emit('pointerup', f.pointer(550));
  unchanged();
  f.state.divider.emit('dblclick');
  unchanged();
  f.state.divider.emit('keydown', { key: 'ArrowLeft', preventDefault() {} });
  unchanged();
  f.state.divider.emit('pointerdown', f.pointer(600));
  f.state.divider.emit('pointerup', f.pointer(-60));
  assert.equal(f.elements.appcontent.style.display, 'none');
  unchanged();
  f.state.popup.children[0].emit('command');
  f.state.popup.children[0].emit('command');
  unchanged();
  f.state.popup.children[2].emit('command');
  f.state.divider.emit('pointerdown', f.pointer(600, 440));
  f.state.divider.emit('pointerup', f.pointer(600, 350));
  unchanged();
  f.window.innerWidth = 900;
  f.window.innerHeight = 700;
  f.window.emit('resize', { target: f.window });
  unchanged();
  f.state.popup.children[2].emit('command');
  unchanged();
});

test('reader loading cover is bounded by native content and restored when the addon is removed', () => {
  for (const coverStyle of [null, 'opacity:0.9']) {
    const f = fixture({ coverStyle });
    const cover = f.elements['zotero-tab-cover'];
    assert.equal(f.elements.appcontent.style.position, 'relative');
    assert.equal(cover.style.position, 'absolute');
    assert.equal(cover.style.inset, '0');
    assert.equal(cover.style.height, 'auto');
    assert.equal(cover.getAttribute('class'), 'hidden');
    assert.equal(cover.parent, f.elements.appcontent);
    assert.equal(f.state.panel.parent, f.elements.browser);
    f.scope.removeSidebar(f.window);
    assert.equal(cover.getAttribute('style'), coverStyle);
    assert.equal(f.elements.appcontent.getAttribute('style'), null);
    assert.equal(f.scope.sidebarWindows.size, 0);
  }
});

test('tab selection, focus changes and repeated attachment keep the sidebar instance and layout', () => {
  const f = fixture();
  const browser = f.state.browser;
  browser.currentURI = { spec: 'https://chatgpt.com/c/discussion' };
  for (const id of ['reader-A', 'reader-B', 'zotero-pane', 'reader-A']) {
    f.window.Zotero_Tabs.selectedID = id;
    f.elements.appcontent.emit('tab-selection-change', { detail: { selected: true } });
    f.window.emit('blur');
    f.window.emit('focus');
    f.window.emit('resize', { target: f.window });
    f.scope.attachSidebar(f.window);
    f.flush();
    assert.equal(f.scope.sidebarWindows.get(f.window).browser, browser);
    assert.equal(browser.loadedURLs, undefined);
    assert.equal(browser.reloads, undefined);
    assert.equal(f.state.panel.style.width, '520px');
    assert.equal(f.fitCount(), 0);
  }
});

test('toolbar and Tools menus share the requested groups and website submenu', () => {
  const f = fixture();
  const expected = ['打开 / 收起网页', '上传当前 PDF', '在底部显示', null,
    '打开首页', '刷新网页', '切换网页', null, '导出对话', '保存书签', '对话书签', null, 'Language'];
  for (const popup of [f.state.popup, f.state.menu.children[0]]) {
    assert.deepEqual(popup.children.map(item => item.getAttribute('label')), expected);
    const menu = popup.children[6];
    assert.equal(menu.localName, 'menu');
    assert.deepEqual(menu.children[0].children.map(item => item.getAttribute('label')),
      ['ChatGPT', 'Gemini', 'Google AI Studio', 'DeepSeek', 'Kimi', 'GLM / 智谱清言', null, '自定义网址…']);
  }
});

test('current website choice preserves conversation while explicit Home and Refresh still work', () => {
  const f = fixture();
  f.scope.Services.io.newURI = value => { const u = new URL(value); return { spec: u.href, host: u.hostname, scheme: u.protocol.slice(0, -1) }; };
  f.state.browser.currentURI = { spec: 'https://gemini.google.com/app/discussion' };
  const sites = f.state.popup.children[6].children[0];
  sites.emit('popupshowing', { target: sites });
  assert.equal(sites.children[1].getAttribute('checked'), 'true');
  assert.equal(sites.children[0].getAttribute('checked'), 'false');
  sites.children[1].emit('command');
  assert.equal(f.state.browser.loadedURLs, undefined);
  assert.equal(f.scope.sidebarHomeURL(), 'https://gemini.google.com/app');
  f.state.popup.children[4].emit('command');
  assert.deepEqual(f.state.browser.loadedURLs, ['https://gemini.google.com/app']);
  f.state.popup.children[5].emit('command');
  assert.equal(f.state.browser.reloads, 1);
});

test('site switching is blocked during upload, export or bookmark selection and opens a closed panel once', () => {
  const f = fixture();
  const sites = f.state.popup.children[6].children[0];
  const customCount = () => f.window.document.documentElement.children.length;
  const count = customCount();
  for (const flag of ['uploading', 'exporting', 'savingBookmark']) {
    f.state[flag] = true;
    sites.emit('popupshowing', { target: sites });
    assert.equal(sites.children[1].getAttribute('disabled'), 'true');
    sites.children[1].emit('command');
    sites.children.at(-1).emit('command');
    assert.equal(f.state.browser.loadedURLs, undefined);
    assert.equal(customCount(), count);
    f.state[flag] = false;
  }
  f.state.popup.children[0].emit('command');
  f.state.loaded = false;
  sites.children[1].emit('command');
  assert.equal(f.state.panel.hidden, false);
  assert.deepEqual(f.state.browser.loadedURLs, ['https://gemini.google.com/app']);
});

test('custom URL popover validates, opens and cancels without a settings window', () => {
  const f = fixture();
  f.scope.Services.io.newURI = value => { const u = new URL(value); return { spec: u.href, host: u.hostname, scheme: u.protocol.slice(0, -1) }; };
  const custom = f.state.popup.children[6].children[0].children.at(-1);
  const popover = () => f.window.document.documentElement.children.find(node => node.id === 'ai-sidebar-url-input');
  custom.emit('command');
  const panel = popover();
  assert.equal(panel.localName, 'panel');
  const input = panel.children[0].children[0].children[0];
  const error = panel.children[0].children[1];
  const submit = panel.children[0].children[2].children[1];
  input.value = 'file:///secret';
  submit.emit('click');
  assert.ok(error.textContent);
  assert.equal(f.state.browser.loadedURLs, undefined);
  assert.equal(popover(), panel);
  input.value = 'https://example.org/chat';
  input.emit('keydown', { key: 'Enter', preventDefault() {} });
  assert.deepEqual(f.state.browser.loadedURLs, ['https://example.org/chat']);
  assert.equal(f.scope.sidebarHomeURL(), 'https://example.org/chat');
  assert.equal(popover(), undefined);
  custom.emit('command');
  popover().hidePopup();
  assert.equal(f.state.cancelSiteInput, null);
  assert.equal(popover(), undefined);
  assert.equal(f.state.browser.loadedURLs.length, 1);
  custom.emit('command');
  f.scope.removeSidebar(f.window);
  assert.equal(popover(), undefined);
});

test('closing a nested menu does not mark the main menu as closed', () => {
  const f = fixture();
  f.state.popup.emit('popupshown', { target: f.state.popup });
  f.state.popup.emit('popuphidden', { target: f.state.popup.children[6].children[0] });
  assert.equal(f.state.button.getAttribute('aria-expanded'), 'true');
  f.state.popup.emit('popuphidden', { target: f.state.popup });
  assert.equal(f.state.button.getAttribute('aria-expanded'), 'false');
});

test('UI language follows Zotero until a valid explicit preference is saved', () => {
  for (const [locale, label] of [['zh-CN', '导出对话'], ['zh-TW', '导出对话'], ['en-US', 'Export conversation'], ['de-DE', 'Export conversation']]) {
    const f = fixture({ locale });
    assert.equal(f.state.popup.children[8].getAttribute('label'), label);
    assert.equal(f.stringPrefs.has(f.scope.SIDEBAR_LANGUAGE_PREF), false);
  }
  const overridden = fixture({ locale: 'zh-CN', language: 'en' });
  assert.equal(overridden.state.popup.children[8].getAttribute('label'), 'Export conversation');
  const invalid = fixture({ locale: 'zh-CN', language: 'invalid' });
  assert.equal(invalid.state.popup.children[8].getAttribute('label'), '导出对话');
  // Use Zotero's resolved UI locale, not a different system/browser fallback.
  invalid.scope.Services.locale = { appLocaleAsBCP47: 'en-US' };
  assert.equal(invalid.scope.sidebarLanguage(), 'zh-CN');
  delete invalid.scope.Zotero.locale;
  assert.equal(invalid.scope.sidebarLanguage(), 'en');
});

test('language menu uses autonyms, remembers choice and relabels both menus without navigation', () => {
  const f = fixture();
  f.scope.savePDFBookmarks([{ identity: '1:A' }], 'https://chatgpt.com/c/kept', '保留原始标题');
  const savedBookmarks = f.scope.Services.prefs.getStringPref(f.scope.BOOKMARK_PREF);
  const language = f.state.popup.children.at(-1);
  const choices = language.children[0].children;
  assert.equal(language.getAttribute('label'), 'Language');
  assert.equal(language.getAttribute('lang'), 'en');
  assert.deepEqual(choices.map(node => node.getAttribute('label')), ['简体中文', 'English']);
  assert.deepEqual(choices.map(node => node.getAttribute('lang')), ['zh-CN', 'en']);
  assert.equal(choices[0].getAttribute('checked'), 'true');
  const browser = f.state.browser;
  const size = f.state.panel.style.width;
  let otherWindowUpdates = 0;
  const otherWindow = {};
  f.scope.sidebarWindows.set(otherWindow, { refreshLocale: () => otherWindowUpdates++ });
  choices[1].emit('command');
  assert.equal(f.scope.sidebarLanguage(), 'en');
  assert.equal(language.getAttribute('label'), '语言');
  assert.equal(language.getAttribute('lang'), 'zh-CN');
  assert.equal(choices[1].getAttribute('checked'), 'true');
  for (const popup of [f.state.popup, f.state.menu.children[0]]) {
    assert.equal(popup.children[0].getAttribute('label'), 'Show / hide webpage');
    assert.equal(popup.children[8].getAttribute('label'), 'Export conversation');
    assert.equal(popup.children[9].getAttribute('label'), 'Save bookmark');
    assert.equal(popup.children.at(-1).getAttribute('label'), '语言');
  }
  assert.equal(f.state.browser, browser);
  assert.equal(browser.loadedURLs, undefined);
  assert.equal(browser.reloads, undefined);
  assert.equal(f.state.panel.style.width, size);
  assert.equal(f.scope.Services.prefs.getStringPref(f.scope.BOOKMARK_PREF), savedBookmarks);
  assert.equal(otherWindowUpdates, 1);
  // Manual override survives a different Zotero language on the next startup.
  assert.equal(fixture({ locale: 'zh-CN', language: f.scope.sidebarLanguage() }).scope.sidebarLanguage(), 'en');
  choices[0].emit('command');
  assert.equal(language.getAttribute('label'), 'Language');
  assert.equal(f.state.popup.children[8].getAttribute('label'), '导出对话');
  assert.equal(browser.loadedURLs, undefined);
});

test('all menu rows reserve equal-sized icons and requested actions use their semantic icons', () => {
  const f = fixture();
  const check = node => {
    if (['menu', 'menuitem'].includes(node.localName)) {
      assert.equal(node.getAttribute('class'), node.localName === 'menu' ? 'menu-iconic' : 'menuitem-iconic');
      assert.match(node.getAttribute('image'), /icons\/[a-z]+\.svg$/);
      const name = node.getAttribute('image').split('/').at(-1);
      const svg = fs.readFileSync(`${__dirname}/../addon/icons/${name}`, 'utf8');
      assert.match(svg, /width="16" height="16"/);
    }
    node.children.forEach(check);
  };
  check(f.state.popup);
  check(f.state.menu);
  assert.match(f.state.popup.children[1].getAttribute('image'), /upload\.svg$/);
  assert.match(f.state.popup.children[6].getAttribute('image'), /switch\.svg$/);
  assert.match(f.state.popup.children[8].getAttribute('image'), /share\.svg$/);
  assert.match(f.state.popup.children[9].getAttribute('image'), /bookmark\.svg$/);
  assert.match(f.state.popup.children.at(-1).getAttribute('image'), /language\.svg$/);
  assert.match(f.state.popup.children[0].getAttribute('image'), /blank\.svg$/);
});

test('missing user and assistant roles produces only the requested brief localized alert', () => {
  const f = fixture();
  const alerts = [];
  f.scope.Zotero.alert = (_, title, message) => alerts.push({ title, message });
  const document = { querySelectorAll: () => [] };
  const adapter = f.scope.siteAdapter('https://gemini.google.com/app/chat');
  let error;
  try { f.scope.collectConversationSnapshot(document, adapter); } catch (reason) { error = reason; }
  assert.equal(error.message, '未能同时识别用户消息和 AI 回复');
  f.scope.sidebarAlert(f.window, '导出对话', error.message);
  assert.deepEqual(alerts[0], { title: '导出对话', message: '未能同时识别用户消息和 AI 回复' });
  f.scope.setSidebarLanguage('en');
  f.scope.sidebarAlert(f.window, '导出对话', error.message);
  assert.deepEqual(alerts[1], { title: 'Export conversation', message: 'Could not identify both user messages and AI replies' });
});

test('context upload sends the selected library PDF into the existing chat and opens the panel', async () => {
  const f = fixture();
  f.state.browser.currentURI = { spec: 'https://chatgpt.com/c/existing' };
  f.state.panel.hidden = true;
  const file = { id: 2, isPDFAttachment: () => true, getField: () => 'B.pdf',
    attachmentFilename: 'B.pdf', getFilePathAsync: async () => '/fake/B.pdf' };
  const submitted = [];
  f.window.File = { createFromFileName: async path => ({ name: path.split('/').at(-1) }) };
  f.scope.attachFilesToWebsite = async (window, state, files) => {
    assert.equal(window, f.window);
    assert.equal(state, f.state);
    submitted.push(...files);
    return { ok: true };
  };
  await f.state.uploadSelectedPDFs([file]);
  assert.deepEqual(submitted.map(file => file.name), ['B.pdf']);
  assert.equal(f.state.panel.hidden, false);
  assert.equal(f.state.browser.currentURI.spec, 'https://chatgpt.com/c/existing');
  assert.equal(f.state.browser.loadedURLs, undefined);
  assert.equal(f.state.uploading, false);
});

test('toolbar command event is not mistaken for an explicit PDF selection', async () => {
  const f = fixture();
  f.state.browser.currentURI = { spec: 'https://chatgpt.com/c/existing' };
  const selections = [];
  f.scope.selectPDFAttachments = async (_window, purpose, items) => { selections.push({ purpose, items }); return null; };
  await [...f.state.popup.children[1].listeners.get('command')][0]({ type: 'command' });
  assert.equal(selections[0].purpose, 'upload');
  assert.equal(selections[0].items, null);
});

test('visible webpage retains its painted layers across window focus changes and releases them on close', () => {
  const f = fixture();
  const browser = f.state.browser;
  browser.frameLoader = { remoteTab: {} };
  browser.emit('XULFrameLoaderCreated');
  assert.deepEqual(browser.preservedLayers, [true]);
  const width = f.state.panel.style.width;
  for (const type of ['blur', 'deactivate', 'activate', 'focus']) f.window.emit(type, { target: f.window });
  assert.equal(browser.loadedURLs, undefined);
  assert.equal(browser.reloads, undefined);
  assert.equal(f.state.panel.style.width, width);
  f.state.popup.children[0].emit('command');
  assert.equal(browser.preservedLayers.at(-1), false);
  f.state.popup.children[0].emit('command');
  assert.equal(browser.preservedLayers.at(-1), true);
  f.scope.removeSidebar(f.window);
  assert.equal(browser.preservedLayers.at(-1), false);
  assert.equal(browser.listeners.get('XULFrameLoaderCreated').size, 0);
});
