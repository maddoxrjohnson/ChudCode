from django.db import transaction

from .models import Booking, Event

MAX_TICKETS_PER_BOOKING = 10


class BookingError(Exception):
    """A booking request that cannot be accepted. `status` is the HTTP status to answer with."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def parse_quantity(value):
    return int(value)


def create_booking(event_id, email, quantity):
    if not email or "@" not in email:
        raise BookingError("email is required")
    quantity = parse_quantity(quantity)

    with transaction.atomic():
        event = Event.objects.select_for_update().get(pk=event_id)
        if quantity > event.capacity:
            raise BookingError("not enough seats left", status=409)
        event.seats_sold += quantity
        event.save(update_fields=["seats_sold"])
        booking = Booking.objects.create(event=event, email=email, quantity=quantity)
    return booking
