/* Bundled Markdown rendering for static HTML and Zotero's native note schema. */
var ChatGPTExportFormats = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  function renderer(format) {
    const md = markdownit({ html: false, linkify: false, typographer: false, breaks: false });
    md.validateLink = url => /^(https?:|mailto:|#)/i.test(url);
    md.renderer.rules.image = (tokens, index) => `[图片：${escape(tokens[index].content || '未导出')}]`;
    const math = (tex, block) => {
      if (format === 'note') {
        const tag = block ? 'pre' : 'span';
        const delimiter = block ? '$$' : '$';
        return `<${tag} class="math">${delimiter}${escape(tex)}${delimiter}</${tag}>`;
      }
      // Native MathML needs no runtime script, web font or external resource.
      return katex.renderToString(tex, { output: 'mathml', displayMode: block,
        throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 });
    };
    md.renderer.rules.chat_math_block = (tokens, index) => math(tokens[index].content, true) + '\n';
    md.renderer.rules.chat_math_inline = (tokens, index) => math(tokens[index].content, false);

    // Block rules run before paragraph parsing, so blank lines inside aligned
    // equations remain TeX rather than becoming separate Markdown paragraphs.
    md.block.ruler.before('fence', 'chat_math_block', (state, start, end, silent) => {
      if (state.sCount[start] - state.blkIndent >= 4) return false;
      const line = number => state.src.slice(state.bMarks[number] + state.tShift[number], state.eMarks[number]);
      const first = line(start);
      if (!first.startsWith('$$')) return false;
      const parts = [];
      let last = start;
      let closed = false;
      for (; last < end; last++) {
        if (last > start && state.sCount[last] < state.blkIndent && line(last).trim()) break;
        const value = last === start ? first.slice(2) : line(last);
        const closing = value.match(/(?<!\\)\$\$[ \t]*$/);
        if (closing) { parts.push(value.slice(0, closing.index)); closed = true; break; }
        parts.push(value);
      }
      if (!closed) return false;
      if (silent) return true;
      const token = state.push('chat_math_block', '', 0);
      token.block = true;
      token.content = parts.join('\n').trim();
      token.map = [start, last + 1];
      state.line = last + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    md.inline.ruler.after('escape', 'chat_math_inline', (state, silent) => {
      const start = state.pos;
      if (state.src[start] !== '$' || state.src[start + 1] === '$' || /\s/.test(state.src[start + 1] || ' ')) return false;
      let end = start + 1;
      while ((end = state.src.indexOf('$', end)) !== -1) {
        let slashes = 0;
        for (let i = end - 1; i >= 0 && state.src[i] === '\\'; i--) slashes++;
        if (slashes % 2) { end++; continue; }
        // Prevent common prices such as "$5 and $10" from becoming math.
        if (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] || '') || state.src[end + 1] === '$') return false;
        const tex = state.src.slice(start + 1, end);
        if (tex.includes('\n')) return false;
        if (!silent) state.push('chat_math_inline', '', 0).content = tex;
        state.pos = end + 1;
        return true;
      }
      return false;
    });
    return md;
  }

  function render(parent, snapshot, title, format) {
    if (!['note', 'html'].includes(format)) throw new Error('不支持的富文本格式');
    const md = renderer(format);
    const url = conversationURL(snapshot.url);
    const header = `<h1>${escape(title)}</h1>\n<p>${escape(parent.title)}</p>\n`
      + (url ? `<p><a href="${escape(url)}">${escape(snapshot.provider || "ChatGPT")} 对话</a></p>\n` : '');
    const body = snapshot.messages.map(message => {
      const content = md.render(normalizeExportMarkdown(message.markdown, message.fileCitationMarkers));
      const heading = `<h2>${message.role === 'user' ? '我' : escape(snapshot.provider || 'ChatGPT')}</h2>\n`;
      return format === 'note' ? heading + content
        : `<section class="message ${message.role === 'user' ? 'user' : 'assistant'}">${heading}${content}</section>`;
    }).join('\n<hr>\n');
    // Schema 9 is the format used by Zotero for pre.math and span.math nodes.
    if (format === 'note') return `<div data-schema-version="9">${header}${body}</div>`;
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark}body{font:17px/1.65 system-ui,-apple-system,sans-serif;color:CanvasText;background:Canvas;max-width:900px;margin:0 auto;padding:24px;overflow-wrap:anywhere}
h1{font-size:1.65em;line-height:1.3}h2{font-size:1.15em;margin:0 0 .7em}h3,h4,h5,h6{line-height:1.4}p{margin:.65em 0}
.message{padding:16px 18px;border:1px solid #8885;border-radius:8px}.user{background:#548cd110}hr{border:0;border-top:1px solid #8885;margin:20px 0}
a{color:LinkText}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#8881;border:1px solid #8884;border-radius:5px}code{font-family:ui-monospace,monospace;font-size:.9em}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #8888}
table{border-collapse:collapse;display:block;overflow:auto;max-width:100%;margin:1em 0}td,th{border:1px solid #8886;padding:7px 10px;text-align:left}th{background:#8881}math[display="block"]{display:block;overflow-x:auto;margin:.65em 0;padding:.2em 0}li>p{margin:.2em 0}
@media(max-width:600px){body{padding:12px}.message{padding:12px}}@media print{body{max-width:none;color:#111;background:#fff}.message{border:0}}
</style></head><body>${header}${body}</body></html>`;
  }
  return { render };
})();
