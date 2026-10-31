// This models one Firefox 115 limitation, not a real Gecko runtime.
const wrapped = new WeakSet();
function rejectHasSelectors(window) {
  for (const prototype of [window.Document.prototype, window.Element.prototype]) {
    if (wrapped.has(prototype)) continue;
    for (const method of ['querySelector', 'querySelectorAll', 'matches', 'closest']) {
      const original = prototype[method];
      if (!original) continue;
      prototype[method] = function (selector, ...args) {
        if (String(selector).includes(':has(')) throw new SyntaxError('Firefox 115: unsupported :has() selector');
        return original.call(this, selector, ...args);
      };
    }
    wrapped.add(prototype);
  }
}
module.exports = { rejectHasSelectors };
