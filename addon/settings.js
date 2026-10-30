/* Website choices live in the menu; custom URLs use a small anchored input. */
function sidebarHomeURL() {
  try {
    const url = normalizeSidebarURL(Services.prefs.getStringPref('extensions.chatgpt-web-sidebar-demo.homeURL', HOME_URL));
    return /^https:\/\/chat\.z\.ai\/?$/.test(url) ? 'https://chatglm.cn/' : url;
  }
  catch (_) { return HOME_URL; }
}

function appendWebsiteMenu(window, state, parent, apply) {
  const doc = window.document;
  const menu = doc.createXULElement('menu');
  bindSidebarText(state, menu, 'label', '切换网页');
  styleSidebarMenu(menu, 'switch');
  const popup = doc.createXULElement('menupopup');
  const choices = [];
  for (const site of siteAdapter()) {
    const item = doc.createXULElement('menuitem');
    bindSidebarText(state, item, 'label', site.name);
    styleSidebarMenu(item);
    item.setAttribute('type', 'radio');
    item.setAttribute('autocheck', 'false');
    item.addEventListener('command', () => {
      try { apply(site.home); }
      catch (error) { sidebarAlert(window, '切换网页', error.message || String(error)); }
    });
    choices.push({ item, site });
    popup.append(item);
  }
  popup.append(doc.createXULElement('menuseparator'));
  const custom = doc.createXULElement('menuitem');
  bindSidebarText(state, custom, 'label', '自定义网址…');
  styleSidebarMenu(custom);
  custom.addEventListener('command', () => {
    if (state.uploading || state.exporting || state.savingBookmark) return;
    showSidebarURLInput(window, state, apply);
  });
  popup.append(custom);
  popup.addEventListener('popupshowing', event => {
    if (event.target !== popup) return;
    const url = (state.loaded && state.browser.currentURI?.spec) || sidebarHomeURL();
    const currentSite = siteAdapter(url);
    const busy = state.uploading || state.exporting || state.savingBookmark;
    for (const { item, site } of choices) {
      item.setAttribute('checked', String(site.id === currentSite?.id));
      item.setAttribute('disabled', String(!!busy));
    }
    custom.setAttribute('disabled', String(!!busy));
  });
  menu.append(popup);
  parent.append(menu);
}

function showSidebarURLInput(window, state, apply) {
  if (state.cancelSiteInput) return;
  const doc = window.document;
  const popup = doc.createXULElement('panel');
  popup.id = 'ai-sidebar-url-input';
  popup.setAttribute('type', 'arrow');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', sidebarText('自定义网址'));
  const make = (tag, parent, text = '') => {
    const node = doc.createElementNS(HTML_NS, tag);
    node.textContent = text;
    parent.append(node);
    return node;
  };
  const body = make('div', popup);
  body.style.cssText = 'padding:14px;width:340px;max-width:80vw;font:14px/1.5 system-ui;color:CanvasText;background:Canvas;';
  const label = make('label', body, sidebarText('网页地址'));
  const input = make('input', label);
  input.type = 'url';
  input.value = sidebarHomeURL();
  input.style.cssText = 'box-sizing:border-box;display:block;width:100%;margin:6px 0;padding:6px;font:inherit;';
  const error = make('div', body);
  error.setAttribute('role', 'alert');
  error.style.color = '#d33';
  const footer = make('div', body);
  footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px;';
  const cancel = make('button', footer, sidebarText('取消'));
  const open = make('button', footer, sidebarText('打开'));
  for (const button of [cancel, open]) {
    button.style.cssText = 'appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:32px;margin:0;padding:6px 12px;font:inherit;line-height:1.25;border:1px solid GrayText;border-radius:6px;background:ButtonFace;color:ButtonText;';
  }
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    popup.remove();
    state.cancelSiteInput = null;
  };
  const close = () => { popup.hidePopup(); cleanup(); };
  const submit = () => {
    try {
      if (state.uploading || state.exporting || state.savingBookmark) return;
      apply(normalizeSidebarURL(input.value));
      close();
    }
    catch (reason) { error.textContent = sidebarText(reason.message || String(reason)); }
  };
  cancel.addEventListener('click', close);
  open.addEventListener('click', submit);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
  });
  popup.addEventListener('popupshown', () => { input.focus(); input.select(); });
  popup.addEventListener('popuphidden', cleanup);
  state.cancelSiteInput = close;
  doc.documentElement.append(popup);
  popup.openPopup(state.button, 'after_end', 0, 0, false, false);
}
