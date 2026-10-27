from django.urls import path

from . import views

urlpatterns = [
    path("api/books/", views.BookList.as_view(), name="book-list"),
    path("api/books/<int:pk>/", views.BookDetail.as_view(), name="book-detail"),
    path("api/books/<int:pk>/loans/", views.LoanCreate.as_view(), name="loan-create"),
    path("api/loans/<int:pk>/return/", views.LoanReturn.as_view(), name="loan-return"),
]
