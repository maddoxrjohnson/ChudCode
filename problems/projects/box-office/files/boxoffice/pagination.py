DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 50


def paginate(queryset, params):
    """Slice a queryset by the `page` and `page_size` query parameters."""
    page = int(params.get("page"))
    page_size = int(params.get("page_size", DEFAULT_PAGE_SIZE))
    page_size = min(page_size, MAX_PAGE_SIZE)

    start = (page - 1) * page_size
    items = list(queryset[start : start + page_size])
    return {
        "count": queryset.count(),
        "page": page,
        "page_size": page_size,
        "results": items,
    }
