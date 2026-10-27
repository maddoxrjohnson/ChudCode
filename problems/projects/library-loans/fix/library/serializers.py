from datetime import date, timedelta

from rest_framework import serializers

from .models import Book, Loan

MAX_LOAN_DAYS = 30


class BookSerializer(serializers.ModelSerializer):
    copies_available = serializers.IntegerField(read_only=True)
    # Wide enough for a hyphenated ISBN-13; validate_isbn strips the hyphens.
    isbn = serializers.CharField(max_length=17)

    class Meta:
        model = Book
        fields = ["id", "title", "author", "isbn", "copies", "copies_available"]

    def validate_isbn(self, value):
        digits = value.replace("-", "")
        if not digits.isdigit() or len(digits) not in (10, 13):
            raise serializers.ValidationError("isbn must be 10 or 13 digits")
        return digits


class LoanSerializer(serializers.ModelSerializer):
    class Meta:
        model = Loan
        fields = ["id", "book", "member_email", "due_date", "returned_at"]
        read_only_fields = ["id", "book", "returned_at"]

    def validate_due_date(self, value):
        today = date.today()
        if value <= today:
            raise serializers.ValidationError("due_date must be in the future")
        if value > today + timedelta(days=MAX_LOAN_DAYS):
            raise serializers.ValidationError(f"a loan lasts at most {MAX_LOAN_DAYS} days")
        return value
