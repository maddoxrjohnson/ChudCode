## Library Loans API

A small library tracks its books and loans with this Django REST framework service.
The app is `library`. Members borrow copies and return them; the front desk checks
how many copies are on the shelf.

The tests in `tests/` are read-only. More tests run when you submit.

## The API

**`GET /api/books/`** lists books by title. `?author=` filters by a case-insensitive
substring of the author.

**`POST /api/books/`** adds a book and answers `201` with it. `isbn` must be 10 or 13
digits; hyphens are dropped. Bad input is `400`.

**`GET /api/books/<id>/`** returns one book with `copies_available`: its copies minus
the loans not yet returned. An unknown id is `404`.

**`POST /api/books/<id>/loans/`** borrows a copy: `{"member_email", "due_date"}`.

- `due_date` must be after today and at most 30 days away; otherwise `400`, with the
  error under `due_date`.
- With no copy available, `409`.
- A good loan answers `201`.

**`POST /api/loans/<id>/return/`** returns a loan. Returning it twice is `409`.

## Reported issues

1. "Our integration treats anything but 201 as a failed create, and every book we add
   looks like a failure."
2. "Opening a book that was removed crashes the page."
3. "Someone borrowed a book due back last year."
4. "We have one copy of a book. It came back yesterday and the system still says it is
   out."

## Running the tests

```sh
python manage.py test
```
