from django.urls import path

from . import views

urlpatterns = [
    path("api/events/", views.event_list, name="event-list"),
    path("api/events/<int:event_id>/", views.event_detail, name="event-detail"),
    path("api/events/<int:event_id>/bookings/", views.booking_create, name="booking-create"),
]
