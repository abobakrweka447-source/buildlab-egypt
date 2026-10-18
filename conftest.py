"""Small optional stubs let source tests run in a sandbox without Redis/RQ installed.

Production and CI install the real packages from requirements.txt, so these stubs are not used there.
"""
from __future__ import annotations

import importlib.util
import sys
import types


if importlib.util.find_spec("redis") is None:
    class _Redis:
        def ping(self):
            raise RuntimeError("Redis is intentionally unavailable in the local test sandbox")

    redis_module = types.ModuleType("redis")
    redis_module.from_url = lambda *args, **kwargs: _Redis()
    sys.modules["redis"] = redis_module

if importlib.util.find_spec("rq") is None:
    class _Queue:
        def __init__(self, *args, **kwargs):
            pass

        def enqueue(self, *args, **kwargs):
            raise RuntimeError("RQ is intentionally unavailable in the local test sandbox")

    rq_module = types.ModuleType("rq")
    rq_module.Queue = _Queue
    rq_module.get_current_job = lambda: None
    sys.modules["rq"] = rq_module

    job_module = types.ModuleType("rq.job")

    class _Job:
        @staticmethod
        def fetch(*args, **kwargs):
            raise RuntimeError("RQ is intentionally unavailable in the local test sandbox")

    job_module.Job = _Job
    sys.modules["rq.job"] = job_module
