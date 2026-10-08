## Problem

You are given an integer array `nums` and an integer `k`. A **window** is any run of
exactly `k` consecutive elements of `nums`.

Return the largest possible sum of a window. If `nums` has fewer than `k` elements,
return `0`.

## Examples

**Example 1**

```
Input:  nums = [2, 1, 5, 1, 3, 2], k = 3
Output: 9
```

The window `[5, 1, 3]` has the largest sum.

**Example 2**

```
Input:  nums = [-4, -2, -7, -1], k = 2
Output: -6
```

Every window has a negative sum. The windows are `[-4, -2]`, `[-2, -7]`, and
`[-7, -1]`, with sums -6, -9, and -8. The largest is -6.

**Example 3**

```
Input:  nums = [1, 2], k = 3
Output: 0
```

There is no window of three elements.

## Constraints

- `0 <= len(nums) <= 10^5`
- `-10^4 <= nums[i] <= 10^4`
- `1 <= k <= 10^5`

## Follow-up

Can you do it in a single pass without recomputing each window's sum from scratch?
