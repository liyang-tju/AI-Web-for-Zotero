/* Site-specific selectors and conversation routes. Shared export/upload code
 * must never infer roles by alternating messages or use a page-wide file area. */
function siteAdapter(value) {
  const common = {
    editor: 'textarea, [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]',
    composer: 'form, input-container, .input-container, .chat-input, .chat-editor, .message-input, [data-testid="composer"]',
    stop: 'button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="停止回答"], button[data-testid="stop-button"], button.stop-button',
    user: '[data-message-author-role="user"], [data-role="user"]',
    assistant: '[data-message-author-role="assistant"], [data-role="assistant"]',
    answer: '.markdown, .markdown-body, .message-content',
  };
  const sites = [
    { id: 'chatgpt', name: 'ChatGPT', home: 'https://chatgpt.com/', hosts: ['chatgpt.com'], route: /^\/(?:g\/[\w-]+\/)?c\/[\w-]+\/?$/ },
    { id: 'gemini', name: 'Gemini', home: 'https://gemini.google.com/app', hosts: ['gemini.google.com'], route: /^\/(?:u\/\d+\/)?app\/[\w-]+\/?$/,
      user: 'user-query', assistant: 'model-response', answer: 'message-content .markdown, message-content',
      editor: '.rich-textarea [contenteditable]:not([contenteditable="false"]), [role="textbox"][contenteditable]:not([contenteditable="false"]), rich-textarea [contenteditable]:not([contenteditable="false"]), .ql-editor[contenteditable]:not([contenteditable="false"]), textarea[aria-label], textarea[placeholder]',
      composer: 'input-area-v2, .input-area-v2, input-area, .input-area, .text-input-field, input-container, form',
      fileInputOwner: 'images-files-uploader',
      fileInputScope: 'input-area-v2, .input-area-v2, input-area, .input-area, .text-input-field, input-container',
      uploadMenuButton: [
        'button[aria-label="Upload & tools"]', 'button[aria-label="上传和工具"]',
        'button[aria-label="上傳和工具"]',
        'gem-icon-button[arialabel="Upload & tools"]', 'gem-icon-button[arialabel="上传和工具"]',
        'gem-icon-button[arialabel="上傳和工具"]',
        'gem-icon-button[aria-label="Upload & tools"]', 'gem-icon-button[aria-label="上传和工具"]',
        'button[aria-label="Open upload file menu"]', 'button[aria-label="打开上传文件菜单"]',
        'button[aria-label="打开文件上传菜单"]', 'button[aria-haspopup="menu"][aria-label="添加文件"]',
        'button[aria-haspopup="menu"][aria-label="Add files"]',
      ].join(', '),
      uploadMenuIcon: 'button[aria-haspopup="menu"] mat-icon[data-mat-icon-name="add_2"], button[aria-haspopup="menu"] mat-icon[fonticon="add"]',
      stop: '.stop-button, button[aria-label="Stop response"], button[aria-label="停止回答"]' },
    { id: 'aistudio', name: 'Google AI Studio', home: 'https://aistudio.google.com/prompts/new_chat', hosts: ['aistudio.google.com'],
      route: /^\/(?:u\/\d+\/)?(?:app\/)?prompts\/(?!new_chat\/?$|new_prompt\/?$)[\w-]+\/?$/,
      editor: 'ms-prompt-box textarea, ms-prompt-input-wrapper textarea, ms-autosize-textarea textarea, textarea.textarea',
      editorGroups: ['ms-prompt-box textarea, ms-prompt-input-wrapper textarea', 'ms-autosize-textarea textarea'],
      editorExclude: 'ms-chat-turn, ms-system-instruction, ms-system-instructions, [role="dialog"]',
      composer: 'ms-prompt-box, ms-prompt-input-wrapper, .prompt-box-container, .prompt-input-wrapper, .input-wrapper, form',
      user: 'ms-chat-turn .chat-turn-container.user',
      assistant: 'ms-chat-turn .chat-turn-container.model',
      userContainers: [{ selector: 'ms-chat-turn', contains: '[data-turn-role="User"]' }],
      assistantContainers: [{ selector: 'ms-chat-turn', contains: '[data-turn-role="Model"]' }],
      history: 'ms-chat-turn',
      answer: 'ms-cmark-node, .markdown',
      stop: 'ms-run-button button[aria-label="Stop"], button[aria-label="Stop generating"]' },
    { id: 'deepseek', name: 'DeepSeek', home: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'], route: /^\/a\/chat\/s\/[\w-]+\/?$/,
      // Whole bubbles also cover PDF-only turns with no fbb737a4 text node.
      user: '._9663006 > .ds-message, .ds-message.d29f3d7d, .ds-user-message, .fbb737a4, [data-message-author-role="user"], [data-role="user"]',
      assistant: '._4f9bf79 > .ds-message, .ds-assistant-message-main-content, [data-message-author-role="assistant"]',
      userContainers: [{ selector: '.ds-message', contains: '.ds-collapsible-text', excludes: '.ds-assistant-message-main-content, .ds-think-content' }],
      assistantContainers: [{ selector: '.ds-message', contains: '.ds-assistant-message-main-content' }],
      history: '.ds-message',
      answer: '.ds-markdown', exportExclude: '.ds-think-content, .ds-markdown--think, ._5255ff8, .ds-collapsible-text-toggle-button',
      editor: 'textarea#chat-input, textarea[placeholder], [contenteditable="true"][role="textbox"]' },
    { id: 'kimi', name: 'Kimi', home: 'https://www.kimi.com/', hosts: ['www.kimi.com', 'kimi.com', 'kimi.moonshot.cn'], route: /^\/chat\/[\w-]+\/?$/,
      user: '.chat-content-item-user, .segment-user', assistant: '.chat-content-item-assistant, .segment-assistant',
      answer: '.markdown, [class*="markdown"]', exportExclude: '.toolcall-container',
      composer: '.chat-input, .chat-editor, .chat-input-container, [data-testid="composer"], form' },
    { id: 'glm', name: 'Z.ai', preset: false, home: 'https://chat.z.ai/', hosts: ['chat.z.ai'], route: /^\/c\/[\w-]+\/?$/,
      user: '[id^="user-message-"], .user-message, [data-message-author-role="user"]',
      assistant: '[id^="response-message-"], .assistant-message, [data-message-author-role="assistant"]',
      composer: 'form, #chat-input-container, .chat-input' },
    { id: 'chatglm', name: 'GLM / 智谱清言', home: 'https://chatglm.cn/', hosts: ['chatglm.cn'], route: /^\/main\/alltoolsdetail(?:\/[\w-]+)?\/?$/,
      editor: '.input-box-inner textarea, textarea.scroll-display-none, textarea, [contenteditable="true"][role="textbox"]',
      composer: '.input-box, .input-box-inner, .input-container, .chat-input, form',
      user: '.question[id^="row-question-"], .conversation-item.user, .user-message, [data-role="user"]',
      question: '.question-txt, .question-file, .question-image-type',
      assistant: '.answer[id^="row-answer-"], .conversation-item.assistant, .assistant-message, [data-role="assistant"]',
      answer: '.markdown-body, .markdown, .message-content',
      exportExclude: '.text-thinking-content, .text-advance-thinking-content, .thinking-area, .advance-thinking-area, .tool-result-content, .assistant-name, .user-name, .user-img, .copy-btn' },
  ];
  // Keep old Z.ai bookmarks readable, but offer only China GLM in presets.
  if (value === undefined) return sites.filter(site => site.preset !== false).map(site => ({ ...common, ...site }));
  const match = String(value).match(/^https:\/\/([^\/:?#@]+)(\/[^?#]*)?(?:[?#].*)?$/i);
  if (!match) return null;
  const site = sites.find(site => site.hosts.includes(match[1].toLowerCase()));
  return site ? { ...common, ...site, origin: `https://${match[1].toLowerCase()}` } : null;
}

function providerConversationURL(value) {
  const site = siteAdapter(value);
  if (!site) return null;
  const path = String(value).match(/^https:\/\/[^/]+([^?#]*)/)?.[1] || '/';
  if (!site.route.test(path)) return null;
  if (site.id === 'chatglm') {
    const id = String(value).match(/[?&](?:cid|conversation_id)=([\w-]+)(?:[&#]|$)/)?.[1];
    if (!id) return null;
    return site.origin + path.replace(/\/$/, '') + '?cid=' + id;
  }
  return site.origin + path.replace(/\/$/, '');
}

function normalizeSidebarURL(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw) || /[\s\\\x00-\x1f]/.test(raw) || /^[^:]+:\/\/[^/?#]*@/.test(raw)) {
    throw new Error('请填写完整的 http:// 或 https:// 网页地址，不能包含用户名或密码。');
  }
  try {
    const uri = Services.io.newURI(raw);
    if (!uri.host || !['http', 'https'].includes(uri.scheme)) throw new Error();
    return uri.spec;
  } catch (_) { throw new Error('网页地址无效，请检查后重试。'); }
}
