from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Book, Loan
from .serializers import BookSerializer, LoanSerializer


class BookList(APIView):
    def get(self, request):
        books = Book.objects.all()
        author = request.query_params.get("author")
        if author:
            books = books.filter(author__icontains=author)
        return Response(BookSerializer(books, many=True).data)

    def post(self, request):
        serializer = BookSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class BookDetail(APIView):
    def get(self, request, pk):
        book = get_object_or_404(Book, pk=pk)
        return Response(BookSerializer(book).data)


class LoanCreate(APIView):
    def post(self, request, pk):
        book = Book.objects.filter(pk=pk).first()
        if book is None:
            return Response({"detail": "book not found"}, status=status.HTTP_404_NOT_FOUND)
        serializer = LoanSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        if book.copies_available < 1:
            return Response({"detail": "no copies available"}, status=status.HTTP_409_CONFLICT)
        serializer.save(book=book)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class LoanReturn(APIView):
    def post(self, request, pk):
        loan = Loan.objects.filter(pk=pk).first()
        if loan is None:
            return Response({"detail": "loan not found"}, status=status.HTTP_404_NOT_FOUND)
        if loan.returned_at is not None:
            return Response({"detail": "already returned"}, status=status.HTTP_409_CONFLICT)
        loan.returned_at = timezone.now()
        loan.save(update_fields=["returned_at"])
        return Response(LoanSerializer(loan).data)
