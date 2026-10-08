from typing import List


def max_window_sum(nums: List[int], k: int) -> int:
    n = len(nums)
    if k > n:
        return 0
    window = sum(nums[:k])
    best = window
    for i in range(k, n):
        window += nums[i] - nums[i - k]
        if window > best:
            best = window
    return best
