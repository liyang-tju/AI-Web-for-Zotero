const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { rejectHasSelectors } = require('./helpers/legacy-selectors.cjs');
const source = ['ui.js', 'providers.js', 'settings.js', 'bootstrap.js'].map(name => fs.readFileSync(`${__dirname}/../addon/${name}`, 'utf8')).join('\n');

// Structural regression fixtures, not snapshots of a logged-in website.
// A real DOM/CSS engine exercises nesting, selectors and node replacement.
function fixture(url, markup, onChange = () => {}, onTick = () => {}) {
  const { document, window } = parseHTML(`<html><body>${markup}</body></html>`);
  rejectHasSelectors(window);
  window.Element.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  document.location = { href: url, origin: new URL(url).origin };
  const listeners = new Map(), outputs = [], received = [];
  const page = { document, Event: window.Event, setTimeout(fn) { onTick(document); fn(); } };
  function wireInput(input) {
    input.accept = input.getAttribute('accept') || '';
    input.multiple = input.hasAttribute('multiple');
    input.form = input.closest('form');
    input.mozSetFileArray = files => { input.files = files; received.push({ id: input.id, files }); };
    input.addEventListener('change', () => onChange(document, input));
  }
  for (const input of document.querySelectorAll('input[type=file]')) wireInput(input);
  const c = vm.createContext({ content: page,
    addMessageListener: (name, fn) => listeners.set(name, fn), removeMessageListener: name => listeners.delete(name),
    sendAsyncMessage: (_, value) => outputs.push(value) });
  vm.runInContext(source, c);
  return { document, received, wireInput, cancel: () => listeners.get('upload:cancel')?.(), async upload(names = ['A.pdf']) {
    c.uploadFileInFrame('upload', c.siteAdapter(url));
    await listeners.get('upload:file')({ data: { files: names.map(name => ({ name })) } });
    assert.equal(listeners.size, 0);
    return outputs.at(-1);
  } };
}
const gemini = 'https://gemini.google.com/app/abc';
const kimi = 'https://www.kimi.com/chat/abc';
const glm = 'https://chatglm.cn/main/alltoolsdetail?cid=abc';
const fileInput = '<input id="pdf" type="file" accept="application/*" multiple>';
function appendCard(doc, root, name, tag = 'div', className = 'file-card') {
  const card = doc.createElement(tag); card.className = className; card.textContent = name;
  doc.querySelector(root).append(card);
}

test('Gemini nested editable nodes and hidden duplicate select one actual input', async () => {
  const f = fixture(gemini, `<div hidden><textarea aria-label="old"></textarea></div>
    <input-area-v2><div class="previews"></div><input-container><rich-textarea contenteditable="true" role="textbox">
    <div class="ql-editor" contenteditable="plaintext-only"><p></p></div></rich-textarea>${fileInput}</input-container></input-area-v2>`,
    doc => appendCard(doc, '.previews', 'A.pdf', 'uploader-file-preview', ''));
  assert.equal((await f.upload()).ok, true);
  assert.equal(f.received[0].id, 'pdf');
});

test('Gemini supports class-based rich text editor and ignores an aria-hidden editor', async () => {
  const f = fixture(gemini, `<input-container><div aria-hidden="true"><textarea placeholder="hidden"></textarea></div>
    <div class="rich-textarea"><div contenteditable="true"></div></div>${fileInput}</input-container>`,
    doc => appendCard(doc, 'input-container', 'A.pdf', 'uploader-file-preview', ''));
  assert.equal((await f.upload()).ok, true);
});

test('multiple Gemini text editors do not block a unique file input', async () => {
  const f = fixture(gemini, `<input-container><textarea aria-label="one"></textarea><textarea aria-label="two"></textarea>${fileInput}</input-container>`);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received[0].id, 'pdf');
});

test('China GLM input-box-inner and outer preview area work without a form', async () => {
  const f = fixture(glm, `<div class="conversation-item user">old</div><div class="input-box"><div class="previews"></div>
    <div class="input-box-inner"><textarea class="scroll-display-none"></textarea></div>${fileInput}</div>`,
    doc => appendCard(doc, '.previews', 'A.pdf'));
  assert.equal((await f.upload()).ok, true);
});

test('Kimi delivery completes even when the change handler replaces the composer', async () => {
  const f = fixture(kimi, `<div class="chat-input"><textarea></textarea>${fileInput}</div>`, doc => {
    doc.querySelector('.chat-input').outerHTML = '<div class="chat-input"><textarea></textarea><div class="new-upload-chip"><span>A.pdf</span><button>删除</button></div></div>';
  });
  assert.equal((await f.upload()).ok, true);
});

test('delivery never polls cards, notices or navigation, even if the composer is removed', async () => {
  for (const url of [gemini, kimi, glm, 'https://chat.deepseek.com/a/chat/s/abc']) {
    const f = fixture(url, `<form class="input-area-v2"><textarea aria-label="chat" placeholder="chat"></textarea>${fileInput}</form>`, doc => {
      doc.querySelector('form').remove();
      doc.location.href = url + '-new-conversation';
      doc.querySelectorAll = () => { throw new Error('must not inspect page after dispatch'); };
    }, () => { throw new Error('must not schedule post-delivery polling'); });
    assert.equal((await f.upload()).stage, 'delivered', url);
    assert.equal(f.received.length, 1);
  }
});

test('same PDF can be delivered repeatedly even when no preview ever appears', async () => {
  const f = fixture(kimi, `<div class="chat-input"><textarea></textarea>${fileInput}<div class="file-card">A.pdf</div></div>`);
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received.length, 3);
  assert.ok(f.received.every(batch => batch.files[0].name === 'A.pdf'));
});

test('one batch may contain identical filenames without a card-count check', async () => {
  const f = fixture(kimi, `<div class="chat-input"><textarea></textarea>${fileInput}</div>`);
  assert.equal((await f.upload(['A.pdf', 'A.pdf'])).stage, 'delivered');
  assert.equal(f.received[0].files.length, 2);
});

test('history-only file controls are never used when composer has no uploader', async () => {
  const f = fixture(glm, `<form class="conversation-item user">${fileInput}</form><div class="input-box-inner"><textarea></textarea></div>`);
  assert.match((await f.upload()).error, /未找到唯一/);
  assert.equal(f.received.length, 0);
});

test('unowned hidden file input in history is not mistaken for composer input', async () => {
  const f = fixture(glm, `<div class="conversation-item user">${fileInput}</div><div class="input-box-inner"><textarea></textarea></div>`);
  assert.match((await f.upload()).error, /未找到唯一/);
  assert.equal(f.received.length, 0);
});

test('Gemini main file input works alongside visible secondary editors and textarea mirrors', async () => {
  const f = fixture(gemini, `<textarea aria-label="Search"></textarea>
    <div role="textbox" contenteditable="true">secondary editor</div>
    <div class="input-area-v2"><div class="ql-editor" contenteditable="true"></div>
    <textarea aria-label="mirror"></textarea>${fileInput}</div>`);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received[0].id, 'pdf');
});

test('Gemini input-area file control works alongside a secondary rich-textarea', async () => {
  const f = fixture(gemini, `<rich-textarea><div class="ql-editor" contenteditable="true">secondary</div></rich-textarea>
    <input-area-v2><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>${fileInput}</input-area-v2>`);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received[0].id, 'pdf');
});

test('two genuine main Gemini composers remain ambiguous instead of sending to the first', async () => {
  const f = fixture(gemini, `<input-area-v2><div class="ql-editor" contenteditable="true"></div>${fileInput}</input-area-v2>
    <input-area-v2><div class="ql-editor" contenteditable="true"></div>${fileInput}</input-area-v2>`);
  assert.match((await f.upload()).error, /多个或无法确定归属的 PDF 文件控件/);
  assert.equal(f.received.length, 0);
});

test('Google pages without a file input do not trigger drag-and-drop or menu clicks', async () => {
  for (const [url, markup] of [
    [gemini, '<input-area-v2 xapfileselectordropzone><div class="ql-editor" contenteditable="true"></div><button>Upload</button></input-area-v2>'],
    ['https://aistudio.google.com/prompts/abc', '<ms-prompt-box><div class="input-wrapper"><textarea></textarea><button>Insert assets</button></div></ms-prompt-box>'],
  ]) {
    const f = fixture(url, markup);
    const events = [];
    for (const type of ['click', 'dragenter', 'dragover', 'drop']) f.document.addEventListener(type, () => events.push(type));
    assert.match((await f.upload()).error, url === gemini ? /未找到 Gemini/ : /未找到唯一的 PDF 上传控件/);
    assert.deepEqual(events, []);
  }
});

test('AI Studio uploads only to the main prompt, ignoring history and system instruction editors', async () => {
  const f = fixture('https://aistudio.google.com/prompts/abc', `<ms-system-instruction><ms-autosize-textarea><textarea>system</textarea></ms-autosize-textarea></ms-system-instruction>
    <ms-chat-turn><div class="chat-turn-container user"><ms-prompt-box><textarea>edit old message</textarea><input id="old" type="file"></ms-prompt-box></div></ms-chat-turn>
    <ms-prompt-box><ms-autosize-textarea><textarea aria-label="Enter a prompt"></textarea></ms-autosize-textarea>${fileInput}</ms-prompt-box>`);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received[0].id, 'pdf');
});

test('Gemini locates its hidden native uploader without querying or counting text editors', async () => {
  const f = fixture(gemini, `<form><input id="foreign" type="file" accept=".pdf"></form>
    <images-files-uploader>${fileInput.replace('multiple>', 'multiple hidden>')}</images-files-uploader>`);
  const query = f.document.querySelectorAll.bind(f.document);
  f.document.querySelectorAll = selector => {
    assert.equal(selector, 'input[type="file"]', 'only native file controls may be queried');
    return query(selector);
  };
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received[0].id, 'pdf');
});

test('Gemini uses a unique unowned PDF input without any recognizable editor or composer', async () => {
  const f = fixture(gemini, `<div><div contenteditable="true"></div><textarea></textarea>${fileInput}</div>`);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received[0].id, 'pdf');
});

test('Gemini native uploader takes precedence over unrelated PDF inputs', async () => {
  const f = fixture(gemini, `<input id="unrelated" type="file" accept=".pdf">
    <images-files-uploader>${fileInput}</images-files-uploader>`);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received[0].id, 'pdf');
});

test('Gemini refuses ambiguous uploaders, foreign forms, image-only inputs and history controls', async () => {
  for (const markup of [
    `<images-files-uploader>${fileInput}${fileInput}</images-files-uploader>`,
    `<form><input type="file" accept=".pdf"></form>`,
    '<images-files-uploader><input type="file" accept="image/*"></images-files-uploader>',
    `<user-query><images-files-uploader>${fileInput}</images-files-uploader></user-query>`,
  ]) {
    const f = fixture(gemini, markup);
    const result = await f.upload();
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /聊天输入框/);
    assert.equal(f.received.length, 0);
  }
});

test('Gemini native uploader supports repeated same-file delivery without any post-upload scanning', async () => {
  const f = fixture(gemini, `<images-files-uploader>${fileInput}</images-files-uploader>`, doc => {
    doc.location.href = 'https://gemini.google.com/app/new-chat';
  }, () => { throw new Error('no post-upload wait'); });
  for (let n = 0; n < 3; n++) assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(f.received.length, 3);
  assert.ok(f.received.every(entry => entry.files[0].name === 'A.pdf'));
});

function mountGeminiInput(f) {
  const owner = f.document.createElement('images-files-uploader');
  owner.innerHTML = fileInput;
  f.document.body.append(owner);
  const input = owner.querySelector('input');
  input.addEventListener('click', () => { throw new Error('must not open native picker'); });
  f.wireInput(input);
}
const uploadMenu = '<input-area-v2><button aria-label="Open upload file menu" aria-expanded="false">+</button></input-area-v2>';

test('Gemini opens + once, directly delivers the PDF and never clicks Upload files', async () => {
  const f = fixture(gemini, uploadMenu, doc => {
    doc.location.href = 'https://gemini.google.com/app/sent';
    doc.querySelectorAll = () => { throw new Error('no checks after delivery'); };
  }, () => { throw new Error('no delay once input exists'); });
  let clicks = 0;
  const button = f.document.querySelector('button');
  button.addEventListener('click', () => {
    clicks++;
    button.setAttribute('aria-expanded', 'true');
    const upload = f.document.createElement('button');
    upload.setAttribute('role', 'menuitem'); upload.textContent = 'Upload files';
    upload.addEventListener('click', () => { throw new Error('must not open file picker menu item'); });
    f.document.body.append(upload);
    mountGeminiInput(f);
  });
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(clicks, 1);
  assert.equal(f.received.length, 1);
});

test('existing Gemini file input bypasses + even when the menu is closed', async () => {
  const f = fixture(gemini, uploadMenu + `<images-files-uploader>${fileInput}</images-files-uploader>`);
  let clicks = 0;
  f.document.querySelector('button').addEventListener('click', () => clicks++);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(clicks, 0);
});

test('Gemini waits for asynchronous input creation only before delivery', async () => {
  let ticks = 0, clicks = 0;
  const f = fixture(gemini, uploadMenu, () => {}, () => { if (++ticks === 3) mountGeminiInput(f); });
  f.document.querySelector('button').addEventListener('click', () => clicks++);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(ticks, 3);
  assert.equal(clicks, 1);
});

test('already expanded Gemini menu is not toggled closed while input is being created', async () => {
  let ticks = 0, clicks = 0;
  const f = fixture(gemini, uploadMenu.replace('"false"', '"true"'), () => {}, () => { if (++ticks === 2) mountGeminiInput(f); });
  f.document.querySelector('button').addEventListener('click', () => clicks++);
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(clicks, 0);
});

test('Gemini stops waiting after 3 seconds without repeatedly toggling +', async () => {
  let ticks = 0, clicks = 0;
  const f = fixture(gemini, uploadMenu, () => {}, () => ticks++);
  f.document.querySelector('button').addEventListener('click', () => clicks++);
  assert.equal((await f.upload()).ok, false);
  assert.equal(ticks, 60);
  assert.equal(clicks, 1);
  assert.equal(f.received.length, 0);
});

test('navigation or cancellation while preparing Gemini uploader prevents file delivery', async () => {
  for (const mode of ['navigate', 'cancel']) {
    const f = fixture(gemini, uploadMenu, () => {}, doc => {
      mountGeminiInput(f);
      if (mode === 'navigate') doc.location.href = 'https://gemini.google.com/app/other';
      else f.cancel();
    });
    assert.equal((await f.upload()).ok, false);
    assert.equal(f.received.length, 0);
  }
});

test('ambiguous Gemini plus buttons and menu items are not clicked', async () => {
  for (const markup of [uploadMenu + uploadMenu, '<button role="menuitem" aria-label="Open upload file menu">Upload files</button>']) {
    const f = fixture(gemini, markup);
    let clicks = 0;
    f.document.addEventListener('click', () => clicks++);
    assert.equal((await f.upload()).ok, false);
    assert.equal(clicks, 0);
  }
});

test('Gemini localized + icon is used only inside the main input area', async () => {
  const f = fixture(gemini, '<nav><button aria-haspopup="menu"><mat-icon fonticon="add"></mat-icon></button></nav><input-area-v2><button aria-haspopup="menu"><mat-icon data-mat-icon-name="add_2"></mat-icon></button></input-area-v2>');
  f.document.querySelector('nav button').addEventListener('click', () => { throw new Error('wrong plus button'); });
  f.document.querySelector('input-area-v2 button').addEventListener('click', () => mountGeminiInput(f));
  assert.equal((await f.upload()).stage, 'delivered');
});

test('Gemini opens current Upload & tools buttons in English and Chinese', async () => {
  for (const label of ['Upload & tools', '上传和工具', '上傳和工具']) {
    const f = fixture(gemini, `<input-area-v2><button aria-label="${label}">+</button></input-area-v2>`);
    let clicks = 0;
    f.document.querySelector('button').addEventListener('click', () => { clicks++; mountGeminiInput(f); });
    assert.equal((await f.upload()).stage, 'delivered', label);
    assert.equal(clicks, 1);
  }
});

test('Gemini gem-icon-button host label resolves to the inner native button', async () => {
  for (const attribute of ['arialabel', 'aria-label']) {
    for (const label of ['上传和工具', 'Upload & tools']) {
      const f = fixture(gemini, `<input-area-v2><gem-icon-button ${attribute}="${label}"><button><svg></svg></button></gem-icon-button></input-area-v2>`);
      const host = f.document.querySelector('gem-icon-button');
      host.getClientRects = () => []; // display:contents-like wrapper
      host.click = () => { throw new Error('must click the actual inner button'); };
      let clicks = 0;
      host.querySelector('button').addEventListener('click', () => { clicks++; mountGeminiInput(f); });
      assert.equal((await f.upload()).stage, 'delivered', attribute + label);
      assert.equal(clicks, 1);
    }
  }
});

test('Gemini host and inner button matching the same label are deduplicated', async () => {
  const f = fixture(gemini, '<input-area-v2><gem-icon-button arialabel="上传和工具"><button aria-label="上传和工具">+</button></gem-icon-button></input-area-v2>');
  let clicks = 0;
  f.document.querySelector('button').addEventListener('click', () => { clicks++; mountGeminiInput(f); });
  assert.equal((await f.upload()).stage, 'delivered');
  assert.equal(clicks, 1);
});

test('expanded state on Gemini host prevents closing the menu through its inner button', async () => {
  const f = fixture(gemini, '<input-area-v2><gem-icon-button arialabel="上传和工具" aria-expanded="true"><button>+</button></gem-icon-button></input-area-v2>', () => {}, () => mountGeminiInput(f));
  f.document.querySelector('button').addEventListener('click', () => { throw new Error('must not close expanded menu'); });
  assert.equal((await f.upload()).stage, 'delivered');
});

test('disabled Gemini hosts, nested menu items and navigation buttons are never activated', async () => {
  for (const markup of [
    '<gem-icon-button arialabel="上传和工具" disabled><button>+</button></gem-icon-button>',
    '<gem-icon-button arialabel="上传和工具" aria-disabled="true"><button>+</button></gem-icon-button>',
    '<div role="menuitem"><gem-icon-button arialabel="上传和工具"><button>+</button></gem-icon-button></div>',
    '<nav><gem-icon-button arialabel="上传和工具"><button>+</button></gem-icon-button></nav>',
  ]) {
    const f = fixture(gemini, markup);
    let clicks = 0;
    f.document.addEventListener('click', () => clicks++);
    assert.equal((await f.upload()).ok, false);
    assert.equal(clicks, 0);
    assert.equal(f.received.length, 0);
  }
});

test('Gemini preparation errors distinguish missing button from input not created after click', async () => {
  const absent = fixture(gemini, '<input-area-v2></input-area-v2>');
  assert.match((await absent.upload()).error, /未找到 Gemini.*按钮/);
  const unresponsive = fixture(gemini, '<input-area-v2><button aria-label="上传和工具">+</button></input-area-v2>');
  assert.match((await unresponsive.upload()).error, /已尝试展开.*尚未创建/);
});
