const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = ['ui.js','providers.js','settings.js','bootstrap.js'].map(name=>fs.readFileSync(`${__dirname}/../addon/${name}`,'utf8')).join('\n');
function scope(extra={}) {
  const prefs=new Map();
  const c=vm.createContext({Services:{io:{newURI(value){const u=new URL(value);return {spec:u.href,host:u.hostname,scheme:u.protocol.slice(0,-1)};}},prefs:{getStringPref:(key,fallback)=>prefs.get(key)??fallback,setStringPref:(key,value)=>prefs.set(key,value)}},...extra});
  vm.runInContext(source,c);return {c,prefs};
}
const urls=['https://gemini.google.com/app/abc','https://chat.deepseek.com/a/chat/s/abc','https://www.kimi.com/chat/abc','https://chat.z.ai/c/abc','https://chatglm.cn/main/alltoolsdetail?cid=abc'];

test('presets and canonical bookmarks cover every provider but reject login, homepage and spoofed hosts',()=>{
  const {c}=scope();assert.equal(c.siteAdapter().length,6);
  for(const url of urls){assert.equal(c.conversationURL(url),url);assert.ok(c.siteAdapter(url));}
  for(const url of ['https://gemini.google.com/app','https://www.kimi.com/','https://chat.z.ai/auth','https://chatglm.cn/main/alltoolsdetail','https://chatgpt.com.evil/c/a','https://chatgpt.com@evil.example/c/a','http://chatgpt.com/c/a'])assert.equal(c.conversationURL(url),null,url);
  assert.equal(c.conversationURL('https://chat.deepseek.com/a/chat/s/abc?token=secret#part'),urls[1]);
  assert.equal(c.conversationURL('https://chatgpt.com/c/old?model=x'),'https://chatgpt.com/c/old');
});

test('mixed-provider bookmarks persist, deduplicate and delete only the chosen mapping',()=>{
  const {c}=scope();const pdfs=[{identity:'1:A',label:'A.pdf'}];
  for(const url of ['https://chatgpt.com/c/old',...urls])c.savePDFBookmarks(pdfs,url,'讨论');
  c.savePDFBookmarks(pdfs,urls[1]+'?ignored=1','DeepSeek');
  assert.equal(c.readPDFBookmarks()['1:A'].length,6);
  c.deletePDFBookmark('1:A',urls[1]);
  assert.equal(c.readPDFBookmarks()['1:A'].length,5);
  assert.ok(c.readPDFBookmarks()['1:A'].some(entry=>entry.url==='https://chatgpt.com/c/old'));
});

test('custom URLs persist safely while malformed stored preferences fall back to ChatGPT',()=>{
  const {c,prefs}=scope();const key='extensions.chatgpt-web-sidebar-demo.homeURL';
  assert.equal(c.sidebarHomeURL(),'https://chatgpt.com/');
  prefs.set(key,'https://example.org/chat');assert.equal(c.sidebarHomeURL(),'https://example.org/chat');
  for(const bad of ['javascript:alert(1)','file:///tmp/chat','https://user:password@example.org','https://example.org\\evil','not a url'])assert.throws(()=>c.normalizeSidebarURL(bad));
  prefs.set(key,'file:///secret');assert.equal(c.sidebarHomeURL(),'https://chatgpt.com/');
  assert.equal(c.normalizeSidebarURL(' https://www.kimi.com '),'https://www.kimi.com/');
});

// Semantic DOM fixtures exercise role/order boundaries independently of the
// selectors themselves; live provider markup is intentionally not claimed here.
function pageFixture(adapter) {
  function node(text,options={}) {
    return {nodeType:1,localName:'div',childNodes:[{nodeType:3,nodeValue:text}],textContent:text,
      getClientRects:()=>[{}],getAttribute:()=>null,contains:()=>false,matches:()=>false,
      closest:()=>options.composer?{}:null,querySelector:()=>null,querySelectorAll:()=>[]};
  }
  const user=node('QUESTION');const answer=node('ANSWER');const draft=node('DRAFT',{composer:true});
  const doc={title:'讨论',location:{href:urls.find(url=>cSite(url)===adapter.id),origin:adapter.origin},querySelectorAll(selector){
    if(selector===adapter.user)return [user,draft];if(selector===adapter.assistant)return [answer];
    if(selector===adapter.user+','+adapter.assistant)return [user,answer,draft];return [];
  }};
  function cSite(url){return scope().c.siteAdapter(url)?.id;}
  return {doc,user,answer};
}

test('provider export keeps DOM order and roles, excludes composer, and labels each assistant correctly',()=>{
  const {c}=scope();
  for(const url of urls){
    const adapter=c.siteAdapter(url);const {doc}=pageFixture(adapter);
    const snapshot=c.collectConversationSnapshot(doc,adapter);
    assert.deepEqual(Array.from(snapshot.messages,m=>[m.role,m.markdown]),[['user','QUESTION'],['assistant','ANSWER']]);
    assert.equal(snapshot.provider,adapter.name);
    assert.equal(snapshot.scope,'loaded-page');
    assert.match(c.conversationMarkdown({title:'文献'},snapshot,'标题'),new RegExp(adapter.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    doc.querySelectorAll=()=>[];
    assert.throws(()=>c.collectConversationSnapshot(doc,adapter),/未能同时识别/);
  }
});

test('serialized provider extraction makes no ChatGPT credential request and refuses origin changes',async()=>{
  for(const url of urls){
    const {c}=scope();const adapter=c.siteAdapter(url);const {doc}=pageFixture(adapter);const outputs=[];
    const page={document:doc,fetch:()=>{throw new Error('must not fetch credentials');},removeEventListener(){}};
    const frame=scope({content:page,sendAsyncMessage:(_,value)=>outputs.push(value),removeMessageListener(){}}).c;
    vm.runInContext(`(${c.extractConversationInFrame.toString()})('test',${c.collectConversationSnapshot.toString()},null,${JSON.stringify(adapter)})`,frame);
    assert.equal(outputs[0].provider,adapter.name);
    doc.location.origin='https://evil.example';outputs.length=0;
    await frame.extractConversationInFrame('test',frame.collectConversationSnapshot,null,adapter);
    assert.match(outputs[0].error,/其他网站/);
  }
});

test('only China GLM is offered as a preset while old Z.ai bookmarks remain readable', () => {
  const { c } = scope();
  const china = c.siteAdapter().find(site => site.name.includes('GLM'));
  assert.equal(china.home, 'https://chatglm.cn/');
  assert.ok(!c.siteAdapter().some(site => site.home === 'https://chat.z.ai/'));
  assert.match(china.name, /智谱清言/);
  assert.equal(c.siteAdapter('https://chat.z.ai/c/old').name, 'Z.ai');
  assert.equal(c.conversationURL('https://chat.z.ai/c/old'), 'https://chat.z.ai/c/old');
});

test('old international homepage resolves to China without rewriting conversation bookmarks', () => {
  const { c, prefs } = scope();
  prefs.set('extensions.chatgpt-web-sidebar-demo.homeURL', 'https://chat.z.ai/');
  assert.equal(c.sidebarHomeURL(), 'https://chatglm.cn/');
  assert.equal(c.conversationURL('https://chat.z.ai/c/old'), 'https://chat.z.ai/c/old');
});

test('AI Studio preset and saved prompt routes support bookmarks but reject unsaved prompts', () => {
  const { c } = scope();
  const studio = c.siteAdapter().find(site => site.id === 'aistudio');
  assert.equal(studio.home, 'https://aistudio.google.com/prompts/new_chat');
  for (const path of ['/prompts/abc123', '/u/1/prompts/abc123', '/app/prompts/abc123']) {
    assert.equal(c.conversationURL('https://aistudio.google.com' + path + '?model=x'), 'https://aistudio.google.com' + path);
  }
  for (const path of ['/', '/prompts/new_chat', '/prompts/new_prompt', '/u/1/prompts/new_chat']) {
    assert.equal(c.conversationURL('https://aistudio.google.com' + path), null);
  }
  assert.equal(c.siteAdapter('https://aistudio.google.com.evil.example/prompts/abc'), null);
  assert.equal(c.conversationURL('https://gemini.google.com/u/1/app/abc'), 'https://gemini.google.com/u/1/app/abc');
});

test('AI Studio loaded DOM export retains explicit roles and omits thinking sections', () => {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(`<html><body>
    <ms-chat-turn><div class="chat-turn-container user"><div>Question</div></div></ms-chat-turn>
    <ms-chat-turn><div class="chat-turn-container model"><ms-thought-accordion>Thinking</ms-thought-accordion><ms-cmark-node><p>Answer</p></ms-cmark-node></div></ms-chat-turn>
    <ms-prompt-box><textarea>Draft</textarea></ms-prompt-box></body></html>`);
  window.Element.prototype.getClientRects = () => [{}];
  document.location = { href: 'https://aistudio.google.com/prompts/abc' };
  const { c } = scope();
  const snapshot = c.collectConversationSnapshot(document, c.siteAdapter(document.location.href));
  assert.equal(snapshot.provider, 'Google AI Studio');
  assert.deepEqual(Array.from(snapshot.messages, item => [item.role, item.markdown]), [['user', 'Question'], ['assistant', 'Answer']]);
});

test('bookmark titles strip provider suffix before the menu appends the provider name', () => {
  const { c } = scope();
  for (const name of ['Gemini', 'Google AI Studio', 'ChatGPT', 'DeepSeek', 'Kimi']) {
    assert.equal(c.bookmarkTitle('Discussion - ' + name, 'https://gemini.google.com/app/abc'), 'Discussion');
  }
});
