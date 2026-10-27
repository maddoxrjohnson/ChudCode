DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 50


def _positive_int(value, default):
    """The value as an int when it is a whole number of at least 1; otherwise `default`."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if number >= 1 else default


def paginate(queryset, params):
    """Slice a queryset by the `page` and `page_size` query parameters."""
    page = _positive_int(params.get("page"), 1)
    page_size = _positive_int(params.get("page_size"), DEFAULT_PAGE_SIZE)
    page_size = min(page_size, MAX_PAGE_SIZE)

    start = (page - 1) * page_size
    items = list(queryset[start : start + page_size])
    return {
        "count": queryset.count(),
        "page": page,
        "page_size": page_size,
        "results": items,
    }
