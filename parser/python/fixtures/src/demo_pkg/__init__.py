"""Fixture package."""

from .models import Service
from .service import make_service

__all__ = ["Service", "make_service"]
