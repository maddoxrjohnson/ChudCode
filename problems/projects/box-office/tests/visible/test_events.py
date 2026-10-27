from datetime import datetime, timezone

from django.core.cache import cache
from django.test import TestCase

from boxoffice.models import Event


def make_event(**overrides):
    fields = {
        "name": "Spring Showcase",
        "city": "Austin",
        "category": "music",
        "starts_at": datetime(2026, 5, 1, 19, 0, tzinfo=timezone.utc),
        "price_cents": 2500,
        "capacity": 100,
    }
    fields.update(overrides)
    return Event.objects.create(**fields)


class EventApiTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_list_is_ordered_by_start_time(self):
        later = make_event(name="Later", starts_at=datetime(2026, 6, 1, tzinfo=timezone.utc))
        sooner = make_event(name="Sooner", starts_at=datetime(2026, 4, 1, tzinfo=timezone.utc))
        response = self.client.get("/api/events/?page=1")
        self.assertEqual(response.status_code, 200)
        ids = [e["id"] for e in response.json()["results"]]
        self.assertEqual(ids, [sooner.id, later.id])

    def test_list_without_page_uses_the_first_page(self):
        make_event()
        response = self.client.get("/api/events/")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["page"], 1)
        self.assertEqual(body["page_size"], 10)
        self.assertEqual(len(body["results"]), 1)

    def test_filter_by_city(self):
        make_event(city="Austin")
        make_event(city="Raleigh")
        response = self.client.get("/api/events/?city=raleigh&page=1")
        cities = [e["city"] for e in response.json()["results"]]
        self.assertEqual(cities, ["Raleigh"])

    def test_create_event(self):
        response = self.client.post(
            "/api/events/",
            {
                "name": "Hack Night",
                "city": "Durham",
                "category": "tech",
                "starts_at": "2026-07-01T18:00:00+00:00",
                "price_cents": 0,
                "capacity": 40,
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["seats_left"], 40)

    def test_unknown_event_is_404(self):
        response = self.client.get("/api/events/999/")
        self.assertEqual(response.status_code, 404)

    def test_book_tickets(self):
        event = make_event(capacity=5)
        response = self.client.post(
            f"/api/events/{event.id}/bookings/",
            {"email": "sam@example.com", "quantity": 2},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        event.refresh_from_db()
        self.assertEqual(event.seats_left, 3)
