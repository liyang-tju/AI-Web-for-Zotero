/* AI Web for Zotero: an independent Zotero 7–10 website sidebar. */
var sidebarWindows = new Map();
var stopped = false;
var addonRootURI = null;
var exportFormatScope = null;
var HOME_URL = "https://chatgpt.com/";
var HTML_NS = "http://www.w3.org/1999/xhtml";
var WIDTH_PREF = "extensions.chatgpt-web-sidebar-demo.width";
var HEIGHT_PREF = "extensions.chatgpt-web-sidebar-demo.height";
var pendingPDFPickers = new Map();
var BOOKMARK_PREF = "extensions.chatgpt-web-sidebar-demo.pdfBookmarks";
var BOTTOM_PREF = "extensions.chatgpt-web-sidebar-demo.bottom";
var pdfContextMenuID = null;
var sidebarLinkResource = null;

function install() {}
function uninstall() {}

async function startup(data) {
  stopped = false;
  addonRootURI = data.rootURI;
  for (const file of ["ui.js", "providers.js", "settings.js"]) Services.scriptloader.loadSubScript(addonRootURI + file, globalThis, "UTF-8");
  exportFormatScope = null;
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  if (stopped) return;
  registerSidebarLinks(data.version);
  for (const window of Zotero.getMainWindows()) attachSidebar(window);
  registerPDFContextMenu(data.id);
}

function onMainWindowLoad({ window }) {
  if (!stopped) attachSidebar(window);
}

function onMainWindowUnload({ window }) {
  removeSidebar(window);
}

function shutdown(data, reason) {
  stopped = true;
  if (reason === APP_SHUTDOWN) return;
  if (pdfContextMenuID) Zotero.MenuManager.unregisterMenu(pdfContextMenuID);
  pdfContextMenuID = null;
  for (const window of [...sidebarWindows.keys()]) removeSidebar(window);
  unregisterSidebarLinks();
}

function registerSidebarLinks(version) {
  if (sidebarLinkResource) return;
  // A versioned resource avoids reusing cached modules after a plugin update.
  const resource = `ai-web-sidebar-${version.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
  const protocol = Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsIResProtocolHandler);
  protocol.setSubstitution(resource, Services.io.newURI(addonRootURI));
  try {
    ChromeUtils.registerWindowActor("AIWebSidebarLinks", {
      parent: { esModuleURI: `resource://${resource}/actors/AIWebSidebarLinksParent.mjs` },
      child: {
        esModuleURI: `resource://${resource}/actors/AIWebSidebarLinksChild.mjs`,
        events: { click: { capture: true }, auxclick: { capture: true } },
      },
      messageManagerGroups: ["aiWebSidebar"],
    });
    sidebarLinkResource = resource;
  } catch (error) {
    protocol.setSubstitution(resource, null);
    throw error;
  }
}

function unregisterSidebarLinks() {
  if (!sidebarLinkResource) return;
  ChromeUtils.unregisterWindowActor("AIWebSidebarLinks");
  Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsIResProtocolHandler)
    .setSubstitution(sidebarLinkResource, null);
  sidebarLinkResource = null;
}

function registerPDFContextMenu(pluginID) {
  // MenuManager was introduced in Zotero 8. Prefer capabilities over version
  // strings, including builds that backport the official API.
  if (pdfContextMenuID || !hasPDFMenuManager()) return;
  pdfContextMenuID = Zotero.MenuManager.registerMenu({
    menuID: "ai-web-sidebar-upload-pdf",
    pluginID,
    target: "main/library/item",
    menus: [{
      menuType: "menuitem",
      icon: addonRootURI + "icons/upload.svg",
      onShowing(_event, context) {
        updatePDFContextMenu(context);
      },
      onCommand(_event, context) {
        const window = context.menuElem.ownerDocument.defaultView;
        // Zotero supplies the selection from the context menu that was opened.
        // Never substitute another reader or a later library selection.
        return sidebarWindows.get(window)?.uploadSelectedPDFs([...(context.items || [])]);
      },
    }],
  });
}

function hasPDFMenuManager() {
  return typeof Zotero.MenuManager?.registerMenu === "function"
    && typeof Zotero.MenuManager?.unregisterMenu === "function";
}

function updatePDFContextMenu(context) {
  context.menuElem.setAttribute("label", sidebarText("上传 PDF"));
  const window = context.menuElem.ownerDocument.defaultView;
  const state = sidebarWindows.get(window);
  const hasPDF = pdfGroups(context.items || []).some(group => group.attachments.length);
  context.setVisible(hasPDF);
  context.setEnabled(hasPDF && !!state && !state.uploading && !state.savingBookmark && !state.exporting);
}

function attachLegacyPDFContextMenu(window, state) {
  if (hasPDFMenuManager() || state.cleanupPDFContextMenu) return;
  const popup = window.document.getElementById("zotero-itemmenu");
  if (!popup) return;
  const menu = window.document.createXULElement("menuitem");
  menu.id = "ai-web-sidebar-upload-pdf";
  menu.setAttribute("class", "menuitem-iconic");
  menu.setAttribute("image", addonRootURI + "icons/upload.svg");
  menu.hidden = true;
  let selectedItems = [];
  const onShowing = event => {
    // Submenu popup events bubble through the library popup too.
    if (event.target !== popup) return;
    selectedItems = [...(window.ZoteroPane?.getSelectedItems() || [])];
    updatePDFContextMenu({
      menuElem: menu, items: selectedItems,
      setVisible: visible => { menu.hidden = !visible; },
      setEnabled: enabled => { menu.disabled = !enabled; },
    });
  };
  const onCommand = () => {
    if (menu.hidden || menu.disabled || sidebarWindows.get(window) !== state) return;
    // Keep the opening selection even if the library selection changes. Do not
    // clear on popuphidden: on some platforms it precedes command delivery.
    return state.uploadSelectedPDFs([...selectedItems]);
  };
  popup.append(menu);
  popup.addEventListener("popupshowing", onShowing);
  menu.addEventListener("command", onCommand);
  state.cleanupPDFContextMenu = () => {
    popup.removeEventListener("popupshowing", onShowing);
    menu.removeEventListener("command", onCommand);
    menu.remove();
    selectedItems = [];
    state.cleanupPDFContextMenu = null;
  };
}

function attachSidebar(window) {
  if (sidebarWindows.has(window)) return;
  const doc = window.document;
  // This native horizontal container holds both library and reader tabs.
  const host = doc.getElementById("browser");
  const appContent = doc.getElementById("appcontent");
  const toolbar = doc.getElementById("zotero-tabs-toolbar");
  if (!host || !appContent || !toolbar) return;
  // XUL's content minimum can otherwise push this sibling beyond the window:
  // the visible divider then no longer matches the browser's actual geometry.
  const originalContentStyle = appContent.getAttribute("style");
  const originalContentDisplay = appContent.style.display || "";
  const originalHostStyle = host.getAttribute("style");
  // Zotero's fixed loading cover otherwise spans the AI panel as well when an
  // unloaded reader tab is selected. Keep it inside the native content area.
  const tabCover = doc.getElementById("zotero-tab-cover");
  const originalCoverStyle = tabCover?.getAttribute("style");
  appContent.style.setProperty("position", "relative");
  if (tabCover) {
    tabCover.style.setProperty("position", "absolute");
    tabCover.style.setProperty("inset", "0");
    tabCover.style.setProperty("height", "auto");
  }
  appContent.style.setProperty("min-width", "0");
  appContent.style.setProperty("min-height", "0");
  appContent.style.setProperty("flex", "1 1 0px");
  appContent.style.setProperty("overflow", "hidden");

  const panel = doc.createXULElement("vbox");
  panel.id = "chatgpt-web-demo-panel";
  panel.setAttribute("aria-label", "ChatGPT 网页侧栏");
  panel.style.cssText = "min-width:0;min-height:0;flex:0 0 auto;overflow:hidden;background:var(--material-background,#fff);";
  panel.hidden = true;

  const divider = doc.createElementNS(HTML_NS, "div");
  divider.id = "chatgpt-web-demo-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-label", "调整 AI 网页侧栏宽度");
  divider.setAttribute("aria-orientation", "vertical");
  divider.tabIndex = 0;
  divider.title = "拖动后松手应用；最右收起，最左全宽；双击复位";
  divider.style.cssText = "box-sizing:border-box;width:12px;min-width:12px;flex:0 0 12px;cursor:col-resize;touch-action:none;user-select:none;-moz-window-dragging:no-drag;position:relative;z-index:10;background:var(--material-background,#eee);border-inline:1px solid #8888;";
  const grip = doc.createElementNS(HTML_NS, "span");
  grip.textContent = "⋮";
  grip.setAttribute("aria-hidden", "true");
  grip.style.cssText = "pointer-events:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:10px;height:64px;display:flex;align-items:center;justify-content:center;border-radius:5px;background:#777;color:white;font:22px system-ui;box-shadow:0 0 0 1px #fff5;";
  divider.append(grip);
  divider.addEventListener("pointerenter", () => { grip.style.background = "#4072e5"; });
  divider.addEventListener("pointerleave", () => { grip.style.background = "#777"; });
  divider.hidden = true;

  const browser = doc.createXULElement("browser");
  browser.id = "chatgpt-web-demo-browser";
  browser.setAttribute("type", "content");
  browser.setAttribute("remote", "true");
  browser.setAttribute("maychangeremoteness", "true");
  browser.setAttribute("disableglobalhistory", "true");
  browser.setAttribute("messagemanagergroup", "aiWebSidebar");
  browser.setAttribute("flex", "1");
  browser.setAttribute("aria-label", "ChatGPT 网页");
  browser.style.cssText = "min-width:0;min-height:0;flex:1;background:var(--material-background,Canvas);";

  const state = { panel, divider, browser, loaded: false, cleanupDrag: null, button: null, menu: null, popup: null, uploading: false, uploadItems: [], cancelUpload: null, cleanupLayout: null };
  let preferredWidth = Services.prefs.getIntPref(WIDTH_PREF, 520);
  let preferredHeight = Services.prefs.getIntPref(HEIGHT_PREF, 400);
  let bottom = Services.prefs.getBoolPref(BOTTOM_PREF, false);
  const positionItems = [];
  const preferredSize = () => bottom ? preferredHeight : preferredWidth;
  const defaultSize = () => bottom ? 400 : 520;
  const dimension = () => bottom ? "height" : "width";
  let dragging = false;
  let expandedPanel = false;
  function applyPosition() {
    host.style.setProperty("flex-direction", bottom ? "column" : "row");
    panel.style.width = "auto";
    panel.style.height = "auto";
    divider.style.width = bottom ? "auto" : "12px";
    divider.style.minWidth = bottom ? "0" : "12px";
    divider.style.height = bottom ? "12px" : "auto";
    divider.style.minHeight = bottom ? "12px" : "0";
    divider.style.cursor = bottom ? "row-resize" : "col-resize";
    divider.setAttribute("aria-orientation", bottom ? "horizontal" : "vertical");
    refreshDividerText();
    grip.style.width = bottom ? "64px" : "10px";
    grip.style.height = bottom ? "10px" : "64px";
    grip.textContent = bottom ? "⋯" : "⋮";
    positionItems.forEach(item => item.setAttribute("checked", String(bottom)));
    setSize(preferredSize());
  }
  function changePosition() {
    state.cleanupDrag?.();
    bottom = !bottom;
    Services.prefs.setBoolPref(BOTTOM_PREF, bottom);
    applyPosition();
    if (panel.hidden) toggle();
  }
  function refreshDividerText() {
    divider.setAttribute("aria-label", sidebarText(bottom ? "调整 AI 网页面板高度" : "调整 AI 网页侧栏宽度"));
    divider.title = sidebarText(bottom ? "拖动后松手应用；最下收起，最上展开；双击复位" : "拖动后松手应用；最右收起，最左全宽；双击复位");
    const size = divider.getAttribute("aria-valuenow");
    if (size !== null) divider.setAttribute("aria-valuetext", expandedPanel
      ? sidebarText(bottom ? "网页全高" : "网页全宽") : sidebarText("{size} 像素", { size }));
  }
  function setSize(width, persist = false, expanded = false) {
    const available = host.getBoundingClientRect()[dimension()] || (bottom ? window.innerHeight : window.innerWidth);
    expandedPanel = expanded;
    appContent.style.setProperty("display", expandedPanel ? "none" : originalContentDisplay);
    const actual = expandedPanel ? Math.max(0, available - 12) : clampSidebarWidth(width, available);
    panel.style[dimension()] = `${actual}px`;
    divider.setAttribute("aria-valuenow", String(actual));
    divider.setAttribute("aria-valuemin", "240");
    divider.setAttribute("aria-valuemax", String(Math.max(240, Math.floor(available - 12))));
    refreshDividerText();
    if (persist && !expandedPanel) {
      if (bottom) preferredHeight = actual;
      else preferredWidth = actual;
      Services.prefs.setIntPref(bottom ? HEIGHT_PREF : WIDTH_PREF, actual);
    }
  }
  let lastWindowWidth = window.innerWidth;
  let lastWindowHeight = window.innerHeight;
  const onResize = event => {
    // Reader layout notifications are not an outer-window resize. In particular,
    // they must never restore the saved width in the middle of a pointer drag.
    if (event.target !== window || (window.innerWidth === lastWindowWidth && window.innerHeight === lastWindowHeight)) return;
    lastWindowWidth = window.innerWidth;
    lastWindowHeight = window.innerHeight;
    if (!dragging) setSize(preferredSize(), false, expandedPanel);
  };
  window.addEventListener("resize", onResize);
  state.cleanupLayout = () => {
    window.removeEventListener("resize", onResize);
    if (originalContentStyle === null) appContent.removeAttribute("style");
    else appContent.setAttribute("style", originalContentStyle);
    if (originalHostStyle === null) host.removeAttribute("style");
    else host.setAttribute("style", originalHostStyle);
    if (tabCover) {
      if (originalCoverStyle === null) tabCover.removeAttribute("style");
      else tabCover.setAttribute("style", originalCoverStyle);
    }
  };
  applyPosition();
  function refreshSiteLabel(url) {
    const name = sidebarText(siteAdapter(url)?.name || "AI 网页");
    button.textContent = `${name} ▾`;
    panel.setAttribute("aria-label", sidebarText("{name} 网页侧栏", { name }));
    browser.setAttribute("aria-label", sidebarText("{name} 网页", { name }));
  }
  function switchWebsite(value) {
    if (state.uploading || state.exporting || state.savingBookmark) return;
    const url = normalizeSidebarURL(value);
    const currentURL = state.loaded ? browser.currentURI?.spec : null;
    const site = siteAdapter(url);
    // Picking the current site should not discard its conversation or draft.
    const sameSite = currentURL === url || (site?.home === url && site.id === siteAdapter(currentURL)?.id);
    if (!sameSite) {
      browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }
    Services.prefs.setStringPref("extensions.chatgpt-web-sidebar-demo.homeURL", url);
    state.loaded = true;
    refreshSiteLabel(url);
    if (panel.hidden) toggle();
  }
  function loadHome() {
    try {
      browser.loadURI(Services.io.newURI(sidebarHomeURL()), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      state.loaded = true;
      refreshSiteLabel(sidebarHomeURL());
    } catch (error) {
      Zotero.logError(error);
      sidebarAlert(window, "AI 网页", "网页加载失败，请从工具菜单重试。");
    }
  }
  function toggle() {
    const opening = panel.hidden;
    panel.hidden = !opening;
    divider.hidden = !opening;
    preservePageLayers();
    setSize(preferredSize());
    if (opening && !state.loaded) loadHome();
  }
  // A separate sibling of appcontent, never a Zotero item-pane section.
  // Keep the panel itself entirely reserved for the website.
  panel.append(browser);
  host.append(divider, panel);
  // Keep the visible remote browser's last painted frame while its window is
  // inactive. Release it when closed; no focus-triggered reload or re-layout.
  function preservePageLayers() {
    if (browser.frameLoader?.remoteTab) browser.preserveLayers?.(!panel.hidden);
  }
  browser.addEventListener("XULFrameLoaderCreated", preservePageLayers);
  state.cleanupRendering = () => {
    browser.removeEventListener("XULFrameLoaderCreated", preservePageLayers);
    if (browser.frameLoader?.remoteTab) browser.preserveLayers?.(false);
  };

  const button = doc.createElementNS(HTML_NS, "button");
  button.id = "chatgpt-web-demo-toggle";
  button.type = "button";
  button.textContent = `${sidebarText(siteAdapter(sidebarHomeURL())?.name || "AI 网页")} ▾`;
  button.title = sidebarText("打开网页、上传当前 PDF");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.style.cssText = "appearance:none;display:inline-flex;align-items:center;justify-content:center;align-self:center;box-sizing:border-box;height:24px;min-height:24px;font:12px/1 system-ui;margin:0 6px;padding:0 9px;border:1px solid #8885;border-radius:5px;background:var(--material-background,ButtonFace);color:inherit;white-space:nowrap;cursor:pointer;-moz-window-dragging:no-drag;";
  toolbar.prepend(button);
  state.button = button;

  async function uploadCurrentPDF(selectedItems = null) {
    if (state.uploading || state.savingBookmark || state.exporting) return;
    state.uploading = true;
    state.uploadItems.forEach(item => item.setAttribute("disabled", "true"));
    button.textContent = sidebarText("选择 PDF…");
    try {
      if (!state.loaded) loadHome();
      if (!siteAdapter(browser.currentURI?.spec || sidebarHomeURL())) throw new Error("当前自定义站点尚未适配文件上传，请使用网页自身的附件按钮。");
      const uploadURL = browser.currentURI?.spec;
      const attachments = await selectPDFAttachments(window, "upload", selectedItems);
      if (!attachments) return;
      button.textContent = sidebarText("正在添加…");
      const files = [];
      // Resolve every selected file before handing any of them to the website.
      for (const attachment of attachments) {
        const path = await attachment.getFilePathAsync();
        if (!path) throw new Error(`PDF 尚未下载或文件已丢失：${attachment.attachmentFilename || attachment.getField("title")}`);
        files.push(await window.File.createFromFileName(path, { type: "application/pdf" }));
      }
      if (panel.hidden) toggle();
      const uri = browser.currentURI;
      if (uploadURL && uri?.spec !== uploadURL) throw new Error("选择文件期间网页已切换，未添加附件，请在目标会话重试。");
      if (!siteAdapter(uri?.spec)) {
        throw new Error("当前网页尚未加载或未适配，请进入已支持的网站并完成登录后重试。");
      }
      // Pass a File through Gecko's structured-clone channel, not a local path
      // or base64 copy in page JavaScript. Only explicitly selected PDFs are sent.
      const result = await attachFilesToWebsite(window, state, files);
      if (!result.ok) throw new Error(result.error);
      button.title = sidebarText("已向网页提交 {count} 个 PDF", { count: files.length });

    } catch (error) {
      if (sidebarWindows.has(window)) sidebarAlert(window, "上传 PDF", error.message || String(error));
    } finally {
      state.uploading = false;
      state.uploadItems.forEach(item => item.removeAttribute("disabled"));
      refreshSiteLabel(browser.currentURI?.spec || sidebarHomeURL());
    }
  }
  state.uploadSelectedPDFs = uploadCurrentPDF;

  async function exportCurrentConversation() {
    if (state.uploading || state.savingBookmark || state.exporting) return;
    state.exporting = true;
    try {
      // Fix the parent at click time; selecting another reader during extraction
      // must not silently redirect the attachment to a different paper.
      const parent = currentExportParent(window);
      const raw = await requestConversationSnapshot(window, state);
      const snapshot = { ...raw, messages: raw.messages.map(message => ({ ...message, markdown: normalizeExportMarkdown(message.markdown, message.fileCitationMarkers) })) };
      if (!sidebarWindows.has(window)) return;
      const selection = await previewConversation(window, state, parent, snapshot);
      if (selection === null || !sidebarWindows.has(window)) return;
      await saveConversation(parent, selection.snapshot, selection.title, selection.format || "markdown");
      const formatName = { note: "Zotero 笔记", html: "HTML 附件", markdown: "Markdown 附件" }[selection.format || "markdown"];
      if (sidebarWindows.has(window)) sidebarAlert(window, "导出对话", sidebarText("已在“{title}”下新增{format}。", { title: parent.title, format: sidebarText(formatName) }));
    } catch (error) {
      if (sidebarWindows.has(window)) sidebarAlert(window, "导出对话", error.message || String(error));
    } finally { state.exporting = false; }
  }

  async function saveBookmark() {
    if (state.uploading || state.savingBookmark || state.exporting) return;
    state.savingBookmark = true;
    try {
      const count = await saveCurrentConversationBookmark(window, state);
      if (count) sidebarAlert(window, "PDF 对话书签", sidebarText("已为 {count} 个 PDF 保存当前对话书签。", { count }));
    } catch (error) {
      sidebarAlert(window, "PDF 对话书签", error.message || String(error));
    } finally { state.savingBookmark = false; }
  }

  function populateMenu(popup) {
    const actions = [
      ["打开 / 收起网页", toggle], ["上传当前 PDF", uploadCurrentPDF, "upload"],
      ["在底部显示", changePosition],
      null, ["打开首页", loadHome], ["刷新网页", () => browser.reload()],
      ["切换网页", null], null,
      ["导出对话", exportCurrentConversation, "share"], ["保存书签", saveBookmark, "bookmark"],
    ];
    for (const action of actions) {
      if (action && !action[1]) {
        appendWebsiteMenu(window, state, popup, switchWebsite);
        continue;
      }
      const item = doc.createXULElement(action ? "menuitem" : "menuseparator");
      if (action) {
        bindSidebarText(state, item, "label", action[0]);
        styleSidebarMenu(item, action[2]);
        item.addEventListener("command", () => action[1]());
        if (action[1] === uploadCurrentPDF) state.uploadItems.push(item);
        if (action[1] === changePosition) {
          item.setAttribute("type", "checkbox");
          item.setAttribute("autocheck", "false");
          item.setAttribute("checked", String(bottom));
          positionItems.push(item);
        }
      }
      popup.append(item);
    }
    const bookmarks = doc.createXULElement("menu");
    bookmarks.setAttribute("data-sidebar-menu", "bookmarks");
    bindSidebarText(state, bookmarks, "label", "对话书签");
    styleSidebarMenu(bookmarks);
    const entries = doc.createXULElement("menupopup");
    bookmarks.append(entries);
    popup.append(bookmarks);
    entries.addEventListener("popupshowing", event => {
      if (event.target !== entries) return;
      entries.replaceChildren();
      const items = currentPDFBookmarks(window);
      if (!items.length) {
        const empty = doc.createXULElement("menuitem");
        empty.setAttribute("label", sidebarText("当前 PDF / 所选文献暂无书签"));
        styleSidebarMenu(empty);
        empty.setAttribute("disabled", "true");
        entries.append(empty);
      }
      for (const entry of items) {
        const item = doc.createXULElement("menu");
        item.setAttribute("label", `${entry.title} · ${sidebarText(siteAdapter(entry.url)?.name || "AI")}`);
        styleSidebarMenu(item);
        item.setAttribute("crop", "center");
        item.style.maxWidth = "40em";
        const actions = doc.createXULElement("menupopup");
        const open = doc.createXULElement("menuitem");
        open.setAttribute("label", sidebarText("打开对话"));
        styleSidebarMenu(open);
        open.addEventListener("command", () => {
          if (state.uploading || state.savingBookmark || state.exporting) return;
          if (panel.hidden) toggle();
          browser.loadURI(Services.io.newURI(entry.url), {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          });
          state.loaded = true;
          refreshSiteLabel(entry.url);
        });
        const remove = doc.createXULElement("menuitem");
        remove.setAttribute("label", sidebarText("删除此书签"));
        styleSidebarMenu(remove);
        remove.addEventListener("command", () => {
          try {
            deletePDFBookmark(entry.identity, entry.url);
          } catch (error) { sidebarAlert(window, "PDF 对话书签", error.message || String(error)); }
        });
        if (state.uploading || state.savingBookmark || state.exporting) open.setAttribute("disabled", "true");
        actions.append(open, remove);
        item.append(actions);
        entries.append(item);
      }
    });
    appendLanguageMenu(window, state, popup);
  }
  const popup = doc.createXULElement("menupopup");
  popup.id = "chatgpt-web-demo-menu";
  populateMenu(popup);
  doc.documentElement.append(popup);
  state.popup = popup;
  popup.addEventListener("popupshown", event => { if (event.target === popup) button.setAttribute("aria-expanded", "true"); });
  popup.addEventListener("popuphidden", event => { if (event.target === popup) button.setAttribute("aria-expanded", "false"); });
  button.addEventListener("click", () => popup.openPopup(button, "after_end", 0, 0, false, false));

  const toolsMenu = doc.getElementById("menu_ToolsPopup");
  if (toolsMenu) {
    const menu = doc.createXULElement("menu");
    bindSidebarText(state, menu, "label", "AI Web for Zotero");
    styleSidebarMenu(menu);
    const popup = doc.createXULElement("menupopup");
    populateMenu(popup);
    menu.append(popup);
    toolsMenu.append(menu);
    state.menu = menu;
  }

  state.refreshLocale = () => {
    state.localeBindings?.forEach(refresh => refresh());
    refreshDividerText();
    button.title = sidebarText("打开网页、上传当前 PDF");
    if (!state.uploading) refreshSiteLabel(browser.currentURI?.spec || sidebarHomeURL());
  };
  state.refreshLocale();

  divider.addEventListener("dblclick", () => setSize(defaultSize(), true));
  divider.addEventListener("keydown", event => {
    const increase = bottom ? "ArrowUp" : "ArrowLeft";
    const decrease = bottom ? "ArrowDown" : "ArrowRight";
    if (![increase, decrease, "Home"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 80 : 20;
    setSize(event.key === "Home" ? defaultSize() : panel.getBoundingClientRect()[dimension()] + (event.key === increase ? step : -step), true);
  });
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    divider.focus();
    state.cleanupDrag?.();
    dragging = true;
    const initialPosition = bottom ? event.screenY : event.screenX;
    const initialSize = panel.getBoundingClientRect()[dimension()];
    let targetSize = initialSize;
    let targetMode = "normal";
    let finished = false;
    // Keep both embedded browser surfaces stationary during the gesture.
    // Continuous resizing causes compositor jumps/reflows on macOS.
    // Commit once at release; leave the PDF reader's zoom mode untouched.
    divider.setPointerCapture(event.pointerId);
    const shield = doc.createElementNS(HTML_NS, "div");
    shield.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:col-resize;user-select:none;-moz-window-dragging:no-drag;";
    shield.style.cursor = bottom ? "row-resize" : "col-resize";
    const guide = doc.createElementNS(HTML_NS, "div");
    guide.style.cssText = "position:absolute;width:3px;background:#4072e5;pointer-events:none;box-shadow:0 0 0 1px #fff8;";
    const badge = doc.createElementNS(HTML_NS, "span");
    badge.style.cssText = "position:absolute;top:50%;left:10px;padding:5px 8px;border-radius:5px;background:#4072e5;color:white;white-space:nowrap;font:12px system-ui;";
    guide.append(badge);
    shield.append(guide);
    doc.documentElement.append(shield);
    function preview() {
      const bounds = host.getBoundingClientRect();
      const target = sidebarDragTarget(targetSize, bounds[dimension()]);
      targetMode = target.mode;
      const position = (bottom ? bounds.bottom : bounds.right) - target.width - (targetMode === "closed" ? 3 : 6);
      guide.style.left = `${bottom ? bounds.left : position}px`;
      guide.style.top = `${bottom ? position : bounds.top}px`;
      guide.style.width = bottom ? `${bounds.width}px` : "3px";
      guide.style.height = bottom ? "3px" : `${bounds.height}px`;
      badge.textContent = targetMode === "closed" ? sidebarText("松手收起") : targetMode === "full" ? sidebarText("松手完全展开") : `${target.width} px`;
      badge.style.left = bottom ? "50%" : targetMode === "closed" ? "auto" : "10px";
      badge.style.right = !bottom && targetMode === "closed" ? "10px" : "auto";
      badge.style.top = bottom ? (targetMode === "closed" ? "auto" : "10px") : "50%";
      badge.style.bottom = bottom && targetMode === "closed" ? "10px" : "auto";
    }
    preview();
    const move = e => {
      if (e.pointerId !== event.pointerId) return;
      targetSize = initialSize + initialPosition - (bottom ? e.screenY : e.screenX);
      preview();
    };
    const finish = (commit = false) => {
      if (finished) return;
      finished = true;
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", release);
      divider.removeEventListener("pointercancel", cancel);
      divider.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKey, true);
      if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      shield.remove();
      dragging = false;
      if (commit) {
        if (targetMode === "closed") toggle();
        else setSize(targetSize, true, targetMode === "full");
      }
      state.cleanupDrag = null;
    };
    const release = e => {
      if (e.pointerId !== event.pointerId) return;
      move(e);
      finish(true);
    };
    const cancel = () => finish(false);
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); cancel(); } };
    state.cleanupDrag = cancel;
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", release);
    divider.addEventListener("pointercancel", cancel);
    divider.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKey, true);
  });
  sidebarWindows.set(window, state);
  attachLegacyPDFContextMenu(window, state);
}

function removeSidebar(window) {
  pendingPDFPickers.get(window)?.();
  const state = sidebarWindows.get(window);
  if (!state) return;
  state.cleanupPDFContextMenu?.();
  state.cleanupDrag?.();
  state.cancelUpload?.();
  state.cancelSiteInput?.();
  state.cancelExportRequest?.();
  state.cancelExportPreview?.();
  state.cleanupLayout?.();
  state.cleanupRendering?.();
  state.panel.remove();
  state.divider.remove();
  state.button.remove();
  state.popup.remove();
  state.menu?.remove();
  sidebarWindows.delete(window);
}

function clampSidebarWidth(width, available) {
  return Math.round(Math.max(240, Math.min(Math.max(240, available - 272), width)));
}

function sidebarDragTarget(width, available) {
  // Use the unclamped pointer position so the minimum reading widths do not
  // prevent reaching either edge. Keep the divider accessible in full mode.
  if (width <= 32) return { mode: "closed", width: 0 };
  if (width >= available - 44) return { mode: "full", width: Math.max(0, available - 12) };
  return { mode: "normal", width: clampSidebarWidth(width, available) };
}

function pdfGroups(selected) {
  return selected.map(item => {
    const attachments = item.isPDFAttachment() ? [item]
      : item.isRegularItem() ? Zotero.Items.get(item.getAttachments()).filter(attachment => attachment.isPDFAttachment()) : [];
    return { title: item.getField("title") || item.attachmentFilename || "未命名条目", attachments };
  });
}

async function selectPDFAttachments(window, purpose = "upload", selectedItems = null) {
  const tabID = window.Zotero_Tabs?.selectedID;
  if (selectedItems === null && tabID && tabID !== "zotero-pane") {
    const reader = Zotero.Reader.getByTabID(tabID);
    const item = reader && Zotero.Items.get(reader.itemID);
    if (!item?.isPDFAttachment()) throw new Error("当前标签页不是 PDF，请切换到要上传的 PDF。");
    return [item];
  }
  const selected = selectedItems === null ? window.ZoteroPane.getSelectedItems() : selectedItems;
  if (!selected.length) throw new Error("请先在文献库中选择文献条目或 PDF 附件。");
  const groups = pdfGroups(selected);
  const candidates = new Map(groups.flatMap(group => group.attachments.map(item => [item.id, item])));
  if (!candidates.size) throw new Error("所选条目没有 PDF 附件。");
  if (selected.length === 1 && candidates.size === 1) return [...candidates.values()];
  const selection = await choosePDFs(window, groups.map(group => ({
    title: group.title,
    files: group.attachments.map(item => ({
      id: item.id, label: item.attachmentFilename || item.getField("title") || "未命名 PDF",
    })),
  })), purpose);
  if (!selection?.length) return null;
  // Resolve only known candidates and deduplicate parent + attachment selections.
  return [...new Set(selection)].filter(id => candidates.has(id)).map(id => candidates.get(id));
}

// Render in the already loaded main window. No synchronous native modal loop,
// separate privileged document, or load event is needed to reach the controls.
function choosePDFs(window, groups, purpose = "upload") {
  pendingPDFPickers.get(window)?.();
  return new Promise((resolve, reject) => {
    const doc = window.document;
    const previousFocus = doc.activeElement;
    const overlay = doc.createElementNS(HTML_NS, "div");
    let finished = false;
    const close = (selection = null) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("unload", onUnload);
      overlay.remove();
      pendingPDFPickers.delete(window);
      try { previousFocus?.focus(); } catch (_) {}
      resolve(selection);
    };
    const onUnload = () => close();
    const onKey = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") {
        const controls = [...overlay.querySelectorAll("button:not([disabled]), input:not([disabled]), summary")]
          .filter(node => node.getClientRects().length);
        if (!controls.length) return;
        const index = controls.indexOf(doc.activeElement);
        const next = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault();
        event.stopPropagation();
        controls[next].focus();
      }
    };
    try {
      overlay.id = "chatgpt-pdf-picker";
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);-moz-window-dragging:no-drag;";
      const make = (tag, parent, text = "", className = "") => {
        const node = doc.createElementNS(HTML_NS, tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        parent.append(node);
        return node;
      };
      const style = make("style", overlay);
      style.textContent = `
        #chatgpt-pdf-picker .picker { color-scheme:light dark; color:CanvasText; background:Canvas; font:13px system-ui; width:700px; max-width:90vw; max-height:85vh; min-height:0; display:flex; flex-direction:column; padding:20px; gap:14px; border:1px solid GrayText; border-radius:12px; box-shadow:0 8px 40px #0005; }
        #chatgpt-pdf-picker h2 { margin:0; font-size:18px; }
        #chatgpt-pdf-picker .actions, #chatgpt-pdf-picker footer { display:flex; align-items:center; gap:8px; }
        #chatgpt-pdf-picker footer { justify-content:flex-end; }
        #chatgpt-pdf-picker .count { margin-left:auto; }
        #chatgpt-pdf-picker .groups { overflow:auto; min-height:0; border:1px solid GrayText; border-radius:6px; }
        #chatgpt-pdf-picker details { padding:12px; }
        #chatgpt-pdf-picker summary { display:flex; align-items:center; gap:8px; list-style:none; font-weight:600; cursor:pointer; overflow-wrap:anywhere; }
        #chatgpt-pdf-picker summary::marker { content:""; }
        #chatgpt-pdf-picker summary::before { content:"▸"; flex:0 0 10px; text-align:center; line-height:1; }
        #chatgpt-pdf-picker details[open] > summary::before { transform:rotate(90deg); }
        #chatgpt-pdf-picker label { display:flex; align-items:center; gap:8px; min-width:0; line-height:1.45; cursor:pointer; }
        #chatgpt-pdf-picker label > span { min-width:0; }
        #chatgpt-pdf-picker input { flex:0 0 auto; width:14px; height:14px; margin:0; accent-color:#176bd4; }
        #chatgpt-pdf-picker ul { list-style:none; margin:8px 0 0; padding-left:28px; }
        #chatgpt-pdf-picker li { padding:6px 0; overflow-wrap:anywhere; }
        #chatgpt-pdf-picker button { appearance:none; display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; height:auto; min-height:32px; margin:0; font:inherit; line-height:1.25; text-align:center; padding:6px 14px; border:1px solid GrayText; border-radius:6px; background:ButtonFace; color:ButtonText; cursor:pointer; }
        #chatgpt-pdf-picker button:disabled { opacity:.45; }
        #chatgpt-pdf-picker .accept { background:#176bd4; color:white; }
      `;
      const panel = make("section", overlay, "", "picker");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", sidebarText("选择 PDF"));
      make("h2", panel, sidebarText(purpose === "bookmark" ? "选择要关联到当前对话的 PDF" : "选择要添加的 PDF"));
      const actions = make("div", panel, "", "actions");
      const all = make("button", actions, sidebarText("全选"));
      const clear = make("button", actions, sidebarText("取消全选"));
      const count = make("span", actions, "", "count");
      count.setAttribute("aria-live", "polite");
      const list = make("section", panel, "", "groups");
      const footer = make("footer", panel);
      const cancel = make("button", footer, sidebarText("取消"));
      const accept = make("button", footer, "", "accept");
      const allIDs = new Set(groups.flatMap(group => group.files.map(file => file.id)));
      const selected = new Set(allIDs);
      const fileControls = [];
      const groupControls = [];
      const refresh = () => {
        fileControls.forEach(({ checkbox, id }) => { checkbox.checked = selected.has(id); });
        groupControls.forEach(({ checkbox, ids }) => {
          const count = ids.filter(id => selected.has(id)).length;
          checkbox.checked = ids.length > 0 && count === ids.length;
          checkbox.indeterminate = count > 0 && count < ids.length;
          checkbox.disabled = !ids.length;
        });
        count.textContent = sidebarText("已选 {selected} / {total} 个 PDF", { selected: selected.size, total: allIDs.size });
        accept.textContent = sidebarText(purpose === "bookmark" ? "保存 {count} 个 PDF 的书签" : "添加 {count} 个 PDF", { count: selected.size });
        accept.disabled = !selected.size;
      };
      for (const group of groups) {
        const details = make("details", list);
        details.open = true;
        const summary = make("summary", details);
        const label = make("label", summary);
        const checkbox = make("input", label);
        checkbox.type = "checkbox";
        make("span", label, sidebarText("{title}（{count} 个 PDF）", { title: group.title, count: group.files.length }));
        const ids = [...new Set(group.files.map(file => file.id))];
        groupControls.push({ checkbox, ids });
        checkbox.addEventListener("change", () => {
          ids.forEach(id => checkbox.checked ? selected.add(id) : selected.delete(id));
          refresh();
        });
        const children = make("ul", details);
        for (const file of group.files) {
          const row = make("li", children);
          const fileLabel = make("label", row);
          const fileCheckbox = make("input", fileLabel);
          fileCheckbox.type = "checkbox";
          make("span", fileLabel, file.label);
          fileControls.push({ checkbox: fileCheckbox, id: file.id });
          fileCheckbox.addEventListener("change", () => {
            if (fileCheckbox.checked) selected.add(file.id);
            else selected.delete(file.id);
            refresh();
          });
        }
        if (!group.files.length) make("li", children, sidebarText("没有 PDF 附件"));
      }
      all.addEventListener("click", () => { allIDs.forEach(id => selected.add(id)); refresh(); });
      clear.addEventListener("click", () => { selected.clear(); refresh(); });
      cancel.addEventListener("click", () => close());
      accept.addEventListener("click", () => { if (selected.size) close([...selected]); });
      refresh();
      doc.documentElement.append(overlay);
      pendingPDFPickers.set(window, close);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("unload", onUnload);
      cancel.focus();
    } catch (error) {
      // A render failure must reject, not leave the caller waiting indefinitely.
      overlay.remove();
      pendingPDFPickers.delete(window);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("unload", onUnload);
      reject(new Error(`无法显示 PDF 选择框：${error.message || error}`));
    }
  });
}

function attachFilesToWebsite(window, state, files) {
  const manager = state.browser.messageManager || state.browser.frameLoader?.messageManager;
  if (!manager?.loadFrameScript) throw new Error("网页浏览器暂未就绪，请刷新网页后重试。");
  const channel = `ChatGPTSidebar:Upload:${Services.uuid.generateUUID()}`;
  return new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      manager.removeMessageListener(channel, onMessage);
      try { manager.sendAsyncMessage(`${channel}:cancel`, {}); } catch (_) {}
      state.cancelUpload = null;
      resolve(result);
    };
    const onMessage = message => {
      if (message.data.ready) {
        try { manager.sendAsyncMessage(`${channel}:file`, { files }); }
        catch (_) { finish({ ok: false, error: "无法将文件交给网页，请使用网页附件按钮上传。" }); }
      } else finish(message.data);
    };
    const timer = window.setTimeout(() => finish({ ok: false, error: "无法连接网页文件入口，请刷新网页后重试。" }), 10000);
    state.cancelUpload = () => finish({ ok: false, error: "上传已取消。" });
    manager.addMessageListener(channel, onMessage);
    const adapter = siteAdapter(state.browser.currentURI?.spec);
    const source = `(${uploadFileInFrame.toString()})(${JSON.stringify(channel)},${JSON.stringify(adapter)});`;
    try { manager.loadFrameScript(`data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`, false); }
    catch (_) { finish({ ok: false, error: "无法连接网页附件控件，请刷新后重试。" }); }
  });
}

// Runs in the privileged frame-script scope of this browser only. It does not
// read chat text, credentials, other files, or click the Send button.
function uploadFileInFrame(channel, adapter = null) {
  let cancelled = false;
  function cancel() {
    cancelled = true;
    removeMessageListener(`${channel}:file`, receive);
    removeMessageListener(`${channel}:cancel`, cancel);
  }
  async function receive(message) {
    removeMessageListener(`${channel}:file`, receive);
    try {
      const page = content;
      const doc = page.document;
      const initialURL = doc.location.href;
      const validPage = () => !cancelled && content.document === doc && doc.location.origin === (adapter?.origin || "https://chatgpt.com") && doc.location.href === initialURL;
      if (!validPage()) throw new Error("网页地址与所选网站不符，未添加附件。");
      const plusSelector = 'button[data-testid="composer-plus-btn"],button[aria-label="添加文件等内容"],button[aria-label="Add files and more"]';
      const otherSite = adapter && adapter.id !== 'chatgpt';
      const historySelector = otherSite ? [adapter.user, adapter.assistant, adapter.history].filter(Boolean).join(',') : '[data-message-author-role]';
      const visible = node => node?.isConnected && node.getClientRects().length > 0
        && !node.closest?.('[hidden], [aria-hidden="true"], [inert]')
        && (!page.getComputedStyle || page.getComputedStyle(node).visibility !== 'hidden');
      const locateComposer = () => {
        const selector = otherSite ? adapter.editor : '#prompt-textarea, [contenteditable="true"][role="textbox"]';
        const eligible = node => visible(node) && !node.disabled && !node.readOnly
          && node.getAttribute?.('contenteditable') !== 'false'
          && !node.closest?.(historySelector + ', nav, aside' + (adapter?.editorExclude ? ',' + adapter.editorExclude : ''));
        // Site-specific main composers take precedence over search fields,
        // textarea mirrors and editors belonging to a secondary panel.
        let candidates = [];
        for (const group of [...(adapter?.editorGroups || []), selector]) {
          candidates = [...doc.querySelectorAll(group)].filter(eligible);
          if (candidates.length) break;
        }
        // Some editors expose both a contenteditable wrapper and its child.
        const editors = candidates.filter(node => !candidates.some(other => other !== node && node.contains?.(other)));
        if (editors.length !== 1) throw new Error(editors.length
          ? '检测到多个聊天输入框，无法确定附件目标。请关闭消息编辑框后重试。'
          : '未识别到聊天输入框，请等待网页加载并确认已登录后重试。');
        const editor = editors[0];
        let composer;
        if (otherSite) {
          composer = editor.closest(adapter.composer);
          // Prefer the outer named input region: previews can be siblings of
          // the inner text field. Never cross a history/navigation boundary.
          let candidate = editor.parentElement;
          for (let depth = 0; candidate && candidate !== doc.body && depth < 8; depth++, candidate = candidate.parentElement) {
            if (candidate.matches?.('main, nav, aside') || candidate.querySelector(historySelector)) break;
            if (candidate.matches?.(adapter.composer)) composer = candidate;
            else if (!composer && candidate.querySelector('input[type="file"], button[aria-label*="上传"], button[aria-label*="Upload"], button[aria-label*="Attach"]')) composer = candidate;
          }
          if (composer?.querySelector(historySelector)) composer = null;
        } else {
          const buttons = [...doc.querySelectorAll(plusSelector)].filter(visible);
          if (buttons.length !== 1) throw new Error('未能唯一定位当前聊天附件按钮，请关闭其他编辑框后重试。');
          composer = editor.closest('form');
          if (!composer || !composer.contains(buttons[0])) {
            composer = editor.parentElement;
            while (composer && composer !== doc.body && !composer.contains(buttons[0])) composer = composer.parentElement;
          }
        }
        if (!composer || composer === doc.body) throw new Error('未能定位当前附件区域，请使用网页附件按钮。');
        return { editor, composer };
      };
      // Gemini's uploader can live outside the composer, and the page can
      // expose several editors. Neither finding nor counting text editors is
      // necessary to deliver files to its native file input.
      const gemini = adapter?.id === 'gemini';
      const composer = gemini ? null : locateComposer().composer;
      const acceptsPDF = input => {
        const accept = (input.accept || "").toLowerCase();
        return input.isConnected && !input.disabled && (!accept || accept.includes(".pdf") || accept.includes("application/pdf") || accept.includes("application/*") || accept.includes("*/*"));
      };
      const availableInputs = () => [...doc.querySelectorAll('input[type="file"]')].filter(input => acceptsPDF(input)
        && !input.closest(historySelector + ', nav, aside'));
      const findInput = () => {
        const candidates = availableInputs();
        if (gemini) {
          const owned = candidates.filter(input => input.closest(adapter.fileInputOwner));
          if (owned.length) return owned.length === 1 ? owned[0] : null;
          const local = candidates.filter(input => {
            const region = input.closest(adapter.fileInputScope);
            return region && !region.querySelector(historySelector);
          });
          if (local.length) return local.length === 1 ? local[0] : null;
          const unowned = candidates.filter(input => !input.form && !input.closest('form'));
          return unowned.length === 1 ? unowned[0] : null;
        }
        const local = candidates.filter(input => composer.contains(input) || input.form === composer);
        if (local.length) return local.length === 1 ? local[0] : null;
        // Some sites mount the composer's hidden input outside its form. Accept
        // only a unique unowned input; never pick another form's file control.
        const unowned = candidates.filter(input => !input.form && !input.closest('form'));
        return unowned.length === 1 ? unowned[0] : null;
      };
      const files = message.data.files;
      if (!Array.isArray(files) || !files.length) throw new Error("没有选择 PDF。");
      let input = findInput();
      let preparationError = '';
      if (gemini && !input && !availableInputs().length) {
        const usable = button => visible(button) && !button.disabled
          && !button.closest(historySelector + ', nav, aside, [role="menuitem"], [aria-disabled="true"], gem-icon-button[disabled]');
        // Current Gemini puts its accessible label on a gem-icon-button host.
        // Dispatch to the inner button; deduplicate when both host and button
        // match so one physical control is never treated as two candidates.
        const clickable = node => node.localName === 'gem-icon-button' ? node.querySelector('button') || node : node;
        let buttons = [...new Set([...doc.querySelectorAll(adapter.uploadMenuButton)].map(clickable))].filter(usable);
        const local = buttons.filter(button => button.closest(adapter.fileInputScope));
        if (local.length) buttons = local;
        if (!buttons.length) buttons = [...new Set([...doc.querySelectorAll(adapter.uploadMenuIcon)]
          .map(icon => icon.closest('button[aria-haspopup="menu"]')))]
          .filter(button => usable(button) && button.closest(adapter.fileInputScope));
        if (buttons.length === 1) {
          if (!validPage()) throw new Error("网页附件入口已变化，请重试。");
          // Open only the + menu once; never click Upload files or a native
          // input, and never toggle an already open menu closed.
          const expanded = buttons[0].getAttribute('aria-expanded') === 'true'
            || buttons[0].closest('gem-icon-button')?.getAttribute('aria-expanded') === 'true';
          if (!expanded) buttons[0].click();
          for (let attempt = 0; attempt < 60; attempt++) {
            if (!validPage()) throw new Error("网页附件入口已变化，请重试。");
            input = findInput();
            if (input || availableInputs().length) break;
            await new Promise(resolve => page.setTimeout(resolve, 50));
          }
          preparationError = '已尝试展开 Gemini 的“＋”菜单，但网页尚未创建 PDF 文件控件。';
        } else preparationError = buttons.length
          ? '无法确定 Gemini 的“＋（上传和工具）”按钮，未添加 PDF。'
          : '未找到 Gemini 的“＋（上传和工具）”按钮，未添加 PDF。';
      }
      if (!input) throw new Error(gemini
        ? (availableInputs().length ? "Gemini 有多个或无法确定归属的 PDF 文件控件，请关闭其他附件窗口后重试。" : preparationError || "Gemini 尚未提供 PDF 文件控件，请先展开网页附件入口后重试。")
        : "未找到唯一的 PDF 上传控件，请打开网页附件入口后重试。");
      if (files.length > 1 && !input.multiple) throw new Error("网页当前控件只支持单个附件，请逐个选择 PDF 添加。");
      if (!validPage() || input !== findInput()) throw new Error("网页附件入口已变化，请重试。");
      // Clear only the native chooser's old selection, not the site's existing
      // attachment cards. This permits both A -> A and A -> B selections.
      input.value = "";
      input.mozSetFileArray(files);
      input.dispatchEvent(new page.Event("input", { bubbles: true }));
      input.dispatchEvent(new page.Event("change", { bubbles: true }));
      // Delivery ends here. The website owns upload progress, duplicate-file
      // handling and any new conversation URL produced when the user sends.
      sendAsyncMessage(channel, { ok: true, stage: "delivered" });
    } catch (error) {
      sendAsyncMessage(channel, { ok: false, error: error.message || "添加文件失败。" });
    } finally { cancel(); }
  }
  addMessageListener(`${channel}:file`, receive);
  addMessageListener(`${channel}:cancel`, cancel);
  sendAsyncMessage(channel, { ready: true });
}

function conversationURL(value) { return providerConversationURL(value); }

function snapshotPDFs(items) {
  const snapshots = items.filter(item => item.libraryID != null && item.key).map(item => ({
    identity: `${item.libraryID}:${item.key}`,
    label: item.attachmentFilename || item.getField("title") || "未命名 PDF",
  }));
  return [...new Map(snapshots.map(pdf => [pdf.identity, pdf])).values()];
}

function bookmarkTitle(title, url) {
  const brands = '(?:ChatGPT|Google AI Studio|Google Gemini|Gemini|DeepSeek|Kimi|GLM|智谱清言|Z\\.ai)';
  const cleaned = typeof title === "string" ? title.replace(new RegExp('\\s*[-|–—]\\s*' + brands + '\\s*$', 'i'), '').trim() : '';
  return cleaned && !new RegExp('^' + brands + '$', 'i').test(cleaned) ? cleaned.slice(0, 160) : `对话 ${String(url || '').split('/').pop().slice(0, 8)}`;
}

function readPDFBookmarks() {
  const value = JSON.parse(Services.prefs.getStringPref(BOOKMARK_PREF, "{}"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("书签数据格式错误，未修改原数据。");
  const bookmarks = {};
  for (const [identity, saved] of Object.entries(value)) {
    // v0.6.x stored a single object per PDF. Normalize in memory and preserve
    // every valid old entry when the next manual save/delete writes the store.
    const entries = Array.isArray(saved) ? saved : [saved];
    const unique = new Map();
    for (const entry of entries) {
      const url = conversationURL(entry?.url);
      if (!url) continue;
      unique.set(url, { url, title: bookmarkTitle(entry.title, url),
        createdAt: Number(entry.createdAt || entry.updatedAt) || 0,
        updatedAt: Number(entry.updatedAt) || 0 });
    }
    if (unique.size) bookmarks[identity] = [...unique.values()];
  }
  return bookmarks;
}

function savePDFBookmarks(pdfs, url, title) {
  const canonical = conversationURL(url);
  if (!canonical || !pdfs.length) return;
  const bookmarks = readPDFBookmarks();
  const updatedAt = Date.now();
  for (const pdf of pdfs) {
    const entries = bookmarks[pdf.identity] || [];
    const existing = entries.find(entry => entry.url === canonical);
    if (existing) {
      existing.updatedAt = updatedAt;
      if (title) existing.title = bookmarkTitle(title, canonical);
    } else entries.push({ url: canonical, title: bookmarkTitle(title, canonical), createdAt: updatedAt, updatedAt });
    bookmarks[pdf.identity] = entries;
  }
  Services.prefs.setStringPref(BOOKMARK_PREF, JSON.stringify(bookmarks));
}

function deletePDFBookmark(identity, url) {
  const canonical = conversationURL(url);
  if (!canonical) return false;
  const bookmarks = readPDFBookmarks();
  const entries = bookmarks[identity] || [];
  const retained = entries.filter(entry => entry.url !== canonical);
  if (retained.length === entries.length) return false;
  if (retained.length) bookmarks[identity] = retained;
  else delete bookmarks[identity];
  Services.prefs.setStringPref(BOOKMARK_PREF, JSON.stringify(bookmarks));
  return true;
}

function currentPDFBookmarks(window) {
  const tabID = window.Zotero_Tabs?.selectedID;
  let attachments;
  if (tabID && tabID !== "zotero-pane") {
    const reader = Zotero.Reader.getByTabID(tabID);
    const item = reader && Zotero.Items.get(reader.itemID);
    attachments = item?.isPDFAttachment() ? [item] : [];
  } else {
    attachments = (window.ZoteroPane?.getSelectedItems() || []).flatMap(item => item.isPDFAttachment() ? [item]
      : item.isRegularItem() ? Zotero.Items.get(item.getAttachments()).filter(child => child.isPDFAttachment()) : []);
  }
  const bookmarks = readPDFBookmarks();
  return snapshotPDFs(attachments).flatMap(pdf => {
    return (bookmarks[pdf.identity] || []).map(entry => ({
      identity: pdf.identity, label: pdf.label, title: entry.title, url: entry.url,
    }));
  });
}


// Bookmarks are only written in response to an explicit user action. The user confirms that these PDFs were discussed here.
async function saveCurrentConversationBookmark(window, state) {
  const url = conversationURL(state.browser.currentURI?.spec);
  if (!url) throw new Error("当前网页还没有正式会话地址。请先在网页中发送消息并进入对话，再保存书签。");
  const attachments = await selectPDFAttachments(window, "bookmark");
  if (!attachments?.length) return 0;
  const pdfs = snapshotPDFs(attachments);
  if (!pdfs.length) throw new Error("无法识别所选 PDF，请重新选择文献或 PDF。");
  if (!sidebarWindows.has(window) || conversationURL(state.browser.currentURI?.spec) !== url) {
    throw new Error("选择期间网页已切换或侧栏已卸载，未保存书签。请在目标对话中重试。");
  }
  savePDFBookmarks(pdfs, url, state.browser.contentTitle);
  return pdfs.length;
}

function currentExportParent(window) {
  const tabID = window.Zotero_Tabs?.selectedID;
  let items;
  if (tabID && tabID !== "zotero-pane") {
    const reader = Zotero.Reader.getByTabID(tabID);
    items = [reader && Zotero.Items.get(reader.itemID)].filter(Boolean);
  } else items = window.ZoteroPane?.getSelectedItems() || [];
  const parents = new Map();
  for (const item of items) {
    const parent = item.isRegularItem() ? item : item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
    if (!parent?.isRegularItem() || parent.deleted) throw new Error("请选中一篇文献条目，或打开属于该文献的 PDF。独立附件不能作为保存目标。");
    parents.set(parent.id, parent);
  }
  if (parents.size !== 1) throw new Error("请先选择一篇文献，对话将保存到它的条目下。");
  const parent = [...parents.values()][0];
  assertExportParentWritable(parent.id, false);
  return { id: parent.id, libraryID: parent.libraryID, title: parent.getField("title") || "未命名文献" };
}

function assertExportParentWritable(id, requireFiles = true) {
  const item = Zotero.Items.get(id);
  const library = item && Zotero.Libraries.get(item.libraryID);
  if (!item?.isRegularItem() || item.deleted) throw new Error("目标文献已不存在或已删除，未保存。");
  if (!library?.editable) throw new Error("当前文献库不允许编辑，请选择可编辑的文献库。");
  if (requireFiles && !library.filesEditable) throw new Error("当前文献库不允许添加文件附件，可改为保存 Zotero 笔记。");
}

function requestConversationSnapshot(window, state) {
  const exportURL = state.browser.currentURI?.spec;
  const manager = state.browser.messageManager || state.browser.frameLoader?.messageManager;
  if (!manager?.loadFrameScript) throw new Error("请先打开 ChatGPT 网页，并进入要保存的对话。");
  const channel = `ChatGPTSidebar:Export:${Services.uuid.generateUUID()}`;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (result, error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      manager.removeMessageListener(channel, onMessage);
      try { manager.sendAsyncMessage(`${channel}:cancel`, {}); } catch (_) {}
      state.cancelExportRequest = null;
      if (error) reject(new Error(error)); else resolve(result);
    };
    const onMessage = message => {
      const data = message.data;
      if (exportURL && (state.browser.currentURI?.spec !== exportURL || (data.url && data.url !== exportURL))) { finish(null, "提取期间网页已切换，未保存。"); return; }
      if (data.error) finish(null, data.error);
      else if (!conversationURL(data.url) || !Array.isArray(data.messages) || !data.messages.length) finish(null, "没有提取到可保存的对话，请确认消息已加载。");
      else finish(data);
    };
    const timer = window.setTimeout(() => finish(null, "提取对话超时，请等网页加载后重试。"), 20000);
    state.cancelExportRequest = () => finish(null, "导出已取消。");
    manager.addMessageListener(channel, onMessage);
    const adapter = siteAdapter(state.browser.currentURI?.spec);
    const script = `(${extractConversationInFrame.toString()})(${JSON.stringify(channel)},${collectConversationSnapshot.toString()},${conversationDataSnapshot.toString()},${JSON.stringify(adapter)});`;
    try { manager.loadFrameScript(`data:application/javascript;charset=utf-8,${encodeURIComponent(script)}`, false); }
    catch (error) { finish(null, error.message || "无法读取当前网页。"); }
  });
}

async function extractConversationInFrame(channel, collect, fromData, adapter = null) {
  const page = content;
  const doc = page.document;
  const originalURL = doc.location.href;
  let controller;
  let timer;
  let cancelled = false;
  const cancel = () => { cancelled = true; controller?.abort(); };
  const leave = () => {
    if (!cancelled) sendAsyncMessage(channel, { error: "导出期间网页已切换，未保存。" });
    cancel();
  };
  const samePage = () => !cancelled && page.document === doc && doc.location.href === originalURL;
  try {
    if (adapter && adapter.id !== "chatgpt") {
      if (doc.location.origin !== adapter.origin) throw new Error("网页已切换到其他网站，未提取对话。");
      if ([...doc.querySelectorAll(adapter.stop)].some(node => node.getClientRects().length)) throw new Error("网页仍在生成回复，请完成后再保存。");
      const snapshot = collect(doc, adapter);
      if (!samePage()) throw new Error("网页已切换，未保存。");
      snapshot.provider = adapter.name;
      sendAsyncMessage(channel, snapshot);
      return;
    }
    if (doc.location.origin !== "https://chatgpt.com") throw new Error("当前网站尚未适配对话导出。");
    if ([...doc.querySelectorAll('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]')]
      .some(node => node.getClientRects().length)) throw new Error("ChatGPT 仍在生成回复，请完成后再保存。");
    const match = originalURL.match(/^https:\/\/chatgpt\.com\/(?:g\/[A-Za-z0-9_-]+\/)?c\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
    if (!match) throw new Error("请进入有正式地址的 ChatGPT 对话后再导出。");
    addMessageListener(`${channel}:cancel`, cancel);
    page.addEventListener("pagehide", leave);
    let snapshot;
    try {
      controller = new page.AbortController();
      timer = page.setTimeout(() => controller.abort(), 15000);
      // Use only this embedded browser's same-origin login. The token is local
      // to this call, never sent over IPC, logged, cached or written to disk.
      const options = { method: "GET", credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal };
      const sessionResponse = await page.fetch("https://chatgpt.com/api/auth/session", options);
      if (!sessionResponse.ok) throw new Error("session-unavailable");
      let token = (await sessionResponse.json()).accessToken;
      if (typeof token !== "string" || !token || !samePage()) throw new Error("session-unavailable");
      const response = await page.fetch(`https://chatgpt.com/backend-api/conversation/${encodeURIComponent(match[1])}`, {
        ...options, headers: { Authorization: `Bearer ${token}`, "X-Authorization": `Bearer ${token}` },
      });
      token = null;
      if (!response.ok) throw new Error("conversation-unavailable");
      const data = await response.json();
      if (!samePage()) throw new Error("page-changed");
      snapshot = fromData(data, originalURL);
    } catch (_) {
      if (!samePage()) throw new Error("导出期间网页已切换，未保存。请回到目标对话后重试。");
      snapshot = collect(doc);
      snapshot.sourceNotice = "未能读取会话数据，本次仅提取当前网页已加载的消息。";
    } finally { if (timer !== undefined) page.clearTimeout(timer); }
    if (!samePage()) throw new Error("导出已取消或网页已切换。");
    sendAsyncMessage(channel, snapshot);
  } catch (error) {
    if (!cancelled) sendAsyncMessage(channel, { error: error.message || "提取对话失败。" });
  } finally {
    if (timer !== undefined) page.clearTimeout(timer);
    controller?.abort();
    removeMessageListener(`${channel}:cancel`, cancel);
    page.removeEventListener("pagehide", leave);
  }
}

// Inspired by pionxzh/chatgpt-exporter (MIT); see THIRD_PARTY_NOTICES.txt.
// Follow only current_node's ancestry. Never guess another leaf or conversation.
function conversationDataSnapshot(data, url) {
  const expectedID = url.match(/\/c\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1];
  if (!expectedID || !data?.mapping || !data.current_node) throw new Error("会话分支数据不完整。");
  if ((data.conversation_id && data.conversation_id !== expectedID) || (data.id && data.id !== expectedID)) throw new Error("会话标识不匹配。");
  const chain = [];
  const seen = new Set();
  let id = data.current_node;
  while (id != null) {
    if (typeof id !== "string" || seen.has(id) || seen.size >= 10000) throw new Error("会话分支结构异常。");
    const node = data.mapping[id];
    if (!node) throw new Error("会话分支缺少历史节点。");
    seen.add(id);
    chain.push(node);
    id = node.parent;
  }
  const messages = [];
  for (const node of chain.reverse()) {
    const message = node.message;
    const role = message?.author?.role;
    const metadata = message?.metadata || {};
    const content = message?.content;
    if (!["user", "assistant"].includes(role) || !content ||
        (message.recipient && message.recipient !== "all") ||
        (message.channel && message.channel !== "final") ||
        metadata.is_visually_hidden_from_conversation || metadata.is_thinking_preamble_message ||
        ["thoughts", "reasoning_recap", "model_editable_context", "user_editable_context"].includes(content.content_type)) continue;
    let markdown;
    const fallback = metadata.model_dil_v2?.fallbackMarkdown;
    if (typeof fallback === "string" && fallback.trim()) markdown = fallback;
    else if (["text", "multimodal_text"].includes(content.content_type)) {
      markdown = (content.parts || []).map(part => {
        if (typeof part === "string") return part;
        if (part?.content_type === "audio_transcription") return `[音频转写] ${part.text || ""}`;
        if (part?.content_type === "image_asset_pointer") return "[图片，未导出文件]";
        return "[非文本内容，未导出]";
      }).join("\n");
    } else if (content.content_type === "code") {
      const raw = typeof content.text === "string" ? content.text : "";
      const fence = "`".repeat(Math.max(3, ...(raw.match(/`+/g) || []).map(run => run.length + 1)));
      markdown = `${fence}\n${raw}\n${fence}`;
    } else markdown = "[此类非文本内容暂不支持 Markdown 导出]";
    // Preserve ordinary Markdown verbatim; resolve web citation markers when
    // source metadata supplies URLs, without downloading any linked resources.
    const fileCitationMarkers = (metadata.content_references || []).filter(ref => ref.type === "file" && typeof ref.matched_text === "string")
      .map(ref => ref.matched_text).filter(Boolean);
    for (const ref of metadata.content_references || []) {
      if (ref.type === "file") continue;
      if (!ref.matched_text || !markdown.includes(ref.matched_text)) continue;
      const sources = [...(ref.items || []), ...(ref.sources || []), ...(ref.fallback_items || []), ...(ref.url ? [ref] : [])];
      const links = [...new Map(sources.filter(source => /^https?:\/\//i.test(source.url || ""))
        .map(source => [source.url, `[${String(source.title || "来源").replace(/[\[\]\r\n]/g, " ")}](<${source.url.replace(/[<>\r\n]/g, "")}>)`])).values()];
      if (links.length) markdown = markdown.split(ref.matched_text).join(links.join(" "));
      else if (ref.name) markdown = markdown.split(ref.matched_text).join(`[附件：${String(ref.name).replace(/[\r\n]/g, " ")}]`);
    }
    const names = [...new Set((metadata.attachments || []).map(file => file?.name).filter(name => typeof name === "string" && name))];
    if (names.length) markdown += `\n\n附件：\n${names.map(name => `- ${name.replace(/[\r\n]/g, " ")}`).join("\n")}`;
    if (markdown.trim()) messages.push({ role, markdown: markdown.trim(), fileCitationMarkers });
  }
  if (!messages.length) throw new Error("当前分支没有可导出的消息。");
  if (messages.length > 2000 || messages.reduce((size, message) => size + message.markdown.length, 0) > 2000000) throw new Error("对话过大，未截断或保存。");
  return { title: data.title || "ChatGPT 对话", url, messages, capturedAt: new Date().toISOString(), scope: "conversation-branch" };
}

// Read only the loaded conversation turns. Do not scroll, fetch hidden history,
// inspect cookies, or read the composer. Webpage content is never executed.
function collectConversationSnapshot(doc, adapter = null) {
  const safeText = text => text.replace(/\u00a0/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ignored = 'script, style, button, nav, svg, noscript, textarea, input, [role="button"], [role="toolbar"], [aria-hidden="true"], [contenteditable="true"], [hidden], thought-container, ms-thought-accordion, ms-thought-chunk, .thinking, .thinking-content, .reasoning-content, [data-testid*="thinking"], [data-testid*="reasoning"]'
    + (adapter?.exportExclude ? ', ' + adapter.exportExclude : '');
  const outermost = nodes => nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
  function render(node) {
    if (node.nodeType === 3) {
      const value = node.nodeValue || "";
      // DOM indentation between elements is not an indented Markdown code block.
      // Keep real message newlines; pre/code are read verbatim below.
      return /^[\t\r\n ]*$/.test(value) && /[\r\n]/.test(value) ? " " : safeText(value);
    }
    if (node.nodeType !== 1) return "";
    const tag = node.localName.toLowerCase();
    if (["script", "style", "button", "nav", "svg", "noscript", "textarea", "input"].includes(tag)
      || node.getAttribute("aria-hidden") === "true" || node.getAttribute("contenteditable") === "true"
      || node.hasAttribute?.("hidden") || node.matches?.(ignored)) return "";
    const classes = node.getAttribute("class") || "";
    if (tag === "math" || /(?:^|\s)katex(?:-display)?(?:\s|$)/.test(classes)) {
      const tex = node.querySelector('annotation[encoding="application/x-tex"]');
      if (tex) return classes.includes("katex-display") ? `\n\n$$\n${tex.textContent}\n$$\n\n` : `$${tex.textContent}$`;
    }
    if (tag === "pre") {
      const code = node.querySelector("code") || node;
      const raw = code.textContent.replace(/\r\n/g, "\n");
      const runs = raw.match(/`+/g) || [];
      const fence = "`".repeat(Math.max(3, ...runs.map(run => run.length + 1)));
      const language = (code.getAttribute("class") || "").match(/(?:^|\s)language-([\w+-]+)/)?.[1] || "";
      return `\n\n${fence}${language}\n${raw.replace(/\n$/, "")}\n${fence}\n\n`;
    }
    if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")].map(row => [...row.children]
        .filter(cell => ["td", "th"].includes(cell.localName.toLowerCase()))
        .map(cell => children(cell).trim().replace(/\|/g, "\\|").replace(/\n+/g, "<br>"))).filter(row => row.length);
      if (!rows.length) return "";
      const width = Math.max(...rows.map(row => row.length));
      const line = row => `| ${Array.from({ length: width }, (_, i) => row[i] || "").join(" | ")} |`;
      return `\n\n${line(rows[0])}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    if (tag === "ul" || tag === "ol") {
      const start = Number(node.getAttribute("start")) || 1;
      return "\n" + [...node.children].filter(child => child.localName === "li").map((li, index) => {
        const lines = children(li).trim().split("\n");
        const marker = tag === "ol" ? `${start + index}. ` : "- ";
        return marker + lines[0] + lines.slice(1).map(line => `\n${" ".repeat(marker.length)}${line}`).join("");
      }).join("\n") + "\n";
    }
    const body = children(node);
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${body.trim()}\n\n`;
    if (tag === "strong" || tag === "b") return `**${body}**`;
    if (tag === "em" || tag === "i") return `*${body}*`;
    if (tag === "del" || tag === "s") return `~~${body}~~`;
    if (tag === "code") {
      const raw = node.textContent;
      const fence = "`".repeat(Math.max(1, ...(raw.match(/`+/g) || []).map(run => run.length + 1)));
      return `${fence} ${raw} ${fence}`;
    }
    if (tag === "a") {
      const href = node.href || node.getAttribute("href") || "";
      return /^(https?:\/\/|mailto:)/i.test(href) ? `[${body || safeText(href)}](<${href.replace(/[<>\r\n]/g, "")}>)` : body;
    }
    if (tag === "img") return node.getAttribute("alt") ? `[图片：${safeText(node.getAttribute("alt"))}]` : "";
    if (tag === "blockquote") return "\n\n" + body.trim().split("\n").map(line => `> ${line}`).join("\n") + "\n\n";
    if (["p", "div", "section", "article"].includes(tag)) return `\n\n${body}\n\n`;
    return body;
  }
  function children(node) { return [...node.childNodes].map(render).join(""); }
  function messageBody(root, selector) {
    if (!selector) return render(root).trim();
    // Replies may have several Markdown fragments, with code/tables in separate
    // siblings. A first-match query silently loses everything after fragment 1.
    // Keep DOM order and deduplicate by ancestry, never by text: repeated text in
    // different turns (or paragraphs) is legitimate conversation content.
    const primary = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)]
      .filter(node => !node.closest?.(ignored));
    if (!primary.length) return render(root).trim();
    const fragments = [...(root.matches?.(selector) ? [root] : []),
      ...root.querySelectorAll(selector + ', pre, table, .katex-display, math[display="block"]')]
      .filter(node => !node.closest?.(ignored));
    const bodies = outermost(fragments);
    return bodies.length ? bodies.map(render).map(text => text.trim()).filter(Boolean).join("\n\n") : render(root).trim();
  }
  const external = adapter && adapter.id !== "chatgpt";
  // Firefox 115 (Zotero 7) cannot query :has() by default. Keep relational
  // selectors as data and test descendants explicitly in every host version.
  function roleNodes(role) {
    const nodes = new Set(doc.querySelectorAll(adapter[role]));
    for (const rule of adapter[role + "Containers"] || []) {
      for (const node of doc.querySelectorAll(rule.selector)) {
        if (node.querySelector(rule.contains) && (!rule.excludes || !node.querySelector(rule.excludes))) nodes.add(node);
      }
    }
    return nodes;
  }
  const users = external ? roleNodes("user") : null;
  const assistants = external ? roleNodes("assistant") : null;
  if (external && (!users.size || !assistants.size)) throw new Error("未能同时识别用户消息和 AI 回复");
  const containerSelector = external ? [adapter.user, adapter.assistant,
    ...(adapter.userContainers || []).map(rule => rule.selector),
    ...(adapter.assistantContainers || []).map(rule => rule.selector)].join(',')
    : '[data-testid^="conversation-turn-"], article[data-turn]';
  const containers = [...doc.querySelectorAll(containerSelector)]
    .filter(node => !external || users.has(node) || assistants.has(node));
  const roots = outermost(containers.length ? containers
    : external ? [] : [...doc.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')]);
  const messages = [];
  for (const root of roots) {
    if (!root.getClientRects().length) continue;
    const marker = root.querySelector('[data-message-author-role="user"], [data-message-author-role="assistant"]');
    const role = external ? (users.has(root) && !assistants.has(root) ? "user" : assistants.has(root) && !users.has(root) ? "assistant" : null) : root.getAttribute("data-turn") || root.getAttribute("data-message-author-role") || marker?.getAttribute("data-message-author-role");
    if (!["user", "assistant"].includes(role)) continue;
    if (root.closest?.('form, nav, aside, [contenteditable="true"]') || root.closest?.(ignored)) continue;
    let markdown = messageBody(root, external ? (role === "assistant" ? adapter.answer : adapter.question)
      : `[data-message-author-role="${role}"]`);
    const attachments = new Set();
    if (role === "user") {
      for (const node of root.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"], button, a[download]')) {
        const labels = [node.getAttribute("download"), node.getAttribute("title"), node.getAttribute("aria-label"), node.textContent];
        const name = labels.filter(Boolean).map(label => label.trim()).find(label => label.length <= 500 &&
          (/\.(pdf|docx?|txt|csv|xlsx?|md|png|jpe?g)(?:\s|$)/i.test(label) || /\sPDF$/i.test(label)));
        if (name) attachments.add(name.replace(/\s+/g, " "));
      }
    }
    if (attachments.size) markdown += `${markdown ? "\n\n" : ""}附件：\n${[...attachments].map(name => `- ${safeText(name)}`).join("\n")}`;
    if (markdown) messages.push({ role, markdown });
  }
  if (external && (!messages.some(message => message.role === "user") || !messages.some(message => message.role === "assistant"))) {
    throw new Error("未能同时识别用户消息和 AI 回复");
  }
  if (!messages.length) throw new Error("没有找到已加载的对话消息；请进入对话并等待加载完成。");
  if (messages.length > 2000 || messages.reduce((size, message) => size + message.markdown.length, 0) > 2000000) {
    throw new Error("当前对话内容过大，暂不能一次导出；未截断或保存文件。");
  }
  return { title: doc.title || "ChatGPT 对话", url: doc.location.href, messages, capturedAt: new Date().toISOString(), scope: "loaded-page", provider: adapter?.name || "ChatGPT" };
}

function conversationMarkdown(parent, snapshot, title) {
  const quote = value => JSON.stringify(String(value));
  return `---\ntitle: ${quote(title)}\n文献: ${quote(parent.title)}\n会话链接: ${quote(conversationURL(snapshot.url))}\n导出时间: ${quote(snapshot.capturedAt)}\n导出轮次: ${quote(snapshot.selection ? snapshot.selection.rounds.join(", ") : "全部")}\n导出消息数: ${snapshot.messages.length}\n---\n\n# ${title.replace(/[\r\n]+/g, " ")}\n\n`
    + snapshot.messages.map(message => `## ${message.role === "user" ? "我" : (snapshot.provider || "ChatGPT")}\n\n${normalizeExportMarkdown(message.markdown, message.fileCitationMarkers)}\n`).join("\n---\n\n");
}

function renderConversationRichText(parent, snapshot, title, format) {
  if (!exportFormatScope) {
    if (!addonRootURI) throw new Error("无法加载导出组件，请重新启用插件。");
    const scope = { normalizeExportMarkdown, conversationURL };
    // Keep UMD globals inside this private component scope.
    scope.globalThis = scope;
    scope.self = scope;
    for (const file of ["vendor/markdown-it.min.js", "vendor/katex.min.js", "export-formats.js"]) {
      Services.scriptloader.loadSubScript(addonRootURI + file, scope, "UTF-8");
    }
    exportFormatScope = scope;
  }
  return exportFormatScope.ChatGPTExportFormats.render(parent, snapshot, title, format);
}

async function saveConversation(parent, snapshot, title, format) {
  if (format === "markdown") return saveConversationMarkdown(parent, snapshot, title);
  if (!["note", "html"].includes(format)) throw new Error("未知保存格式，未保存。");
  assertExportParentWritable(parent.id, format !== "note");
  const content = renderConversationRichText(parent, snapshot, title, format);
  assertExportParentWritable(parent.id, format !== "note");
  if (format === "html") {
    const url = conversationURL(snapshot.url);
    if (!url) throw new Error("当前对话地址无效，未保存。");
    return Zotero.Attachments.importFromSnapshotContent({ parentItemID: parent.id,
      title: `${title}.html`, url, snapshotContent: content });
  }
  const item = new Zotero.Item("note");
  item.libraryID = Zotero.Items.get(parent.id).libraryID;
  item.parentID = parent.id;
  item.setNote(content);
  await item.saveTx();
  return item;
}

async function saveConversationMarkdown(parent, snapshot, title) {
  assertExportParentWritable(parent.id);
  const temp = Zotero.getTempDirectory();
  temp.append(`ChatGPT-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}.md`);
  try {
    await Zotero.File.putContentsAsync(temp, conversationMarkdown(parent, snapshot, title));
    assertExportParentWritable(parent.id);
    const stamp = snapshot.capturedAt.replace(/[:.]/g, "-");
    return await Zotero.Attachments.importFromFile({ file: temp, parentItemID: parent.id,
      title: `${title}.md`, fileBaseName: Zotero.File.getValidFileName(`ChatGPT-${stamp}`), contentType: "text/markdown", charset: "utf-8" });
  } finally {
    try { if (temp.exists()) temp.remove(false); } catch (error) { Zotero.logError(error); }
  }
}

function previewConversation(window, state, parent, snapshot) {
  return new Promise((resolve, reject) => {
    const doc = window.document;
    const previousFocus = doc.activeElement;
    const overlay = doc.createElementNS(HTML_NS, "div");
    let finished = false;
    const close = value => {
      if (finished) return;
      finished = true;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("unload", cancel);
      overlay.remove();
      state.cancelExportPreview = null;
      try { previousFocus?.focus(); } catch (_) {}
      resolve(value);
    };
    const cancel = () => close(null);
    const onKey = event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key === "Tab") {
        const controls = [...overlay.querySelectorAll("input, button, select")].filter(node => !node.disabled);
        const index = controls.indexOf(doc.activeElement);
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault(); event.stopPropagation(); controls[next]?.focus();
      }
    };
    try {
      overlay.id = "chatgpt-conversation-preview";
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#0007;-moz-window-dragging:no-drag;";
      const make = (tag, owner, text = "", css = "") => {
        const node = doc.createElementNS(HTML_NS, tag);
        if (text) node.textContent = text;
        if (css) node.style.cssText = css;
        owner.append(node);
        return node;
      };
      const panel = make("section", overlay, "", "color-scheme:light dark;background:Canvas;color:CanvasText;width:800px;max-width:92vw;max-height:88vh;min-height:0;display:flex;flex-direction:column;padding:20px;gap:12px;border-radius:12px;font:13px/1.5 system-ui;box-shadow:0 8px 40px #0005;");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", sidebarText("导出对话预览"));
      make("h2", panel, sidebarText("导出对话预览"), "margin:0;font-size:18px;");
      make("div", panel, sidebarText("保存到：{title}", { title: parent.title }), "overflow-wrap:anywhere;");
      const label = make("label", panel, sidebarText("文件标题："), "display:flex;gap:8px;align-items:center;");
      const title = make("input", label, "", "flex:1;min-width:0;font:inherit;padding:6px 8px;");
      title.type = "text";
      title.maxLength = 160;
      const defaultTitle = sidebarText("{provider} 对话 — {title}", { provider: snapshot.provider || "ChatGPT", title: bookmarkTitle(snapshot.title, conversationURL(snapshot.url)) });
      title.value = defaultTitle.slice(0, 160);
      const formatLabel = make("label", panel, sidebarText("保存格式："), "display:flex;gap:8px;align-items:center;");
      const format = make("select", formatLabel, "", "font:inherit;padding:6px 8px;min-width:220px;");
      for (const [value, text] of [["note", "Zotero 笔记"], ["html", "HTML"], ["markdown", "Markdown 文件"]]) {
        const option = make("option", format, sidebarText(text));
        option.value = value;
      }
      format.value = "note";
      const buttonStyle = "appearance:none;display:inline-flex;align-items:center;justify-content:center;height:auto;min-height:32px;padding:6px 14px;font:inherit;line-height:1.25;border:1px solid #888;border-radius:6px;";
      const rounds = conversationRounds(snapshot.messages);
      const selected = new Set(rounds.map((_, index) => index));
      const controls = [];
      const actions = make("div", panel, "", "display:flex;align-items:center;gap:8px;");
      const allLabel = make("label", actions, "", "display:flex;align-items:center;gap:8px;cursor:pointer;");
      const all = make("input", allLabel, "", "width:15px;height:15px;margin:0;accent-color:#176bd4;");
      all.type = "checkbox";
      make("span", allLabel, sidebarText("全选"));
      const count = make("span", actions, "", "margin-left:auto;");
      count.setAttribute("aria-live", "polite");
      const messages = make("div", panel, "", "overflow:auto;min-height:0;display:flex;flex-direction:column;gap:14px;padding:8px;border:1px solid #8885;border-radius:6px;");
      rounds.forEach((indices, index) => {
        const group = make("section", messages, "", "flex-shrink:0;display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid #8885;border-radius:8px;");
        const choice = make("label", group, "", "display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;");
        const checkbox = make("input", choice, "", "width:15px;height:15px;margin:0;accent-color:#176bd4;");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        make("span", choice, sidebarText("第 {number} 轮（{count} 条消息）", { number: index + 1, count: indices.length }));
        controls.push({ checkbox, group });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(index); else selected.delete(index);
          refresh();
        });
        for (const messageIndex of indices) {
          const message = snapshot.messages[messageIndex];
          const bubble = make("article", group, "", `flex-shrink:0;max-width:88%;padding:10px 14px;border-radius:10px;border:1px solid #8885;align-self:${message.role === "user" ? "flex-end" : "flex-start"};background:${message.role === "user" ? "#176bd422" : "#8881"};`);
          make("strong", bubble, message.role === "user" ? sidebarText("我") : (snapshot.provider || "ChatGPT"));
          // Show the same normalized Markdown that will be saved, as plain text.
          make("div", bubble, normalizeExportMarkdown(message.markdown, message.fileCitationMarkers), "white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px;");
        }
      });
      const footer = make("footer", panel, "", "display:flex;justify-content:flex-end;gap:10px;");
      const abort = make("button", footer, sidebarText("取消"), buttonStyle);
      const save = make("button", footer, sidebarText("新增 Zotero 笔记"), buttonStyle + "background:#176bd4;color:white;");
      function refresh() {
        all.checked = selected.size === rounds.length && rounds.length > 0;
        all.indeterminate = selected.size > 0 && selected.size < rounds.length;
        controls.forEach(({ checkbox, group }, index) => {
          checkbox.checked = selected.has(index);
          group.style.opacity = checkbox.checked ? "1" : ".5";
        });
        const total = [...selected].reduce((sum, index) => sum + rounds[index].length, 0);
        count.textContent = sidebarText("已选 {selected} / {total} 轮 · {count} 条消息", { selected: selected.size, total: rounds.length, count: total });
        save.disabled = selected.size === 0;
      }
      format.addEventListener("change", () => {
        save.textContent = sidebarText({ note: "新增 Zotero 笔记", html: "新增 HTML 附件", markdown: "新增 Markdown 附件" }[format.value]);
      });
      all.addEventListener("change", () => {
        if (all.checked) rounds.forEach((_, index) => selected.add(index));
        else selected.clear();
        refresh();
      });
      abort.addEventListener("click", cancel);
      save.addEventListener("click", () => {
        if (!selected.size) return;
        close({ title: title.value.trim().replace(/[\r\n]+/g, " ") || defaultTitle,
          snapshot: selectConversationRounds(snapshot, selected), format: format.value });
      });
      refresh();
      state.cancelExportPreview = cancel;
      doc.documentElement.append(overlay);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("unload", cancel);
      abort.focus();
    } catch (error) {
      overlay.remove();
      state.cancelExportPreview = null;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("unload", cancel);
      reject(error);
    }
  });
}

function conversationRounds(messages) {
  const rounds = [];
  messages.forEach((message, index) => {
    if (!rounds.length || message.role === "user") rounds.push([]);
    rounds[rounds.length - 1].push(index);
  });
  return rounds;
}

function selectConversationRounds(snapshot, selected) {
  const rounds = conversationRounds(snapshot.messages);
  const indices = rounds.map((_, index) => index).filter(index => selected.has(index));
  if (!indices.length) throw new Error("请至少选择一轮对话。");
  return { ...snapshot, messages: indices.flatMap(index => rounds[index].map(messageIndex => ({
    ...snapshot.messages[messageIndex], markdown: normalizeExportMarkdown(snapshot.messages[messageIndex].markdown, snapshot.messages[messageIndex].fileCitationMarkers),
  }))), selection: { rounds: indices.map(index => index + 1), totalRounds: rounds.length, totalMessages: snapshot.messages.length } };
}

// ChatGPT Exporter uses the same bracket-to-dollar convention (MIT notice).
// Protect fenced/indented code and arbitrary-length inline backtick spans first.
function markdownCodeParts(markdown) {
  const input = String(markdown || "");
  const parts = [];
  let start = 0;
  let offset = 0;
  const protect = end => {
    if (start < offset) parts.push({ text: input.slice(start, offset), code: false });
    parts.push({ text: input.slice(offset, end), code: true });
    offset = end;
    start = end;
  };
  while (offset < input.length) {
    if (offset === 0 || input[offset - 1] === "\n") {
      const opening = input.slice(offset).match(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/);
      if (opening) {
        const run = opening[1];
        const closing = new RegExp(`^ {0,3}${run[0]}{${run.length},}[ \\t]*\\r?$`, "gm");
        closing.lastIndex = offset + opening[0].length;
        const match = closing.exec(input);
        protect(match ? match.index + match[0].length : input.length);
        continue;
      }
      const indented = input.slice(offset).match(/^(?: {4}|\t)[^\n]*(?:\n(?:[ \t]*\n)*(?: {4}|\t)[^\n]*)*(?:\n|$)/);
      if (indented) { protect(offset + indented[0].length); continue; }
    }
    if (input[offset] === "`" && input[offset - 1] !== "\\") {
      const run = input.slice(offset).match(/^`+/)[0];
      let next = offset + run.length;
      let end = -1;
      while ((next = input.indexOf("`", next)) !== -1) {
        const length = input.slice(next).match(/^`+/)[0].length;
        if (length === run.length) { end = next + length; break; }
        next += length;
      }
      if (end !== -1) { protect(end); continue; }
      offset += run.length;
      continue;
    }
    // A math block can contain indented TeX lines; those are not Markdown code.
    // Skip scanning its interior, but leave it in the ordinary-text segment.
    if (input[offset - 1] !== "\\") {
      const ending = input.startsWith("\\[", offset) ? "\\]"
        : input.startsWith("\\(", offset) ? "\\)" : input.startsWith("$$", offset) ? "$$" : null;
      if (ending) {
        let end = input.indexOf(ending, offset + 2);
        while (end !== -1 && input[end - 1] === "\\") end = input.indexOf(ending, end + 2);
        if (end !== -1) { offset = end + 2; continue; }
      }
    }
    offset++;
  }
  if (start < input.length) parts.push({ text: input.slice(start), code: false });
  return parts;
}

function normalizeMarkdownMath(markdown) {
  return markdownCodeParts(markdown).map(part => {
    if (part.code) return part.text;
    return part.text
      .replace(/(^|\n)([ \t]*)\\\[([\s\S]*?)(?<!\\)\\\][ \t]*(?=\r?\n|$)/g, (_, lineStart, indent, body) => {
        const tex = body.trim();
        return tex ? `${lineStart}${indent}$$\n${tex}\n${indent}$$` : `${lineStart}${indent}\\[\\]`;
      })
      .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (_, body) => {
        const tex = body.trim();
        return tex ? `\n\n$$\n${tex}\n$$\n\n` : "\\[\\]";
      })
      .replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, (_, body) => {
        const tex = body.trim().replace(/\r?\n/g, " ");
        return tex ? `$${tex}$` : "\\(\\)";
      });
  }).join("");
}

// Deliberately small formatting pass: no AST reserialization, list renumbering,
// heading changes or global substitutions of punctuation / scientific symbols.
function normalizeExportMarkdown(markdown, fileCitationMarkers = []) {
  const normalized = normalizeMarkdownMath(markdown);
  const cleanText = text => {
    let cleaned = text.replace(/\r\n?/g, "\n");
    for (const marker of fileCitationMarkers || []) {
      if (typeof marker === "string" && marker) cleaned = cleaned.split(marker).join("");
    }
    cleaned = cleaned
      .replace(/\uE200filecite[^\uE200\uE201]*\uE201/gu, "")
      .replace(/\uE200cite(?:\uE202turn\d+file\d+(?::[^\uE200\uE201\uE202]*)?)+\uE201/gu, "")
      .replace(/【\d+:\d+†[^】\n]*】/g, "");
    // Only tidy punctuation gaps when a citation was actually removed.
    if (cleaned !== text.replace(/\r\n?/g, "\n")) cleaned = cleaned.replace(/[ \t]+(?=[，。；：！？、,.;:!?])/g, "");
    return cleaned.replace(/\n[ \t]+(?=\n)/g, "\n").replace(/\n{3,}/g, "\n\n");
  };
  return markdownCodeParts(normalized).map(part => {
    if (part.code) return part.text;
    // Preserve the inside of existing display formulas (including TeX line
    // breaks and intentional blank lines); compact only the surrounding prose.
    return part.text.split(/((?<!\\)\$\$[\s\S]*?(?<!\\)\$\$)/g)
      .map((segment, index) => index % 2 ? segment : cleanText(segment)).join("");
  }).join("");
}
