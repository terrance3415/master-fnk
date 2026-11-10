class RemasterError(Exception):
    """User-facing failure. exit_code 2 is usage or environment, 1 is a failed job."""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code
