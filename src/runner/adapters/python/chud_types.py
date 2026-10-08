"""Shared Python types for problems: ListNode, TreeNode, and JSON conversions.

Test cases describe linked lists and trees the way LeetCode does, as JSON arrays.
The harness converts arguments into objects before the call and results back into
arrays afterwards, guided by the declared parameter and return types. Candidate code
imports ListNode and TreeNode from here, so a solution written against this file
runs unchanged on LeetCode.
"""

from __future__ import annotations

import json
import re
from collections import deque

__all__ = ["ListNode", "TreeNode", "from_json", "to_json"]

MAX_NODES = 1_000_000


class ListNode:
    def __init__(self, val=0, next=None):  # noqa: A002 - matches LeetCode's signature
        self.val = val
        self.next = next

    def __repr__(self):
        return f"ListNode({self.val})"


class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

    def __repr__(self):
        return f"TreeNode({self.val})"


# ── Conversions ───────────────────────────────────────────────────────────────


def list_to_linked(values):
    head = None
    for v in reversed(values):
        head = ListNode(v, head)
    return head


def linked_to_list(node):
    out = []
    seen = set()
    while node is not None:
        if id(node) in seen or len(out) >= MAX_NODES:
            raise ValueError("linked list output has a cycle")
        seen.add(id(node))
        out.append(node.val)
        node = node.next
    return out


def list_to_tree(values):
    """Level-order array with None for missing children, LeetCode style."""
    if not values or values[0] is None:
        return None
    root = TreeNode(values[0])
    queue = deque([root])
    i = 1
    while queue and i < len(values):
        node = queue.popleft()
        if i < len(values) and values[i] is not None:
            node.left = TreeNode(values[i])
            queue.append(node.left)
        i += 1
        if i < len(values) and values[i] is not None:
            node.right = TreeNode(values[i])
            queue.append(node.right)
        i += 1
    return root


def tree_to_list(root):
    if root is None:
        return []
    out = []
    queue = deque([root])
    while queue:
        node = queue.popleft()
        if node is None:
            out.append(None)
            continue
        out.append(node.val)
        queue.append(node.left)
        queue.append(node.right)
        if len(out) > MAX_NODES:
            raise ValueError("tree output is too large or cyclic")
    while out and out[-1] is None:
        out.pop()
    return out


_OPTIONAL = re.compile(r"^Optional\[(.*)\]$")
_LIST = re.compile(r"^(?:List|list)\[(.*)\]$")


def _strip_optional(type_str):
    t = (type_str or "").replace(" ", "")
    m = _OPTIONAL.match(t)
    return m.group(1) if m else t


def from_json(value, type_str):
    """Build the Python argument a solution expects from its JSON form."""
    if value is None:
        return None
    t = _strip_optional(type_str)
    if t == "ListNode":
        return list_to_linked(value)
    if t == "TreeNode":
        return list_to_tree(value)
    m = _LIST.match(t)
    if m and _strip_optional(m.group(1)) in ("ListNode", "TreeNode"):
        return [from_json(v, m.group(1)) for v in value]
    return value


def _sort_key(value):
    return json.dumps(value, sort_keys=True, default=str)


def to_json(value, type_str=""):
    """Turn a solution's return value into JSON-compatible data.

    Duck typing decides the conversion, except that an absent node (None) for a declared
    ListNode or TreeNode becomes [], the way an empty structure is written in a test.
    """
    if value is None and _strip_optional(type_str) in ("ListNode", "TreeNode"):
        return []
    if isinstance(value, ListNode):
        return linked_to_list(value)
    if isinstance(value, TreeNode):
        return tree_to_list(value)
    if isinstance(value, bool) or value is None or isinstance(value, (int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted((to_json(v) for v in value), key=_sort_key)
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    return repr(value)
