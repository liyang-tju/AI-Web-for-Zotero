const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['providers.js', 'bootstrap.js']
  .map(file => fs.readFileSync(`${__dirname}/../addon/${file}`, 'utf8')).join('\n');

// Message-manager contract tests only; no Gecko process or live File cloning.
function fixture(viaFrameLoader) {
  const listeners = new Map(), timers = new Map(), sent = [], scripts = [];
  const manager = {
    addMessageListener: (name, callback) => listeners.set(name, callback),
    removeMessageListener: name => listeners.delete(name),
    sendAsyncMessage: (name, data) => sent.push({ name, data }),
    loadFrameScript: (uri, delayed) => scripts.push({ uri, delayed }),
  };
  const browser = { currentURI: { spec: 'https://chatgpt.com/c/test' },
    ...(viaFrameLoader ? { frameLoader: { messageManager: manager } } : { messageManager: manager }) };
  const state = { browser };
  const window = { setTimeout: callback => { timers.set(1, callback); return 1; }, clearTimeout: id => timers.delete(id) };
  const c = vm.createContext({ Services: { uuid: { generateUUID: () => 'test' } } });
  vm.runInContext(source, c);
  return { c, window, state, manager, listeners, timers, sent, scripts };
}

for (const viaFrameLoader of [false, true]) {
  const label = viaFrameLoader ? 'frameLoader.messageManager' : 'browser.messageManager';
  test(`${label}: upload sends only selected File objects after ready and cleans up on delivery`, async () => {
    const f = fixture(viaFrameLoader);
    const files = [{ name: 'paper.pdf' }, { name: 'SI.pdf' }];
    const result = f.c.attachFilesToWebsite(f.window, f.state, files);
    assert.equal(f.sent.length, 0);
    assert.equal(f.scripts.length, 1);
    assert.equal(f.scripts[0].delayed, false);
    assert.doesNotMatch(decodeURIComponent(f.scripts[0].uri), /paper\.pdf|SI\.pdf/);
    const receive = f.listeners.get('ChatGPTSidebar:Upload:test');
    receive({ data: { ready: true } });
    assert.equal(f.sent[0].data.files, files);
    receive({ data: { ok: true, stage: 'delivered' } });
    assert.equal((await result).stage, 'delivered');
    assert.equal(f.listeners.size, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.state.cancelUpload, null);
  });

  test(`${label}: cancellation prevents a pending upload and export rejects navigation`, async () => {
    const f = fixture(viaFrameLoader);
    const upload = f.c.attachFilesToWebsite(f.window, f.state, [{ name: 'paper.pdf' }]);
    f.state.cancelUpload();
    assert.equal((await upload).ok, false);
    assert.ok(f.sent.every(message => message.name.endsWith(':cancel')));
    const snapshot = f.c.requestConversationSnapshot(f.window, f.state);
    f.state.browser.currentURI.spec = 'https://chatgpt.com/c/other';
    f.listeners.get('ChatGPTSidebar:Export:test')({ data: {
      url: 'https://chatgpt.com/c/test', messages: [{ role: 'user', markdown: 'old' }],
    } });
    await assert.rejects(snapshot, /网页已切换/);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.timers.size, 0);
  });
}
