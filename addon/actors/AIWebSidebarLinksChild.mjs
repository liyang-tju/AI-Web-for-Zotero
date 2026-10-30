// Scoped to the sidebar browser, not Zotero's reader or other web views.
export class AIWebSidebarLinksChild extends JSWindowActorChild {
  handleEvent(event) {
    if (!event.isTrusted || event.defaultPrevented) return;
    if (!((event.type === "click" && event.button === 0)
      || (event.type === "auxclick" && event.button === 1))) return;

    // Links often contain a title span, icon or shadow-DOM child. Testing only
    // event.target would make the same link behave differently across its area.
    const link = event.composedPath().find(node => node.matches?.("a[href], area[href]"));
    if (!link || link.ownerDocument !== this.document || link.hasAttribute("download")) return;
    let url, current;
    try {
      url = new URL(link.getAttribute("href"), link.baseURI);
      current = new URL(this.document.location.href);
    } catch (_) { return; }
    if (!/^https?:$/.test(url.protocol) || !/^https?:$/.test(current.protocol)) return;

    if (url.origin === current.origin) {
      const target = (link.getAttribute("target")
        || this.document.querySelector("base[target]")?.getAttribute("target") || "").toLowerCase();
      // Ordinary same-site navigation belongs to the web app's SPA router.
      if ((!target || ["_self", "_top", "_parent"].includes(target))
        && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.contentWindow.location.assign(url.href);
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    this.sendAsyncMessage("OpenExternalLink", { url: url.href });
  }
}
