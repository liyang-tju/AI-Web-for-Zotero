export const TOOL_LABELS = {
  molecular_properties: "分子属性计算",
  molecular_similarity: "结构相似度比较",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function createMarkdownRenderer(factory) {
  const renderer = factory({ html: false, breaks: true, linkify: false });
  const original = renderer.renderer.rules.link_open;
  renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
    return original ? original(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };
  // Remote images can send a user's IP or browsing metadata. Show the alt text instead.
  renderer.renderer.rules.image = (tokens, index) => escapeHtml(tokens[index].content);
  return renderer;
}

export function splitReference(content) {
  const prefix = "\n\n<user_provided_reference>\n";
  const suffix = "\n</user_provided_reference>";
  const index = content.indexOf(prefix);
  if (index < 0 || !content.endsWith(suffix)) return { text: content, context: "" };
  return { text: content.slice(0, index), context: content.slice(index + prefix.length, -suffix.length) };
}

export function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function buildTurns(messages, runs = []) {
  const turns = [];
  const completed = runs.filter((run) => run.status === "completed")
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  let turn = null;
  let pendingCalls = new Map();
  for (const message of messages) {
    if (message.role === "user") {
      turn = { ...splitReference(message.content || ""), answer: "", calls: [], run: completed[turns.length] || null };
      turns.push(turn);
      pendingCalls = new Map();
    } else if (turn && message.role === "assistant") {
      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) pendingCalls.set(call.id, call);
      } else if (message.content) turn.answer = message.content;
    } else if (turn && message.role === "tool") {
      const call = pendingCalls.get(message.tool_call_id);
      const result = parseJson(message.content, { error: "invalid_result", message: "无法读取结果" });
      turn.calls.push({ call_id: message.tool_call_id, name: call?.function?.name || "工具",
        arguments: parseJson(call?.function?.arguments || "{}", {}),
        result, success: result !== null && !result.error });
    }
  }
  // The latest run page contains the latest completed turns, even with failed runs mixed in.
  const offset = turns.length - completed.length;
  turns.forEach((item, index) => { item.run = offset >= 0 ? completed[index - offset] || null : null; });
  return turns;
}

export function metricValue(value, digits = 4) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(digits)));
}

export function contextBadge(context) {
  if (!context?.compressed) return null;
  const label = context.summary_used ? "上下文已压缩" : "工具结果已精简";
  return { label, description: `预计输入 ${Number(context.input_tokens_after || 0).toLocaleString()} / ${Number(context.input_budget_tokens || 0).toLocaleString()} tokens；已摘要 ${context.summarized_messages || 0} 条历史消息，保留 ${context.retained_turns || 0} 轮近期对话；原始记录完整保存。` };
}
