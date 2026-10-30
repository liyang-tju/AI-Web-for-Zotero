const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js']
  .map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');

function snapshot(html, url = 'https://www.kimi.com/chat/test') {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  window.Element.prototype.getClientRects = () => [{}];
  document.location = { href: url };
  const context = vm.createContext({});
  vm.runInContext(source, context);
  // This function is serialized into the webpage frame, without host helpers.
  const collect = vm.runInNewContext(`(${context.collectConversationSnapshot.toString()})`);
  const result = collect(document, context.siteAdapter(url));
  return Array.from(result.messages, message => ({ ...message,
    markdown: context.normalizeExportMarkdown(message.markdown) }));
}

// Reduced structural fixtures, not authenticated live site tests. Kimi's outer
// item/inner segment and Markdown containers are documented in headroom and
// opencli; the other fixtures exercise the existing provider selector contracts.
test('Kimi exports every response fragment once, preserves later code and ignores tool calls', () => {
  const messages = snapshot(`
    <div class="chat-content-item-user"><div class="segment-user">Q1<button title="paper.pdf">paper.pdf</button></div></div>
    <div class="chat-content-item-assistant"><div class="segment-assistant">
      <div class="thinking-content"><div class="markdown">PRIVATE THOUGHT</div></div>
      <div class="toolcall-container"><div class="markdown">SEARCH INTERNALS</div></div>
      <div class="markdown-container"><div class="markdown"><p>First paragraph</p></div></div>
      <div class="markdown-container"><div class="markdown"><p>Second paragraph</p></div></div>
      <pre><code class="language-python">print(1)\n\n\nprint(2)</code></pre>
      <div class="markdown"><p>Last paragraph</p><button>Copy</button><div role="toolbar">Actions</div></div>
    </div></div>
    <div class="chat-content-item-user"><div class="segment-user">Q2</div></div>
    <div class="chat-content-item-assistant"><div class="segment-assistant"><div class="markdown">First paragraph</div></div></div>
    <form><div class="segment-user" contenteditable="true">UNSENT DRAFT</div></form>`);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(messages[0].markdown, /Q1\n\n附件：\n- paper.pdf/);
  assert.equal(messages[1].markdown, 'First paragraph\n\nSecond paragraph\n\n```python\nprint(1)\n\n\nprint(2)\n```\n\nLast paragraph');
  assert.equal(messages[3].markdown, 'First paragraph'); // Do not deduplicate text across turns.
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE|INTERNALS|Actions|Copy|DRAFT/);
});

test('Kimi segment-only messages and nested Markdown keep all repeated paragraphs', () => {
  const messages = snapshot(`<div class="segment-user">Question</div>
    <div class="segment-assistant"><div class="markdown-container">
      <div class="markdown"><p>Same paragraph</p><p>Same paragraph</p></div>
      <div class="markdown"><p>End</p></div></div></div>`);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].markdown, 'Same paragraph\n\nSame paragraph\n\nEnd');
});

const providers = [
  ['ChatGPT', 'https://chatgpt.com/c/test', text => `<article data-turn="user">${text}</article>`,
    text => `<article data-turn="assistant">${text}</article>`, text => `<div data-message-author-role="assistant">${text}</div>`],
  ['Gemini', 'https://gemini.google.com/app/test', text => `<user-query>${text}</user-query>`,
    text => `<model-response>${text}</model-response>`, text => `<message-content><div class="markdown">${text}</div></message-content>`],
  ['Google AI Studio', 'https://aistudio.google.com/prompts/test', text => `<ms-chat-turn><div class="chat-turn-container user" data-turn-role="User">${text}</div></ms-chat-turn>`,
    text => `<ms-chat-turn><div class="chat-turn-container model" data-turn-role="Model">${text}</div></ms-chat-turn>`, text => `<ms-cmark-node>${text}</ms-cmark-node>`],
  ['DeepSeek', 'https://chat.deepseek.com/a/chat/s/test', text => `<div class="ds-user-message">${text}</div>`,
    text => `<div class="ds-assistant-message-main-content">${text}</div>`, text => `<div class="ds-markdown">${text}</div>`],
  ['GLM China', 'https://chatglm.cn/main/alltoolsdetail?cid=test', text => `<div class="conversation-item user">${text}</div>`,
    text => `<div class="conversation-item assistant">${text}</div>`, text => `<div class="markdown">${text}</div>`],
  ['Z.ai legacy', 'https://chat.z.ai/c/test', text => `<div id="user-message-1">${text}</div>`,
    text => `<div id="response-message-1">${text}</div>`, text => `<div class="markdown">${text}</div>`],
];
for (const [name, url, user, assistant, body] of providers) {
  test(`${name} exports successive answer blocks, math, tables, code and later turns`, () => {
    const html = user('<p>Q1</p>') + assistant(
      '<ms-thought-accordion>' + body('HIDDEN REASONING') + '</ms-thought-accordion>'
      + body('<p>First</p>')
      + body('<div class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span></div>')
      + '<pre><code class="language-js">const x = 1;</code></pre>'
      + body('<table><tr><th>X</th></tr><tr><td>1</td></tr></table>')
      + body('<p>Last</p>')
      + '<div hidden>' + body('HIDDEN OLD ANSWER') + '</div>')
      + user('<p>Q2</p>') + assistant(body('<p>A2</p>'));
    const messages = snapshot(html, url);
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(messages[1].markdown, 'First\n\n$$\nE=mc^2\n$$\n\n```js\nconst x = 1;\n```\n\n| X |\n| --- |\n| 1 |\n\nLast');
    assert.equal(messages[3].markdown, 'A2');
    assert.doesNotMatch(JSON.stringify(messages), /HIDDEN/);
  });
}

test('hidden old messages and draft roles cannot make a one-sided export look complete', () => {
  assert.throws(() => snapshot(`<form><div class="segment-user">DRAFT</div></form>
    <div hidden><div class="segment-user">OLD</div></div>
    <div class="segment-assistant"><div class="markdown">Answer</div></div>`), /未能同时识别用户消息和 AI 回复/);
});

test('an unrecognized body layout with code falls back to the full turn instead of exporting only code', () => {
  const messages = snapshot(`<div class="segment-user">Question</div><div class="segment-assistant">
    <p>Before</p><pre><code>example</code></pre><p>After</p></div>`);
  assert.equal(messages[1].markdown, 'Before\n\n```\nexample\n```\n\nAfter');
});

test('DeepSeek PDF-only user bubble is a message even without a user text element', () => {
  // Reduced from the public DeepSeek DOM capture: _9663006 is the user group,
  // _4f9bf79 the assistant group; fbb737a4 is optional text, not the whole turn.
  const messages = snapshot(`<div class="ds-virtual-list-visible-items">
    <div class="_9663006"><div class="d29f3d7d ds-message _63c77b1">
      <div class="file"><span>paper.pdf</span><span>PDF</span></div>
    </div></div>
    <div class="_4f9bf79"><div class="ds-message _63c77b1">
      <div class="ds-think-content"><div class="ds-markdown">PRIVATE THOUGHT</div></div>
      <div class="ds-markdown ds-assistant-message-main-content"><p>Paper summary</p></div>
    </div><div role="button">Copy</div></div>
    <div class="_9663006"><div class="d29f3d7d ds-message _63c77b1"><div class="fbb737a4">
      <div class="ds-collapsible-text">Question 2</div><div class="ds-collapsible-text-toggle-button">Expand</div>
    </div></div></div>
    <div class="_4f9bf79"><div class="ds-message _63c77b1"><div class="ds-markdown ds-assistant-message-main-content">Answer 2</div></div></div>
  </div>`, 'https://chat.deepseek.com/a/chat/s/pdf');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(messages[0].markdown, /paper\.pdf/);
  assert.equal(messages[1].markdown, 'Paper summary');
  assert.equal(messages[2].markdown, 'Question 2');
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE|Copy|Expand/);
});

test('DeepSeek structural user bubble works without legacy hashed text class', () => {
  const messages = snapshot(`<div class="ds-message"><div class="ds-collapsible-text">Question</div></div>
    <div class="ds-message"><div class="ds-assistant-message-main-content"><div class="ds-markdown">Answer</div></div></div>`,
    'https://chat.deepseek.com/a/chat/s/new');
  assert.deepEqual(messages.map(message => message.markdown), ['Question', 'Answer']);
});

test('China GLM uses real question/answer rows and exports PDF-only turns without names or thinking', () => {
  // Structure confirmed in chatglm.cn's public 8461.74bb7600.js component.
  const messages = snapshot(`<div id="session-container"><div class="item">
    <div class="conversation question pr flex" id="row-question-0">
      <img class="user-img" alt="Avatar"><div class="user-name">Display name</div>
      <div class="question-file" id="row-question-img-0"><span>paper.pdf</span></div>
    </div>
    <div class="answer" id="row-answer-0"><div class="panel"><div class="answer-content flex1">
      <div class="assistant-name">GLM model name</div>
      <div class="text-thinking-content"><div class="markdown-body">PRIVATE THOUGHT</div></div>
      <div class="tool-result-content"><div class="markdown-body">TOOL RESULT</div></div>
      <div class="markdown-body"><p>Summary</p></div><div class="markdown-body"><p>Conclusion</p></div>
    </div></div></div>
    <div class="conversation question" id="row-question-1"><div class="user-name">Display name</div>
      <div class="question-txt" id="row-question-p-1"><span>Question 2</span></div><div class="copy-btn">Copy</div>
    </div><div class="answer" id="row-answer-1"><div class="markdown-body">Answer 2</div></div>
    </div></div><div class="question-list"><div class="question-title">Suggested question</div></div>`,
    'https://chatglm.cn/main/alltoolsdetail?cid=test');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[0].markdown, 'paper.pdf');
  assert.equal(messages[1].markdown, 'Summary\n\nConclusion');
  assert.equal(messages[2].markdown, 'Question 2');
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE|TOOL|Display name|model name|Copy|Suggested/);
});
