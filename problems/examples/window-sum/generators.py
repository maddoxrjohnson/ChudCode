"""Input generators for hidden cases. Each returns a dict of arguments by name."""

import random


def large(n: int, k: int, seed: int = 1) -> dict:
    rng = random.Random(seed)
    return {"nums": [rng.randint(-10_000, 10_000) for _ in range(n)], "k": k}


def large_alternating(n: int, k: int) -> dict:
    return {"nums": [10_000 if i % 2 == 0 else -10_000 for i in range(n)], "k": k}
