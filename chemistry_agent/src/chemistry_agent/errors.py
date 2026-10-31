class AgentError(Exception):
    """An error whose code and message are safe to expose to a local API client."""

    def __init__(self, code: str, message: str, status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
