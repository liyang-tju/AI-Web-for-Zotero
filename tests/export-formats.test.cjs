const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const addon = path.join(__dirname, '../addon');

function fixture() {
  const saved = [], snapshots = [], loads = [];
  const library = { editable: true, filesEditable: true };
  const parentItem = { libraryID: 5, isRegularItem: () => true };
  const c = vm.createContext({ Zotero: {
    Items: { get: id => id === 42 ? parentItem : null }, Libraries: { get: () => library },
    Item: class {
      constructor(type) { this.type = type; }
      setNote(value) { this.note = value; }
      async saveTx() { saved.push(this); }
    },
    Attachments: { importFromSnapshotContent: async options => { snapshots.push(options); return { id: 99 }; } },
  }, Services: { scriptloader: { loadSubScript: (file, scope) => {
    if (!vm.isContext(scope)) vm.createContext(scope);
    loads.push(file);
    vm.runInContext(fs.readFileSync(file, 'utf8'), scope);
  } } } });
  vm.runInContext(['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(path.join(addon, file), 'utf8')).join('\n'), c);
  c.addonRootURI = addon + '/';
  const parent = { id: 42, title: '研究 <一>' };
  const snapshot = { url: 'https://chatgpt.com/c/test', messages: [
    { role: 'user', markdown: '分析 $E$，价格 $5 和 $10。' },
    { role: 'assistant', markdown: '# 结论\n\n**结果**fileciteturn0file0\n\n$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- first\n- second\n\n```python\nprint("<tag>")\n```\n\n[来源](https://example.org)' },
  ] };
  return { c, parent, snapshot, saved, snapshots, loads, library, parentItem };
}

test('bundled libraries load once and static HTML preserves formatted text, table, code and MathML', () => {
  const f = fixture();
  const html = f.c.renderConversationRichText(f.parent, f.snapshot, '讨论 <标题>', 'html');
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /研究 &lt;一&gt;/);
  assert.match(html, /<strong>结果<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul>/);
  assert.match(html, /class="language-python"/);
  assert.match(html, /<math[^>]+xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html, /<mtable/);
  assert.match(html, /价格 \$5 和 \$10/);
  assert.match(html, /href="https:\/\/example.org"/);
  assert.doesNotMatch(html, /filecite|提取范围|本文件按会话|<script|<link/);
  f.c.renderConversationRichText(f.parent, f.snapshot, '第二次', 'note');
  assert.equal(f.loads.length, 3);
});

test('native note uses Zotero schema and editable LaTeX nodes rather than dollar source as plain text', async () => {
  const f = fixture();
  await f.c.saveConversation(f.parent, f.snapshot, '讨论', 'note');
  assert.equal(f.saved.length, 1);
  const item = f.saved[0];
  assert.equal(item.type, 'note');
  assert.equal(item.libraryID, 5);
  assert.equal(item.parentID, 42);
  assert.match(item.note, /^<div data-schema-version="9">/);
  assert.match(item.note, /<span class="math">\$E\$<\/span>/);
  assert.match(item.note, /<pre class="math">\$\$\\begin\{aligned\}/);
  assert.match(item.note, /a &amp;= b \\\\\nc &amp;= d/);
  assert.doesNotMatch(item.note, /<math |<style|<script|提取范围|本文件/);
  assert.equal(f.snapshots.length, 0);
});

test('HTML imports as an actual snapshot under the fixed parent with its original conversation URL', async () => {
  const f = fixture();
  await f.c.saveConversation(f.parent, f.snapshot, '讨论', 'html');
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.snapshots[0].parentItemID, 42);
  assert.equal(f.snapshots[0].title, '讨论.html');
  assert.equal(f.snapshots[0].url, f.snapshot.url);
  assert.match(f.snapshots[0].snapshotContent, /<body>/);
  assert.equal(f.saved.length, 0);
});

test('file permissions do not block notes but protect HTML; read-only and deleted targets cannot save', async () => {
  const f = fixture();
  f.library.filesEditable = false;
  await f.c.saveConversation(f.parent, f.snapshot, '讨论', 'note');
  await assert.rejects(f.c.saveConversation(f.parent, f.snapshot, '讨论', 'html'), /文件附件/);
  f.library.editable = false;
  await assert.rejects(f.c.saveConversation(f.parent, f.snapshot, '讨论', 'note'), /不允许编辑/);
  f.library.editable = true;
  f.parentItem.deleted = true;
  await assert.rejects(f.c.saveConversation(f.parent, f.snapshot, '讨论', 'note'), /已删除/);
  assert.equal(f.saved.length, 1);
  assert.equal(f.snapshots.length, 0);
});

test('HTML and notes escape active content, suppress remote images and preserve literal code', () => {
  const f = fixture();
  f.snapshot.messages = [{ role: 'assistant', markdown: '<script>alert(1)</script>\n\n![tracking](https://evil.example/image.png)\n\n[evil](javascript:alert(1))\n\n$\\href{javascript:alert(1)}{x}$\n\n`$code$`\n\n```tex\n$$not math$$\n```' }];
  for (const format of ['html', 'note']) {
    const html = f.c.renderConversationRichText(f.parent, f.snapshot, '安全', format);
    assert.doesNotMatch(html, /<script|<img|href="javascript:|src="https:/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /\[图片：tracking\]/);
    assert.match(html, /<code>\$code\$<\/code>/);
    assert.match(html, /\$\$not math\$\$/);
  }
});

test('selected rounds stay selected in both rich-text formats and unsupported math retains its source', () => {
  const f = fixture();
  f.snapshot.messages.push({ role: 'user', markdown: 'EXCLUDED' });
  const selected = f.c.selectConversationRounds(f.snapshot, new Set([0]));
  for (const format of ['html', 'note']) {
    assert.doesNotMatch(f.c.renderConversationRichText(f.parent, selected, '选择', format), /EXCLUDED/);
  }
  f.snapshot.messages = [{ role: 'assistant', markdown: '$\\unknowncommand{x}$' }];
  assert.match(f.c.renderConversationRichText(f.parent, f.snapshot, '公式', 'html'), /unknowncommand/);
});


test('native save and snapshot import failures propagate without reporting success', async () => {
  const f = fixture();
  f.c.Zotero.Item.prototype.saveTx = async () => { throw new Error('note save failed'); };
  await assert.rejects(f.c.saveConversation(f.parent, f.snapshot, '讨论', 'note'), /note save failed/);
  f.c.Zotero.Attachments.importFromSnapshotContent = async () => { throw new Error('snapshot import failed'); };
  await assert.rejects(f.c.saveConversation(f.parent, f.snapshot, '讨论', 'html'), /snapshot import failed/);
  await assert.rejects(f.c.saveConversation(f.parent, f.snapshot, '讨论', 'invalid'), /未知保存格式/);
  assert.equal(f.saved.length + f.snapshots.length, 0);
});
