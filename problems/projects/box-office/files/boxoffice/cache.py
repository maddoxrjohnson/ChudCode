"""Cache helpers. Production points CACHES at Redis; tests use the local-memory cache."""

from django.core.cache import cache

EVENT_TTL_SECONDS = 300


def event_cache_key(event_id):
    return f"boxoffice:event:{event_id}"


def get_cached_event(event_id):
    return cache.get(event_cache_key(event_id))


def cache_event(event_id, payload):
    cache.set(event_cache_key(event_id), payload, EVENT_TTL_SECONDS)


def evict_event(event_id):
    cache.delete(event_cache_key(event_id))
