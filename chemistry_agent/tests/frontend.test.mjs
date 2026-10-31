import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { buildTurns, contextBadge, createMarkdownRenderer, escapeHtml, metricValue, splitReference } from "../src/chemistry_agent/web/core.mjs";

const require = createRequire(import.meta.url);
const markdown = createMarkdownRenderer(require("../src/chemistry_agent/web/vendor/markdown-it.min.js"));

test("untrusted titles and user text are escaped", () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(escapeHtml(null), "");
});

test("Markdown handles formatting and blocks active HTML, unsafe links, and remote images", () => {
  assert.match(markdown.render("**乙醇**"), /<strong>乙醇<\/strong>/);
  assert.doesNotMatch(markdown.render('<script>alert(1)</script><img src=x onerror="bad()">'), /<script|<img/);
  assert.doesNotMatch(markdown.render("[bad](javascript:alert(1))"), /href="javascript/);
  assert.doesNotMatch(markdown.render("![figure](https://example.com/pixel.png)"), /<img/);
  assert.match(markdown.render("[文献](https://example.com)"), /rel="noopener noreferrer"/);
});

test("saved reference excerpts are kept separate from the user's question", () => {
  assert.deepEqual(splitReference("问题\n\n<user_provided_reference>\n原文\n</user_provided_reference>"), { text: "问题", context: "原文" });
  assert.deepEqual(splitReference("<user_provided_reference>只是标签"), { text: "<user_provided_reference>只是标签", context: "" });
});

test("wire conversations reconstruct tool exchanges and exclude reasoning", () => {
  const messages = [
    { role: "user", content: "计算 CCO" },
    { role: "assistant", reasoning_content: "private", tool_calls: [
      { id: "call-1", function: { name: "molecular_properties", arguments: '{"smiles":"CCO"}' } },
    ] },
    { role: "tool", tool_call_id: "call-1", content: '{"formula":"C2H6O"}' },
    { role: "assistant", content: "计算结果是乙醇。", reasoning_content: "private" },
    { role: "user", content: "继续" },
    { role: "assistant", content: "好的。" },
  ];
  const runs = [
    { status: "completed", started_at: "2026-10-31T02:00:00Z", usage: { total_tokens: 20 } },
    { status: "failed", started_at: "2026-10-31T01:00:00Z" },
    { status: "completed", started_at: "2026-10-31T00:00:00Z", usage: { total_tokens: 10 } },
  ];
  const turns = buildTurns(messages, runs);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].calls[0].name, "molecular_properties");
  assert.deepEqual(turns[0].calls[0].arguments, { smiles: "CCO" });
  assert.equal(turns[0].calls[0].result.formula, "C2H6O");
  assert.equal(turns[0].run.usage.total_tokens, 10);
  assert.doesNotMatch(JSON.stringify(turns), /private/);
  assert.equal(buildTurns(messages, runs.slice(0, 1))[0].run, null);
});

test("bad tool payloads are shown as failures and numerical output stays finite", () => {
  const turns = buildTurns([
    { role: "user", content: "计算" },
    { role: "tool", tool_call_id: "unknown", content: "not json" },
  ]);
  assert.equal(turns[0].calls[0].success, false);
  assert.equal(metricValue(NaN), "—");
  assert.equal(metricValue(0.285714, 6), "0.285714");
  assert.equal(metricValue(46.069), "46.069");
});

test("compression badges distinguish summaries and tool excerpts, including legacy runs", () => {
  assert.equal(contextBadge(undefined), null);
  assert.equal(contextBadge({ compressed: false }), null);
  const summary = contextBadge({ compressed: true, summary_used: true, input_tokens_after: 3000,
    input_budget_tokens: 8000, summarized_messages: 12, retained_turns: 4 });
  assert.equal(summary.label, "上下文已压缩");
  assert.match(summary.description, /12 条历史消息/);
  assert.match(summary.description, /原始记录完整保存/);
  assert.equal(contextBadge({ compressed: true, summary_used: false }).label, "工具结果已精简");
});
