from .models import Base, Service


MODULE_VALUE: int = 10


def decorator(value):
    return value


@decorator
def overloaded(value: int) -> int:
    return value


def overloaded(value: str) -> str:
    return value


def outer() -> int:
    annotated_local: int = MODULE_VALUE

    def nested() -> int:
        return annotated_local

    return nested()


async def async_function() -> Service:
    return Service()


class Derived(Base):
    class_value: int = MODULE_VALUE

    @decorator
    def method(self) -> str:
        return self.run()

    async def async_method(self) -> str:
        return self.run()
