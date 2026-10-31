import json
import math
from pathlib import Path
from typing import Any

from tokenizers import Tokenizer


class TokenCounter:
    """Local text-token accounting plus a margin for the provider's wire template."""

    def __init__(self, path: Path):
        self.tokenizer = None
        self.method = "utf8-bytes-conservative"
        if path.is_file():
            try:
                self.tokenizer = Tokenizer.from_file(str(path))
                self.method = "deepseek-tokenizer+15%-margin"
            except Exception:
                # An unavailable or incompatible tokenizer must not disable the budget guard.
                self.tokenizer = None

    def text_tokens(self, text: str) -> int:
        if not text:
            return 0
        if self.tokenizer is not None:
            return len(self.tokenizer.encode(text, add_special_tokens=False).ids)
        # A deliberately conservative fallback, never presented as exact provider usage.
        return len(text.encode("utf-8"))

    def request_tokens(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> int:
        payload = json.dumps(
            {"messages": messages, "tools": tools}, ensure_ascii=False, separators=(",", ":")
        )
        return math.ceil(self.text_tokens(payload) * 1.15) + 16 * (len(messages) + 1)

    def prefix(self, text: str, budget: int) -> str:
        """Return a Unicode-safe bounded prefix without decoding partial UTF-8 tokens."""
        if budget <= 0:
            return ""
        if self.text_tokens(text) <= budget:
            return text
        low, high = 0, len(text)
        while low < high:
            middle = (low + high + 1) // 2
            if self.text_tokens(text[:middle]) <= budget:
                low = middle
            else:
                high = middle - 1
        # BPE token counts need not be strictly monotonic at a word boundary.
        while low and self.text_tokens(text[:low]) > budget:
            low -= 1
        return text[:low]
