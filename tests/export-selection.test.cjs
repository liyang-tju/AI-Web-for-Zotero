const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const c = vm.createContext({});
vm.runInContext(['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n'), c);

test('round selection retains answer continuations and original chronological order without mutating the source', () => {
  const snapshot = { messages: [
    { role: 'assistant', markdown: 'loaded fragment' },
    { role: 'user', markdown: 'Q1' }, { role: 'assistant', markdown: 'A1' }, { role: 'assistant', markdown: 'A1 continued' },
    { role: 'user', markdown: 'Q2' }, { role: 'assistant', markdown: 'A2' },
    { role: 'user', markdown: 'unanswered' },
  ] };
  const before = JSON.stringify(snapshot);
  const result = c.selectConversationRounds(snapshot, new Set([3, 1]));
  assert.deepEqual(Array.from(result.messages, message => message.markdown), ['Q1', 'A1', 'A1 continued', 'unanswered']);
  assert.deepEqual(Array.from(result.selection.rounds), [2, 4]);
  assert.equal(JSON.stringify(snapshot), before);
  assert.throws(() => c.selectConversationRounds(snapshot, new Set()), /至少选择/);
});

test('bracket math becomes dollar math and existing dollar formulas and prices stay unchanged', () => {
  const input = String.raw`行内 \( \Delta G = -RT\ln K \)，价格 $5 和 $10，已有 $x$ 与 $$y$$。
\[
\begin{aligned}
a &= b \\
c &= d
\end{aligned}
\]`;
  const result = c.normalizeMarkdownMath(input);
  assert.match(result, /行内 \$\\Delta G = -RT\\ln K\$/);
  assert.match(result, /价格 \$5 和 \$10，已有 \$x\$ 与 \$\$y\$\$/);
  assert.ok(result.includes('$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$'));
  assert.equal(c.normalizeMarkdownMath(result), result);
});

test('fenced code, longer fences, tilde blocks, indented code and inline code remain byte-for-byte unchanged', () => {
  const protectedParts = [
    '```python\nprint("\\(x\\)")\n```',
    '````md\n```\n\\[a\\]\n```\n````',
    '~~~tex\n\\[b\\]\n~~~',
    '    literal \\(c\\)\n',
    '`\\(d\\)`',
    '``tick ` \\(e\\)``',
    '```unclosed\n\\[f\\]',
  ];
  for (const part of protectedParts) assert.equal(c.normalizeMarkdownMath(part), part);
  const mixed = '`\\(code\\)` then \\(x\\)\n~~~\n\\[code\\]\n~~~\n\\[y\\]';
  const result = c.normalizeMarkdownMath(mixed);
  assert.ok(result.includes('`\\(code\\)` then $x$'));
  assert.ok(result.includes('~~~\n\\[code\\]\n~~~'));
  assert.ok(result.includes('$$\ny\n$$'));
});

test('escaped brackets and unmatched delimiters are preserved and only complete formulas convert', () => {
  const literal = String.raw`\\(literal\\) and \\[literal\\] and \(unfinished`;
  assert.equal(c.normalizeMarkdownMath(literal), literal);
  assert.equal(c.normalizeMarkdownMath(String.raw`\(x\) + \(y\)`), '$x$ + $y$');
});

test('final saved Markdown normalizes formulas as well as preview data', () => {
  const snapshot = { url: 'https://chatgpt.com/c/test', capturedAt: '2026-10-26', messages: [
    { role: 'user', markdown: String.raw`解释 \(E\)` }, { role: 'assistant', markdown: String.raw`\[E=mc^2\]` },
  ] };
  const subset = c.selectConversationRounds(snapshot, new Set([0]));
  assert.equal(subset.messages[0].markdown, '解释 $E$');
  const file = c.conversationMarkdown({ title: '文献' }, subset, '公式');
  assert.ok(file.includes('$$\nE=mc^2\n$$'));
  assert.doesNotMatch(file, /\\\[|\\\(/);
});

test('PDF citation markers disappear while web links, ordinary references and filenames remain', () => {
  const input = '结论 fileciteturn0file0。另一处citeturn2file1。旧引用【12:3†paper.pdf】。\n\n[来源](https://example.org) citeturn0search1 [1] 【11†PrintWiki】 paper.pdf';
  assert.equal(c.normalizeExportMarkdown(input), '结论。另一处。旧引用。\n\n[来源](https://example.org) citeturn0search1 [1] 【11†PrintWiki】 paper.pdf');
});

test('standalone formulas do not gain extra blank lines and excessive exterior spacing is compacted', () => {
  assert.equal(c.normalizeExportMarkdown('前文\n\\[a\\]\n\\[b\\]\n后文'), '前文\n$$\na\n$$\n$$\nb\n$$\n后文');
  const input = '前文\n\n\n\\[a\\]\n\n \n\n\\[b\\]\n\n\n后文';
  const expected = '前文\n\n$$\na\n$$\n\n$$\nb\n$$\n\n后文';
  assert.equal(c.normalizeExportMarkdown(input), expected);
  assert.equal(c.normalizeExportMarkdown(expected), expected);
});

test('cleanup preserves code examples, hard breaks and LaTeX internal line breaks', () => {
  const code = '````md\nfileciteturn0file0\n\n\n\\[code\\]\n````';
  const inline = '`fileciteturn0file0`';
  const mathBody = '\\begin{aligned}\n    a &= b \\\\\n\n\n    c &= d\n\\end{aligned}';
  const input = `${code}\n\n${inline}\n\n\\[${mathBody}\\]\n\n保留  \n换行`;
  const output = c.normalizeExportMarkdown(input);
  assert.ok(output.includes(code));
  assert.ok(output.includes(inline));
  assert.ok(output.includes(`$$\n${mathBody}\n$$`));
  assert.ok(output.endsWith('保留  \n换行'));
  assert.equal(c.normalizeExportMarkdown(output), output);
});

test('minimal cleanup leaves headings, lists, tables and scientific punctuation unchanged', () => {
  const markdown = '# 标题\n\n3. CO–CO\n4. **结论**\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n> 原文\n\n价格 $5，变量 $x$';
  assert.equal(c.normalizeExportMarkdown(markdown), markdown);
});

test('metadata file markers are removed in both selected preview content and final export only outside code', () => {
  const snapshot = { url: 'https://chatgpt.com/c/test', capturedAt: '2026-10-26', messages: [
    { role: 'user', markdown: '附件：\n- paper.pdf' },
    { role: 'assistant', markdown: '结论 CUSTOM_FILE。`CUSTOM_FILE`', fileCitationMarkers: ['CUSTOM_FILE'] },
  ] };
  const subset = c.selectConversationRounds(snapshot, new Set([0]));
  assert.equal(subset.messages[1].markdown, '结论。`CUSTOM_FILE`');
  const md = c.conversationMarkdown({ title: '文献' }, snapshot, '讨论');
  assert.ok(md.includes('结论。`CUSTOM_FILE`'));
  assert.ok(md.includes('附件：\n- paper.pdf'));
});

test('blank lines within indented code remain unchanged', () => {
  const code = '    first\n\n\n    second\n';
  assert.equal(c.normalizeExportMarkdown(code), code);
});
