ChromeUtils.defineESModuleGetters(globalThis, {
  Zotero: "chrome://zotero/content/zotero.mjs",
});

export class AIWebSidebarLinksParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name !== "OpenExternalLink") return;
    const context = this.browsingContext;
    const browser = context.top.embedderElement;
    if (context !== context.top || context.currentWindowGlobal !== this.manager
      || browser?.id !== "chatgpt-web-demo-browser"
      || browser.getAttribute("messagemanagergroup") !== "aiWebSidebar") return;
    let url, current;
    try {
      url = new URL(data.url);
      current = new URL(this.manager.documentURI.spec);
    } catch (_) { return; }
    // Only web links from the current sidebar document can leave the app.
    if (!/^https?:$/.test(url.protocol) || !/^https?:$/.test(current.protocol)
      || url.origin === current.origin) return;
    Zotero.launchURL(url.href);
  }
}
