"""Language-neutral revision metadata primitives.

Adapters remain responsible for parsing a complete archived revision.  This
package defines the portable change vocabulary used by backend consumers:
changed/added/deleted paths, rename pairs, diff ranges, and stable graph IDs.
"""

from .revision import changed_elements, normalize_metadata

__all__ = ["changed_elements", "normalize_metadata"]
