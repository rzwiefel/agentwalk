from .models import Service
from external_lib import missing

VALUE: int = 1


def make_service(value: int = VALUE) -> Service:
    result = Service()
    result.run()
    missing(value)
    return result


def dynamic(value):
    return getattr(value, "run")()
