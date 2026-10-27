from django.db import models


class Event(models.Model):
    name = models.CharField(max_length=200)
    city = models.CharField(max_length=100)
    category = models.CharField(max_length=50)
    starts_at = models.DateTimeField()
    price_cents = models.PositiveIntegerField()
    capacity = models.PositiveIntegerField()
    seats_sold = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["starts_at", "id"]

    def __str__(self):
        return f"{self.name} ({self.city})"

    @property
    def seats_left(self):
        return self.capacity - self.seats_sold

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "city": self.city,
            "category": self.category,
            "starts_at": self.starts_at.isoformat(),
            "price_cents": self.price_cents,
            "capacity": self.capacity,
            "seats_left": self.seats_left,
        }


class Booking(models.Model):
    event = models.ForeignKey(Event, related_name="bookings", on_delete=models.CASCADE)
    email = models.EmailField()
    quantity = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    def to_dict(self):
        return {
            "id": self.id,
            "event": self.event_id,
            "email": self.email,
            "quantity": self.quantity,
        }
