## Box Office API

Box Office sells tickets to local events. This repository is its backend: a Django
project with one app, `boxoffice`. Production runs the cache on Redis; here it is
Django's local-memory cache, which has the same API.

Support has a queue of tickets against the API. Find the causes and fix them. The
tests in `tests/` are read-only: you can run them, but changing them counts against
you. More tests run when you submit.

## The API

**`GET /api/events/`** lists events, soonest first, as
`{"count", "page", "page_size", "results": [...]}`.

- Filters, all optional and combinable: `city` (case-insensitive exact match),
  `category` (exact), `min_price` and `max_price` (in cents, inclusive).
- `page` defaults to 1 and `page_size` to 10. A missing, non-numeric, zero, or
  negative value falls back to its default. `page_size` is capped at 50. A page past
  the end has an empty `results` list. `count` is the number of matching events.

**`POST /api/events/`** creates an event and answers `201` with it.

**`GET /api/events/<id>/`** returns one event, with `seats_left`. Responses are cached
for five minutes, so every write that changes an event must evict its cache entry.

**`PATCH /api/events/<id>/`** edits `name`, `city`, `category`, `price_cents`, or
`capacity`.

**`POST /api/events/<id>/bookings/`** books tickets: `{"email", "quantity"}`.

- `quantity` must be a whole number from 1 to 10; anything else is `400` with an
  `{"error": ...}` body.
- A booking for more seats than are left is `409`.
- A good booking answers `201` with the booking.

Unknown events are `404` everywhere.

## Reported issues

1. "Searching for events in Raleigh shows me events everywhere." Price filters act
   strangely too.
2. "The events page is down" — it errors for anyone who opens it without a `?page=`.
3. "I typed 'two' in the quantity box and got a server error."
4. "We sold 103 tickets to a 100-seat room."
5. "I bought tickets and the event page still shows the old number of seats left."

## Running the tests

```sh
python manage.py test
```
