class Base:
    def run(self) -> str:
        return "base"


class Service(Base):
    async def run(self) -> str:
        return "service"
