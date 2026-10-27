from datetime import datetime, timezone

from django.core.cache import cache
from django.test import TestCase

from boxoffice.models import Booking, Event


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


def book(client, event_id, quantity, email="sam@example.com"):
    return client.post(
        f"/api/events/{event_id}/bookings/",
        {"email": email, "quantity": quantity},
        content_type="application/json",
    )


class FilterTests(TestCase):
    def setUp(self):
        cache.clear()
        self.austin_cheap = make_event(name="A", city="Austin", price_cents=1000)
        self.austin_dear = make_event(name="B", city="Austin", price_cents=9000, category="sports")
        self.raleigh = make_event(name="C", city="Raleigh", price_cents=4000)

    def names(self, query):
        response = self.client.get(f"/api/events/?{query}&page=1&page_size=10")
        self.assertEqual(response.status_code, 200)
        return sorted(e["name"] for e in response.json()["results"])

    def test_city_filter_ignores_case(self):
        self.assertEqual(self.names("city=AUSTIN"), ["A", "B"])

    def test_city_count_matches_results(self):
        response = self.client.get("/api/events/?city=Raleigh&page=1")
        self.assertEqual(response.json()["count"], 1)

    def test_max_price(self):
        self.assertEqual(self.names("max_price=4000"), ["A", "C"])

    def test_price_range(self):
        self.assertEqual(self.names("min_price=2000&max_price=5000"), ["C"])

    def test_filters_combine(self):
        self.assertEqual(self.names("city=austin&max_price=5000"), ["A"])

    def test_category_and_city(self):
        self.assertEqual(self.names("city=austin&category=sports"), ["B"])


class PaginationTests(TestCase):
    def setUp(self):
        cache.clear()
        for i in range(25):
            make_event(name=f"E{i:02d}", starts_at=datetime(2026, 1, i + 1, tzinfo=timezone.utc))

    def page(self, query):
        response = self.client.get(f"/api/events/?{query}")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_missing_page_defaults_to_first(self):
        body = self.page("")
        self.assertEqual((body["page"], body["page_size"], len(body["results"])), (1, 10, 10))
        self.assertEqual(body["count"], 25)

    def test_non_numeric_page_falls_back(self):
        body = self.page("page=abc&page_size=five")
        self.assertEqual((body["page"], body["page_size"]), (1, 10))

    def test_zero_and_negative_fall_back(self):
        body = self.page("page=0&page_size=-3")
        self.assertEqual((body["page"], body["page_size"]), (1, 10))
        self.assertEqual(body["results"][0]["name"], "E00")

    def test_last_partial_page(self):
        body = self.page("page=3&page_size=10")
        self.assertEqual([e["name"] for e in body["results"]], ["E20", "E21", "E22", "E23", "E24"])

    def test_page_past_the_end_is_empty(self):
        self.assertEqual(self.page("page=9")["results"], [])

    def test_page_size_is_capped(self):
        for i in range(30):
            make_event(name=f"F{i:02d}", starts_at=datetime(2026, 3, 1, tzinfo=timezone.utc))
        body = self.page("page_size=500")
        self.assertEqual((body["page_size"], len(body["results"])), (50, 50))


class QuantityValidationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.event = make_event(capacity=50)

    def assert_rejected(self, quantity):
        response = book(self.client, self.event.id, quantity)
        self.assertEqual(response.status_code, 400, f"quantity={quantity!r}")
        self.assertIn("error", response.json())
        self.assertEqual(Booking.objects.count(), 0)

    def test_text_quantity(self):
        self.assert_rejected("two")

    def test_missing_quantity(self):
        self.assert_rejected(None)

    def test_zero_and_negative(self):
        self.assert_rejected(0)
        self.assert_rejected(-2)

    def test_more_than_ten(self):
        self.assert_rejected(11)

    def test_ten_is_allowed(self):
        self.assertEqual(book(self.client, self.event.id, 10).status_code, 201)


class OverbookingTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_cannot_buy_more_than_seats_left(self):
        event = make_event(capacity=8)
        self.assertEqual(book(self.client, event.id, 6).status_code, 201)
        response = book(self.client, event.id, 3)
        self.assertEqual(response.status_code, 409)
        event.refresh_from_db()
        self.assertEqual(event.seats_left, 2)

    def test_last_seats_can_be_sold(self):
        event = make_event(capacity=8)
        book(self.client, event.id, 6)
        self.assertEqual(book(self.client, event.id, 2).status_code, 201)
        event.refresh_from_db()
        self.assertEqual(event.seats_left, 0)

    def test_sold_out(self):
        event = make_event(capacity=2)
        book(self.client, event.id, 2)
        self.assertEqual(book(self.client, event.id, 1).status_code, 409)


class CacheTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_detail_reflects_a_booking(self):
        event = make_event(capacity=20)
        self.assertEqual(self.client.get(f"/api/events/{event.id}/").json()["seats_left"], 20)
        book(self.client, event.id, 4)
        self.assertEqual(self.client.get(f"/api/events/{event.id}/").json()["seats_left"], 16)

    def test_detail_reflects_an_edit(self):
        event = make_event()
        self.client.get(f"/api/events/{event.id}/")
        self.client.patch(
            f"/api/events/{event.id}/", {"price_cents": 500}, content_type="application/json"
        )
        self.assertEqual(self.client.get(f"/api/events/{event.id}/").json()["price_cents"], 500)

    def test_detail_is_cached(self):
        event = make_event()
        self.client.get(f"/api/events/{event.id}/")
        with self.assertNumQueries(0):
            self.assertEqual(self.client.get(f"/api/events/{event.id}/").status_code, 200)
