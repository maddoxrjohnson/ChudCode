import json
from datetime import datetime

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .cache import cache_event, evict_event, get_cached_event
from .models import Event
from .pagination import paginate
from .services import BookingError, create_booking

EDITABLE_FIELDS = {"name", "city", "category", "price_cents", "capacity"}


def _error(message, status):
    return JsonResponse({"error": message}, status=status)


def _body(request):
    try:
        data = json.loads(request.body or b"{}")
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


@csrf_exempt
@require_http_methods(["GET", "POST"])
def event_list(request):
    if request.method == "POST":
        return _create_event(request)

    events = Event.objects.all()
    city = request.GET.get("city")
    if city:
        events = events.filter(city__iexact=city)
    category = request.GET.get("category")
    if category:
        events = events.filter(category=category)
    min_price = request.GET.get("min_price")
    if min_price and min_price.isdigit():
        events = events.filter(price_cents__gte=int(min_price))
    max_price = request.GET.get("max_price")
    if max_price and max_price.isdigit():
        events = events.filter(price_cents__lte=int(max_price))

    page = paginate(events, request.GET)
    page["results"] = [event.to_dict() for event in page["results"]]
    return JsonResponse(page)


def _create_event(request):
    data = _body(request)
    if data is None:
        return _error("body must be a JSON object", 400)
    required = ["name", "city", "category", "starts_at", "price_cents", "capacity"]
    missing = [field for field in required if data.get(field) in (None, "")]
    if missing:
        return _error(f"missing fields: {', '.join(missing)}", 400)
    try:
        starts_at = datetime.fromisoformat(data["starts_at"])
        price = int(data["price_cents"])
        capacity = int(data["capacity"])
    except (TypeError, ValueError):
        return _error("starts_at, price_cents, or capacity is malformed", 400)
    if price < 0 or capacity < 1:
        return _error("price_cents must be >= 0 and capacity >= 1", 400)
    event = Event.objects.create(
        name=data["name"],
        city=data["city"],
        category=data["category"],
        starts_at=starts_at,
        price_cents=price,
        capacity=capacity,
    )
    return JsonResponse(event.to_dict(), status=201)


@csrf_exempt
@require_http_methods(["GET", "PATCH"])
def event_detail(request, event_id):
    if request.method == "PATCH":
        return _update_event(request, event_id)

    cached = get_cached_event(event_id)
    if cached is not None:
        return JsonResponse(cached)
    event = Event.objects.filter(pk=event_id).first()
    if event is None:
        return _error("event not found", 404)
    payload = event.to_dict()
    cache_event(event_id, payload)
    return JsonResponse(payload)


def _update_event(request, event_id):
    event = Event.objects.filter(pk=event_id).first()
    if event is None:
        return _error("event not found", 404)
    data = _body(request)
    if data is None:
        return _error("body must be a JSON object", 400)
    unknown = set(data) - EDITABLE_FIELDS
    if unknown:
        return _error(f"cannot edit: {', '.join(sorted(unknown))}", 400)
    for field, value in data.items():
        setattr(event, field, value)
    if event.capacity < event.seats_sold:
        return _error("capacity cannot drop below seats already sold", 400)
    event.save()
    evict_event(event_id)
    return JsonResponse(event.to_dict())


@csrf_exempt
@require_http_methods(["POST"])
def booking_create(request, event_id):
    if not Event.objects.filter(pk=event_id).exists():
        return _error("event not found", 404)
    data = _body(request)
    if data is None:
        return _error("body must be a JSON object", 400)
    try:
        booking = create_booking(event_id, data.get("email"), data.get("quantity"))
    except BookingError as err:
        return _error(err.message, err.status)
    return JsonResponse(booking.to_dict(), status=201)
