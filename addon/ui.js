/* Plugin UI only: never translate website content, paper titles or chat text. */
var SIDEBAR_LANGUAGE_PREF = 'extensions.chatgpt-web-sidebar-demo.language';
var SIDEBAR_ENGLISH = {
  '打开 / 收起网页': 'Show / hide webpage',
  '上传当前 PDF': 'Upload current PDF',
  '在底部显示': 'Show at bottom',
  '打开首页': 'Open homepage',
  '刷新网页': 'Reload webpage',
  '切换网页': 'Switch website',
  '导出对话': 'Export conversation',
  '保存书签': 'Save bookmark',
  '对话书签': 'Conversation bookmarks',
  'AI 网页': 'AI webpage',
  'GLM / 智谱清言': 'GLM / ChatGLM',
  '当前 PDF / 所选文献暂无书签': 'No bookmarks for the current PDF / selection',
  '打开对话': 'Open conversation',
  '删除此书签': 'Delete bookmark',
  '自定义网址…': 'Custom URL…',
  '自定义网址': 'Custom URL',
  '网页地址': 'Web address',
  '打开': 'Open',
  '取消': 'Cancel',
  '全选': 'Select all',
  '取消全选': 'Deselect all',
  '选择 PDF': 'Select PDFs',
  '选择 PDF…': 'Selecting PDFs…',
  '正在添加…': 'Adding…',
  '打开网页、上传当前 PDF': 'Open webpage or upload the current PDF',
  '{name} 网页侧栏': '{name} sidebar',
  '{name} 网页': '{name} webpage',
  '调整 AI 网页侧栏宽度': 'Resize webpage sidebar width',
  '调整 AI 网页面板高度': 'Resize webpage panel height',
  '拖动后松手应用；最右收起，最左全宽；双击复位': 'Drag and release to resize; right edge to hide, left edge for full width; double-click to reset',
  '拖动后松手应用；最下收起，最上展开；双击复位': 'Drag and release to resize; bottom edge to hide, top edge for full height; double-click to reset',
  '网页全高': 'Full height',
  '网页全宽': 'Full width',
  '{size} 像素': '{size} pixels',
  '松手收起': 'Release to hide',
  '松手完全展开': 'Release to expand',
  '已向网页提交 {count} 个 PDF': 'Submitted {count} PDFs to the webpage',
  '上传 PDF': 'Upload PDF',
  'PDF 对话书签': 'PDF conversation bookmarks',
  '已为 {count} 个 PDF 保存当前对话书签。': 'Saved this conversation as a bookmark for {count} PDFs.',
  '已在“{title}”下新增{format}。': 'Added {format} under “{title}”.',
  'Zotero 笔记': 'Zotero note',
  'HTML 附件': 'HTML attachment',
  'Markdown 附件': 'Markdown attachment',
  '选择要关联到当前对话的 PDF': 'Select PDFs to bookmark this conversation',
  '选择要添加的 PDF': 'Select PDFs to add',
  '已选 {selected} / {total} 个 PDF': '{selected} / {total} PDFs selected',
  '保存 {count} 个 PDF 的书签': 'Bookmark {count} PDFs',
  '添加 {count} 个 PDF': 'Add {count} PDFs',
  '{title}（{count} 个 PDF）': '{title} ({count} PDFs)',
  '没有 PDF 附件': 'No PDF attachments',
  '导出对话预览': 'Export conversation preview',
  '保存到：{title}': 'Save under: {title}',
  '文件标题：': 'File title:',
  '{provider} 对话 — {title}': '{provider} conversation — {title}',
  '保存格式：': 'Format:',
  'Markdown 文件': 'Markdown file',
  '第 {number} 轮（{count} 条消息）': 'Round {number} ({count} messages)',
  '我': 'Me',
  '新增 Zotero 笔记': 'Add Zotero note',
  '新增 HTML 附件': 'Add HTML attachment',
  '新增 Markdown 附件': 'Add Markdown attachment',
  '已选 {selected} / {total} 轮 · {count} 条消息': '{selected} / {total} rounds selected · {count} messages',
  '未能同时识别用户消息和 AI 回复': 'Could not identify both user messages and AI replies',
  '网页加载失败，请从工具菜单重试。': 'Could not load the webpage. Try again from the Tools menu.',
  '当前自定义站点尚未适配文件上传，请使用网页自身的附件按钮。': 'Use the website’s attachment button to upload files on this custom site.',
  '选择文件期间网页已切换，未添加附件，请在目标会话重试。': 'The webpage changed while selecting files. Open the intended conversation and try again.',
  '当前网页尚未加载或未适配，请进入已支持的网站并完成登录后重试。': 'Open a supported website and sign in before trying again.',
  '请先在文献库中选择文献条目或 PDF 附件。': 'Select a library item or PDF attachment first.',
  '网页浏览器暂未就绪，请刷新网页后重试。': 'The webpage is not ready. Reload it and try again.',
  '无法将文件交给网页，请使用网页附件按钮上传。': 'Could not submit the files. Use the website’s attachment button.',
  '无法连接网页文件入口，请刷新网页后重试。': 'Could not access the file uploader. Reload the webpage and try again.',
  '无法连接网页附件控件，请刷新后重试。': 'Could not access the attachment control. Reload and try again.',
  '上传已取消。': 'Upload cancelled.',
  '网页附件入口已变化，请重试。': 'The attachment control changed. Please try again.',
  '未找到唯一的 PDF 上传控件，请打开网页附件入口后重试。': 'Open the website’s attachment menu and try again.',
  '网页当前控件只支持单个附件，请逐个选择 PDF 添加。': 'This uploader accepts one attachment at a time. Add the PDFs individually.',
  '添加文件失败。': 'Could not add the files.',
  '当前网页还没有正式会话地址。请先在网页中发送消息并进入对话，再保存书签。': 'Send a message and open the conversation before saving a bookmark.',
  '无法识别所选 PDF，请重新选择文献或 PDF。': 'Could not identify the selected PDF. Select the item or PDF again.',
  '选择期间网页已切换或侧栏已卸载，未保存书签。请在目标对话中重试。': 'The webpage changed or the sidebar closed. Open the intended conversation and try again.',
  '书签数据格式错误，未修改原数据。': 'Could not read the bookmarks. Existing data was left unchanged.',
  '请选中一篇文献条目，或打开属于该文献的 PDF。独立附件不能作为保存目标。': 'Select a regular library item or open its PDF. Standalone attachments cannot be used as the destination.',
  '请先选择一篇文献，对话将保存到它的条目下。': 'Select one library item to save the conversation under.',
  '目标文献已不存在或已删除，未保存。': 'The destination item no longer exists. Nothing was saved.',
  '当前文献库不允许编辑，请选择可编辑的文献库。': 'Select a library that you can edit.',
  '当前文献库不允许添加文件附件，可改为保存 Zotero 笔记。': 'This library does not allow file attachments. Save a Zotero note instead.',
  '请先打开 ChatGPT 网页，并进入要保存的对话。': 'Open the webpage and the conversation you want to export first.',
  '没有提取到可保存的对话，请确认消息已加载。': 'No conversation was found. Make sure the messages have loaded.',
  '提取对话超时，请等网页加载后重试。': 'Reading the conversation timed out. Wait for the webpage to load and try again.',
  '导出已取消。': 'Export cancelled.',
  '无法读取当前网页。': 'Could not read the current webpage.',
  '提取期间网页已切换，未保存。': 'The webpage changed during export. Nothing was saved.',
  '导出期间网页已切换，未保存。': 'The webpage changed during export. Nothing was saved.',
  '网页已切换到其他网站，未提取对话。': 'The webpage changed to another website. No conversation was extracted.',
  '网页仍在生成回复，请完成后再保存。': 'Wait for the reply to finish before exporting.',
  '网页已切换，未保存。': 'The webpage changed. Nothing was saved.',
  '当前网站尚未适配对话导出。': 'Conversation export is not available for this website.',
  'ChatGPT 仍在生成回复，请完成后再保存。': 'Wait for ChatGPT to finish its reply before exporting.',
  '请进入有正式地址的 ChatGPT 对话后再导出。': 'Open a saved ChatGPT conversation before exporting.',
  '导出期间网页已切换，未保存。请回到目标对话后重试。': 'The webpage changed during export. Return to the intended conversation and try again.',
  '导出已取消或网页已切换。': 'Export was cancelled or the webpage changed.',
  '提取对话失败。': 'Could not extract the conversation.',
  '当前分支没有可导出的消息。': 'There are no messages to export in this branch.',
  '对话过大，未截断或保存。': 'This conversation is too large to export at once.',
  '没有找到已加载的对话消息；请进入对话并等待加载完成。': 'Open a conversation and wait for its messages to load.',
  '当前对话内容过大，暂不能一次导出；未截断或保存文件。': 'This conversation is too large to export at once.',
  '无法加载导出组件，请重新启用插件。': 'Could not load the exporter. Re-enable the plugin and try again.',
  '未知保存格式，未保存。': 'Unsupported export format. Nothing was saved.',
  '当前对话地址无效，未保存。': 'The current conversation address is invalid. Nothing was saved.',
  '请至少选择一轮对话。': 'Select at least one conversation round.',
  '请填写完整的 http:// 或 https:// 网页地址，不能包含用户名或密码。': 'Enter a complete http:// or https:// address without a username or password.',
  '网页地址无效，请检查后重试。': 'Invalid web address. Check it and try again.',
  '当前标签页不是 PDF，请切换到要上传的 PDF。': 'Switch to the PDF you want to upload.',
  '所选条目没有 PDF 附件。': 'The selected items have no PDF attachments.',
  '网页地址与所选网站不符，未添加附件。': 'The webpage does not match the selected website. No attachment was added.',
  '未能唯一定位当前聊天附件按钮，请关闭其他编辑框后重试。': 'Close any other message editors and try again.',
  '未能定位当前附件区域，请使用网页附件按钮。': 'Use the website’s attachment button to add this file.',
  '没有选择 PDF。': 'No PDF was selected.',
  '检测到多个聊天输入框，无法确定附件目标。请关闭消息编辑框后重试。': 'Close any message editing boxes and try uploading again.',
  '未识别到聊天输入框，请等待网页加载并确认已登录后重试。': 'Wait for the webpage to load and make sure you are signed in.',
  '已尝试展开 Gemini 的“＋”菜单，但网页尚未创建 PDF 文件控件。': 'Tried opening Gemini’s + menu, but its PDF uploader is not ready.',
  '无法确定 Gemini 的“＋（上传和工具）”按钮，未添加 PDF。': 'Could not identify Gemini’s “+ (Upload & tools)” button. No PDF was added.',
  '未找到 Gemini 的“＋（上传和工具）”按钮，未添加 PDF。': 'Could not find Gemini’s “+ (Upload & tools)” button. No PDF was added.',
  'Gemini 有多个或无法确定归属的 PDF 文件控件，请关闭其他附件窗口后重试。': 'Close other attachment windows in Gemini and try again.',
  'Gemini 尚未提供 PDF 文件控件，请先展开网页附件入口后重试。': 'Open Gemini’s attachment menu and try again.',
  '会话分支数据不完整。': 'The conversation data is incomplete.',
  '会话标识不匹配。': 'The conversation does not match the current page.',
  '会话分支结构异常。': 'Could not read the conversation branch.',
  '会话分支缺少历史节点。': 'Some conversation history is missing.',
  'PDF 尚未下载或文件已丢失：{name}': 'PDF is not downloaded or is missing: {name}',
  '无法显示 PDF 选择框：{error}': 'Could not display the PDF selector: {error}',
};

function sidebarLanguage() {
  try {
    const saved = Services.prefs.getStringPref(SIDEBAR_LANGUAGE_PREF, '');
    if (['zh-CN', 'en'].includes(saved)) return saved;
  } catch (_) {}
  // Use Zotero's active UI locale, not the operating system or embedded website.
  let locale = '';
  try { locale = Zotero.locale; } catch (_) {}
  if (!locale) { try { locale = Services.locale.appLocaleAsBCP47 || Services.locale.appLocalesAsBCP47?.[0]; } catch (_) {} }
  return /^zh(?:[-_]|$)/i.test(locale || '') ? 'zh-CN' : 'en';
}

function sidebarText(source, values = {}) {
  const text = sidebarLanguage() === 'en' && Object.hasOwn(SIDEBAR_ENGLISH, source) ? SIDEBAR_ENGLISH[source] : source;
  return text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

function sidebarAlert(window, title, message) {
  let translated = sidebarText(message);
  if (sidebarLanguage() === 'en') {
    for (const [prefix, source, key] of [
      ['PDF 尚未下载或文件已丢失：', 'PDF 尚未下载或文件已丢失：{name}', 'name'],
      ['无法显示 PDF 选择框：', '无法显示 PDF 选择框：{error}', 'error'],
    ]) {
      if (message.startsWith(prefix)) translated = sidebarText(source, { [key]: message.slice(prefix.length) });
    }
  }
  Zotero.alert(window, sidebarText(title), translated);
}

function bindSidebarText(state, node, attribute, source) {
  const refresh = () => node.setAttribute(attribute, typeof source === 'function' ? source() : sidebarText(source));
  (state.localeBindings ||= []).push(refresh);
  refresh();
}

function styleSidebarMenu(node, icon = 'blank') {
  node.setAttribute('class', node.localName === 'menu' ? 'menu-iconic' : 'menuitem-iconic');
  node.setAttribute('image', `${addonRootURI || ''}icons/${icon}.svg`);
  node.style.setProperty('-moz-context-properties', 'fill,fill-opacity');
  node.style.setProperty('fill', 'currentColor');
}

function setSidebarLanguage(language) {
  if (!['zh-CN', 'en'].includes(language)) return;
  Services.prefs.setStringPref(SIDEBAR_LANGUAGE_PREF, language);
  for (const state of sidebarWindows.values()) state.refreshLocale?.();
}

function appendLanguageMenu(window, state, parent) {
  const doc = window.document;
  parent.append(doc.createXULElement('menuseparator'));
  const menu = doc.createXULElement('menu');
  menu.setAttribute('data-sidebar-menu', 'language');
  styleSidebarMenu(menu, 'language');
  bindSidebarText(state, menu, 'label', () => sidebarLanguage() === 'zh-CN' ? 'Language' : '语言');
  bindSidebarText(state, menu, 'lang', () => sidebarLanguage() === 'zh-CN' ? 'en' : 'zh-CN');
  const popup = doc.createXULElement('menupopup');
  const choices = [];
  // Autonyms stay readable regardless of the currently selected UI language.
  for (const [locale, name] of [['zh-CN', '简体中文'], ['en', 'English']]) {
    const item = doc.createXULElement('menuitem');
    item.setAttribute('label', name);
    item.setAttribute('lang', locale);
    item.setAttribute('type', 'radio');
    item.setAttribute('autocheck', 'false');
    styleSidebarMenu(item);
    item.addEventListener('command', () => setSidebarLanguage(locale));
    choices.push({ item, locale });
    popup.append(item);
  }
  const refresh = () => choices.forEach(({ item, locale }) => item.setAttribute('checked', String(sidebarLanguage() === locale)));
  (state.localeBindings ||= []).push(refresh);
  popup.addEventListener('popupshowing', event => { if (event.target === popup) refresh(); });
  refresh();
  menu.append(popup);
  parent.append(menu);
}
