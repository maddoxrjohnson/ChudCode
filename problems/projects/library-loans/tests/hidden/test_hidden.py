from datetime import date, timedelta

from django.test import TestCase

from library.models import Book, Loan


def make_book(**overrides):
    fields = {"title": "Dune", "author": "Frank Herbert", "isbn": "9780441013593", "copies": 2}
    fields.update(overrides)
    return Book.objects.create(**fields)


def borrow(client, book_id, days=14, email="ana@example.com"):
    return client.post(
        f"/api/books/{book_id}/loans/",
        {"member_email": email, "due_date": str(date.today() + timedelta(days=days))},
        content_type="application/json",
    )


class StatusCodeTests(TestCase):
    def test_create_answers_201(self):
        response = self.client.post(
            "/api/books/",
            {"title": "Beloved", "author": "Toni Morrison", "isbn": "9781400033416", "copies": 1},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Book.objects.count(), 1)

    def test_unknown_book_is_404(self):
        self.assertEqual(self.client.get("/api/books/4242/").status_code, 404)

    def test_unknown_book_after_delete_is_404(self):
        book_id = make_book().id
        Book.objects.filter(pk=book_id).delete()
        self.assertEqual(self.client.get(f"/api/books/{book_id}/").status_code, 404)


class DueDateTests(TestCase):
    def setUp(self):
        self.book = make_book(copies=5)

    def test_past_due_date_is_rejected(self):
        response = borrow(self.client, self.book.id, days=-1)
        self.assertEqual(response.status_code, 400)
        self.assertIn("due_date", response.json())

    def test_today_is_rejected(self):
        self.assertEqual(borrow(self.client, self.book.id, days=0).status_code, 400)

    def test_more_than_thirty_days_is_rejected(self):
        self.assertEqual(borrow(self.client, self.book.id, days=31).status_code, 400)
        self.assertEqual(Loan.objects.count(), 0)

    def test_thirty_days_is_allowed(self):
        self.assertEqual(borrow(self.client, self.book.id, days=30).status_code, 201)


class AvailabilityTests(TestCase):
    def test_returned_copy_can_be_borrowed_again(self):
        book = make_book(copies=1)
        loan_id = borrow(self.client, book.id).json()["id"]
        self.assertEqual(self.client.post(f"/api/loans/{loan_id}/return/").status_code, 200)
        self.assertEqual(borrow(self.client, book.id, email="bo@example.com").status_code, 201)

    def test_available_count_ignores_returned_loans(self):
        book = make_book(copies=3)
        first = borrow(self.client, book.id).json()["id"]
        borrow(self.client, book.id, email="bo@example.com")
        self.client.post(f"/api/loans/{first}/return/")
        self.assertEqual(self.client.get(f"/api/books/{book.id}/").json()["copies_available"], 2)

    def test_all_copies_out_is_409(self):
        book = make_book(copies=1)
        borrow(self.client, book.id)
        self.assertEqual(borrow(self.client, book.id, email="bo@example.com").status_code, 409)

    def test_return_twice_is_409(self):
        book = make_book(copies=1)
        loan_id = borrow(self.client, book.id).json()["id"]
        self.client.post(f"/api/loans/{loan_id}/return/")
        self.assertEqual(self.client.post(f"/api/loans/{loan_id}/return/").status_code, 409)
