from django.db import transaction

from .cache import evict_event
from .models import Booking, Event

MAX_TICKETS_PER_BOOKING = 10


class BookingError(Exception):
    """A booking request that cannot be accepted. `status` is the HTTP status to answer with."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def parse_quantity(value):
    if isinstance(value, bool):
        raise BookingError("quantity must be a whole number")
    try:
        quantity = int(value)
    except (TypeError, ValueError):
        raise BookingError("quantity must be a whole number")
    if isinstance(value, float) and value != quantity:
        raise BookingError("quantity must be a whole number")
    if not 1 <= quantity <= MAX_TICKETS_PER_BOOKING:
        raise BookingError(f"quantity must be from 1 to {MAX_TICKETS_PER_BOOKING}")
    return quantity


def create_booking(event_id, email, quantity):
    if not email or "@" not in email:
        raise BookingError("email is required")
    quantity = parse_quantity(quantity)

    with transaction.atomic():
        event = Event.objects.select_for_update().get(pk=event_id)
        if quantity > event.seats_left:
            raise BookingError("not enough seats left", status=409)
        event.seats_sold += quantity
        event.save(update_fields=["seats_sold"])
        booking = Booking.objects.create(event=event, email=email, quantity=quantity)
    evict_event(event_id)
    return booking
