const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');

function fixture(failRender = false, locale = 'zh-CN') {
  const nodes = [];
  const events = {};
  let focused;
  function node(namespace, tag) {
    const element = { tag, style: {}, children: [], handlers: {}, attributes: {},
      append(...children) { this.children.push(...children); },
      remove() { this.removed = true; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      focus() { focused = this; }, getClientRects: () => [{}],
      querySelectorAll: () => nodes.filter(n => ['button', 'input', 'summary'].includes(n.tag) && !n.disabled) };
    nodes.push(element);
    return element;
  }
  const previous = node(null, 'previous');
  const documentElement = node(null, 'root');
  if (failRender) documentElement.append = () => { throw new Error('render failed'); };
  const doc = { documentElement, createElementNS: node, get activeElement() { return focused || previous; } };
  const window = { document: doc,
    openDialog() { throw new Error('native modal must not be opened'); },
    addEventListener(event, handler) { events[event] = handler; },
    removeEventListener(event) { delete events[event]; } };
  const c = vm.createContext({ Zotero: { locale } });
  vm.runInContext(source, c);
  const groups = [
    { title: 'A', files: [{ id: 1, label: 'main.pdf' }, { id: 2, label: 'supplement.pdf' }] },
    { title: 'B', files: [{ id: 3, label: 'B.pdf' }] },
    { title: 'C', files: [] },
  ];
  const promise = c.choosePDFs(window, groups);
  const button = label => nodes.find(n => n.tag === 'button' && n.textContent === label);
  const details = nodes.filter(n => n.tag === 'details');
  const parent = i => details[i].children[0].children[0].children[0];
  const child = (i, j) => details[i].children[1].children[j].children[0].children[0];
  return { c, window, events, nodes, promise, button, details, parent, child, previous, focused: () => focused };
}

test('English Zotero uses English picker controls while preserving attachment names', async () => {
  const f = fixture(false, 'en-US');
  assert.ok(f.button('Select all'));
  assert.ok(f.button('Deselect all'));
  assert.ok(f.nodes.some(node => node.textContent === 'main.pdf'));
  f.button('Deselect all').handlers.click();
  assert.equal(f.button('Add 0 PDFs').disabled, true);
  f.button('Select all').handlers.click();
  f.button('Add 3 PDFs').handlers.click();
  assert.deepEqual(Array.from(await f.promise), [1, 2, 3]);
});

test('picker is rendered immediately without a native modal and resolves only on confirmation', async () => {
  const f = fixture();
  assert.equal(f.details.length, 3);
  assert.equal(f.parent(2).disabled, true);
  assert.equal(f.c.pendingPDFPickers.size, 1);
  let settled = false;
  f.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  f.child(0, 1).checked = false;
  f.child(0, 1).handlers.change();
  assert.equal(f.parent(0).indeterminate, true);
  f.parent(0).checked = false;
  f.parent(0).handlers.change();
  assert.equal(f.child(0, 0).checked, false);
  f.button('取消全选').handlers.click();
  assert.equal(f.button('添加 0 个 PDF').disabled, true);
  f.button('添加 0 个 PDF').handlers.click();
  assert.equal(f.c.pendingPDFPickers.size, 1);
  f.button('全选').handlers.click();
  assert.equal(f.parent(0).indeterminate, false);
  f.button('添加 3 个 PDF').handlers.click();
  assert.deepEqual(Array.from(await f.promise), [1, 2, 3]);
  assert.equal(f.c.pendingPDFPickers.size, 0);
  assert.equal(f.focused(), f.previous);
  assert.deepEqual(Object.keys(f.events), []);
});

test('cancel, Escape, window unload and plugin cleanup all settle selection and remove overlay', async () => {
  for (const action of ['cancel', 'escape', 'unload', 'cleanup']) {
    const f = fixture();
    if (action === 'cancel') f.button('取消').handlers.click();
    if (action === 'escape') f.events.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    if (action === 'unload') f.events.unload();
    if (action === 'cleanup') f.c.removeSidebar(f.window);
    assert.equal(await f.promise, null);
    assert.equal(f.nodes.find(n => n.id === 'chatgpt-pdf-picker').removed, true);
    assert.equal(f.c.pendingPDFPickers.size, 0);
    assert.deepEqual(Object.keys(f.events), []);
  }
});

test('render errors reject selection instead of leaving upload waiting', async () => {
  const f = fixture(true);
  await assert.rejects(f.promise, /无法显示 PDF 选择框.*render failed/);
  assert.equal(f.c.pendingPDFPickers.size, 0);
  assert.equal(f.nodes.find(n => n.id === 'chatgpt-pdf-picker').removed, true);
});
