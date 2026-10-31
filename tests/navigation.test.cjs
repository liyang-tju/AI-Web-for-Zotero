const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function actorScope() {
  const launches = [];
  const scope = vm.createContext({ URL, JSWindowActorChild: class {}, JSWindowActorParent: class {},
    ChromeUtils: { defineESModuleGetters(target, modules) {
      // This exact module is present even in Zotero 7.0.0. Never fall back to
      // Services.jsm (removed in newer hosts) or a guessed Zotero JSM path.
      assert.equal(modules.Zotero, 'chrome://zotero/content/zotero.mjs');
      Object.defineProperty(target, 'Zotero', { get: () => ({ launchURL: url => launches.push(url) }) });
    } } });
  for (const side of ['Child', 'Parent']) {
    const name = `AIWebSidebarLinks${side}`;
    const source = fs.readFileSync(`${__dirname}/../addon/actors/${name}.mjs`, 'utf8');
    vm.runInContext(source.replace(`export class ${name}`, `globalThis.${name} = class ${name}`), scope);
  }
  return { scope, launches };
}

function fixture(sourceURL, html) {
  const { scope, launches } = actorScope();
  const { document } = parseHTML(`<html><head><base href="${sourceURL}"></head><body>${html}</body></html>`);
  Object.defineProperty(document, 'location', { value: { href: sourceURL } });
  const manager = { documentURI: { spec: sourceURL } };
  const browser = { id: 'chatgpt-web-demo-browser', getAttribute: () => 'aiWebSidebar' };
  const context = { currentWindowGlobal: manager, embedderElement: browser };
  context.top = context;
  const parent = new scope.AIWebSidebarLinksParent();
  Object.assign(parent, { manager, browsingContext: context });
  const assigned = [];
  const child = new scope.AIWebSidebarLinksChild();
  Object.assign(child, { document, contentWindow: { location: { assign: url => assigned.push(url) } },
    sendAsyncMessage: (name, data) => parent.receiveMessage({ name, data }) });
  function click(selector = 'a', overrides = {}) {
    const node = document.querySelector(selector);
    const event = { isTrusted: true, type: 'click', button: 0, defaultPrevented: false,
      composedPath: () => { const path = []; for (let n = node; n; n = n.parentNode) path.push(n); return path; },
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...overrides };
    child.handleEvent(event);
    return event;
  }
  return { launches, document, assigned, click, parent, context, browser };
}

test('DeepSeek conversation links retain SPA navigation for text and nested title/icon clicks', () => {
  const f = fixture('https://chat.deepseek.com/a/chat/s/one', '<a href="/a/chat/s/two"><span>Title</span><svg><path/></svg></a>');
  for (const selector of ['a', 'span', 'path']) {
    const event = f.click(selector);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, undefined);
  }
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.assigned, []);
});

test('same-site new-window and modified links stay in the sidebar', () => {
  for (const attrs of ['target="_blank"', 'target="named-window"', '']) {
    const f = fixture('https://chat.deepseek.com/a/chat/s/one', `<a ${attrs} href="/a/chat/s/two">Title</a>`);
    const event = f.click('a', attrs ? {} : { metaKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(f.assigned, ['https://chat.deepseek.com/a/chat/s/two']);
    assert.deepEqual(f.launches, []);
  }
  const f = fixture('https://chatgpt.com/c/one', '<a href="/c/two">Chat</a>');
  f.document.querySelector('base').setAttribute('target', '_blank');
  f.click();
  f.click('a', { type: 'auxclick', button: 1 });
  assert.equal(f.assigned.length, 2);
  assert.deepEqual(f.launches, []);
});

test('ChatGPT reply links open once in the default browser without navigating the chat', () => {
  for (const target of ['', 'target="_blank"']) {
    const f = fixture('https://chatgpt.com/c/one', `<article><a href="https://example.org/paper?x=1#figure" ${target}><span>Source</span></a></article>`);
    const event = f.click('span');
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(f.launches, ['https://example.org/paper?x=1#figure']);
    assert.deepEqual(f.assigned, []);
  }
});

test('hashes, downloads and non-web schemes remain with the webpage', () => {
  for (const attrs of ['href="#source"', 'href="/backend-api/files/one"',
    'href="https://example.org/file.pdf" download', 'href="blob:https://chatgpt.com/file"',
    'href="javascript:void(0)"', 'href="mailto:test@example.org"']) {
    const f = fixture('https://chatgpt.com/c/one', `<a ${attrs}>Link</a>`);
    assert.equal(f.click().defaultPrevented, false);
    assert.deepEqual(f.launches, []);
    assert.deepEqual(f.assigned, []);
  }
});

test('synthetic, cancelled and right-click events do not launch external links', () => {
  for (const overrides of [{ isTrusted: false }, { defaultPrevented: true }, { button: 2 }, { type: 'mousedown' }]) {
    const f = fixture('https://chatgpt.com/c/one', '<a href="https://example.org/paper">Source</a>');
    f.click('a', overrides);
    assert.deepEqual(f.launches, []);
  }
});

test('parent rejects same-site, non-web, stale and non-sidebar navigation messages', () => {
  const f = fixture('https://chatgpt.com/c/one', '');
  const send = url => f.parent.receiveMessage({ name: 'OpenExternalLink', data: { url } });
  for (const url of ['https://chatgpt.com/c/two', 'file:///tmp/one', 'javascript:void(0)', 'broken']) send(url);
  f.browser.id = 'zotero-reader';
  send('https://example.org/');
  f.browser.id = 'chatgpt-web-demo-browser';
  f.context.currentWindowGlobal = {};
  send('https://example.org/');
  assert.deepEqual(f.launches, []);
});

test('link actor is registered only for the sidebar and cleaned up on disable', () => {
  const resources = new Map(), actors = new Map();
  const protocol = { QueryInterface() { return this; }, setSubstitution: (key, uri) => uri ? resources.set(key, uri) : resources.delete(key) };
  const scope = vm.createContext({ APP_SHUTDOWN: -1, Components: { interfaces: { nsIResProtocolHandler: {} } },
    Services: { io: { getProtocolHandler: () => protocol, newURI: spec => ({ spec }) } },
    ChromeUtils: { registerWindowActor: (name, options) => actors.set(name, options), unregisterWindowActor: name => actors.delete(name) } });
  vm.runInContext(fs.readFileSync(`${__dirname}/../addon/bootstrap.js`, 'utf8'), scope);
  scope.addonRootURI = 'jar:file:///tmp/plugin.xpi!/';
  scope.registerSidebarLinks('0.15.2');
  scope.registerSidebarLinks('0.15.2');
  assert.equal(actors.size, 1);
  const options = actors.get('AIWebSidebarLinks');
  assert.deepEqual(Array.from(options.messageManagerGroups), ['aiWebSidebar']);
  assert.equal(options.allFrames, undefined);
  assert.equal(options.child.events.click.capture, true);
  assert.ok(resources.has('ai-web-sidebar-0-15-2'));
  for (const side of ['Child', 'Parent']) {
    assert.equal(options[side.toLowerCase()].esModuleURI, `resource://ai-web-sidebar-0-15-2/actors/AIWebSidebarLinks${side}.mjs`);
  }
  scope.shutdown({}, 0);
  assert.equal(actors.size, 0);
  assert.equal(resources.size, 0);
  assert.equal(scope.sidebarLinkResource, null);
});
