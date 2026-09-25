"""Regression fixture for unresolved decorator and callable targets."""

from .... import broken


@registry.route("/first")
@registry.route("/first")
def repeated_routes():
    return None


@((make_router())())
def targetless_decorator():
    return None


def dynamic_callable(callbacks):
    callbacks[0]()
