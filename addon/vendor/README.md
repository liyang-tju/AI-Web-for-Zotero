# Bundled export libraries

These fixed browser bundles run locally while exporting HTML/native notes.
They are not embedded as scripts in the saved document. The HTML contains
static MathML; Zotero notes retain editable TeX nodes in Zotero's note schema.

| Library | Version | npm archive | Archive member | SHA-256 of bundled JS |
| --- | --- | --- | --- | --- |
| markdown-it | 15.0.3 | https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz | package/dist/browser/markdown-it.umd.min.js | 391f2aa638e75e6c7859d0a5c5650ef0956722a45998f17e05b83bc655778e1e |
| KaTeX | 0.19.1 | https://registry.npmjs.org/katex/-/katex-0.19.1.tgz | package/dist/katex.min.js | fa140498b8cfc8302cbe5e7cb1bdbc1f952bc38b3fa258ede09e73edbf9a74bc |

Both bundles are unmodified and include their original MIT licenses in this
directory. The addon implements its own small Markdown math token rules.
Raw HTML is disabled, images become text labels, links are restricted to
HTTP(S), mailto and anchors, and KaTeX uses trust:false with bounded expansion.
