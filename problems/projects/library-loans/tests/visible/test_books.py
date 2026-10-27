from datetime import date, timedelta

from django.test import TestCase

from library.models import Book


def make_book(**overrides):
    fields = {"title": "Dune", "author": "Frank Herbert", "isbn": "9780441013593", "copies": 2}
    fields.update(overrides)
    return Book.objects.create(**fields)


class BookApiTests(TestCase):
    def test_list_books_by_title(self):
        make_book(title="Neuromancer", isbn="9780441569595")
        make_book(title="Dune")
        response = self.client.get("/api/books/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([b["title"] for b in response.json()], ["Dune", "Neuromancer"])

    def test_create_book(self):
        response = self.client.post(
            "/api/books/",
            {"title": "Kindred", "author": "Octavia Butler", "isbn": "978-0807083697", "copies": 3},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["isbn"], "9780807083697")

    def test_bad_isbn_is_rejected(self):
        response = self.client.post(
            "/api/books/",
            {"title": "X", "author": "Y", "isbn": "12ab", "copies": 1},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_borrow_a_book(self):
        book = make_book(copies=1)
        response = self.client.post(
            f"/api/books/{book.id}/loans/",
            {"member_email": "ana@example.com", "due_date": str(date.today() + timedelta(days=14))},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        detail = self.client.get(f"/api/books/{book.id}/").json()
        self.assertEqual(detail["copies_available"], 0)
