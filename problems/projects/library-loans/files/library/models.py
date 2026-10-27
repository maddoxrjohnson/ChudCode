from django.db import models


class Book(models.Model):
    title = models.CharField(max_length=200)
    author = models.CharField(max_length=120)
    isbn = models.CharField(max_length=13, unique=True)
    copies = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["title", "id"]

    def __str__(self):
        return self.title

    def copies_out(self):
        return self.loans.count()

    @property
    def copies_available(self):
        return self.copies - self.copies_out()


class Loan(models.Model):
    book = models.ForeignKey(Book, related_name="loans", on_delete=models.CASCADE)
    member_email = models.EmailField()
    due_date = models.DateField()
    returned_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
