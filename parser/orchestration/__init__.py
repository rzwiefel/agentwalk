"""Standalone parser adapter orchestration for Codewalk."""

__all__ = ["AdapterSpec", "DispatcherError", "analyze_repository", "capabilities", "detect_repository"]


def __getattr__(name: str):
    if name in __all__:
        from . import dispatcher

        return getattr(dispatcher, name)
    raise AttributeError(name)
