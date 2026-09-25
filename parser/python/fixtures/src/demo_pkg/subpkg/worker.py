from ..models import Service


class Worker(Service):
    def work(self) -> None:
        self.run()
