"""
Tests for latency_trace.py — run with:  python3 -m pytest python/tests -v
(or python3 -m unittest discover python/tests, no pytest required)
"""

import json
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from latency_trace import (
    Tracer,
    accounting,
    compute_cost,
    infer_cat,
    price_for,
    rag_metrics,
    run_with,
)


class TestTracerTiming(unittest.TestCase):
    def test_span_records_name_cat_and_positive_duration(self):
        t = Tracer("test")
        with t.span("fetch", "tool"):
            time.sleep(0.02)
        self.assertEqual(len(t.spans), 1)
        s = t.spans[0]
        self.assertEqual(s["name"], "fetch")
        self.assertEqual(s["cat"], "tool")
        self.assertGreaterEqual(s["dur"], 15)
        self.assertTrue(s["ok"])

    def test_span_marks_failed_and_reraises_on_exception(self):
        t = Tracer("test")
        with self.assertRaises(ValueError):
            with t.span("boom", "tool"):
                raise ValueError("nope")
        self.assertEqual(len(t.spans), 1)
        self.assertFalse(t.spans[0]["ok"])

    def test_category_inferred_when_omitted(self):
        t = Tracer("test")
        with t.span("claude final response"):
            pass
        with t.span("pgvector policy_chunks"):
            pass
        with t.span("benefits eligibility api"):
            pass
        cats = [s["cat"] for s in t.spans]
        self.assertEqual(cats, ["llm", "retr", "tool"])

    def test_total_ms_reflects_last_span_end(self):
        t = Tracer("test")
        with t.span("a", "tool"):
            time.sleep(0.01)
        with t.span("b", "tool"):
            time.sleep(0.01)
        self.assertGreaterEqual(t.total_ms, 18)

    def test_ttft_none_when_no_event_recorded(self):
        t = Tracer("test")
        with t.span("a", "llm"):
            pass
        self.assertIsNone(t.ttft_ms)

    def test_ttft_captured_via_event(self):
        t = Tracer("test")
        with t.span("stream", "llm"):
            time.sleep(0.01)
            t.event("first_token")
            time.sleep(0.01)
        self.assertIsNotNone(t.ttft_ms)
        self.assertLess(t.ttft_ms, t.total_ms)


class TestOverlapDetection(unittest.TestCase):
    def test_threaded_spans_detected_as_parallel_in_lab_text(self):
        t = Tracer("test")
        with ThreadPoolExecutor() as pool:
            pool.submit(run_with, t, "a", "tool", lambda: time.sleep(0.03))
            pool.submit(run_with, t, "b", "tool", lambda: time.sleep(0.02))
        text = t.to_lab_text()
        lines = text.split("\n")
        self.assertTrue(any(l.startswith("| ") for l in lines))

    def test_sequential_spans_not_marked_parallel(self):
        t = Tracer("test")
        with t.span("a", "tool"):
            time.sleep(0.01)
        with t.span("b", "tool"):
            time.sleep(0.01)
        lines = t.to_lab_text().split("\n")
        self.assertTrue(all(not l.startswith("| ") for l in lines))

    def test_thread_safety_no_lost_spans_under_concurrent_writes(self):
        t = Tracer("test")
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(run_with, t, f"span-{i}", "tool", lambda: None) for i in range(50)]
            for f in futures:
                f.result()
        self.assertEqual(len(t.spans), 50)


class TestCostAccounting(unittest.TestCase):
    def test_compute_cost_matches_pricing_table(self):
        cost = compute_cost({"model": "claude-haiku-4", "input_tokens": 1000, "output_tokens": 500})
        expected = (1000 * 0.8 + 500 * 4) / 1_000_000
        self.assertAlmostEqual(cost, expected, places=10)

    def test_fuzzy_model_matching(self):
        self.assertEqual(price_for("anthropic/claude-sonnet-4-20250514"), (3, 15))
        self.assertEqual(price_for("groq/qwen-2.5-32b-instruct"), (0.2, 0.2))

    def test_unknown_model_returns_zero_cost(self):
        self.assertEqual(compute_cost({"model": "mystery-model-9000", "input_tokens": 1000}), 0.0)
        self.assertIsNone(price_for("mystery-model-9000"))

    def test_explicit_cost_override_wins(self):
        cost = compute_cost({"model": "claude-opus-4", "input_tokens": 999999, "cost_usd": 0.001})
        self.assertEqual(cost, 0.001)

    def test_none_attrs_returns_zero(self):
        self.assertEqual(compute_cost(None), 0.0)
        self.assertEqual(compute_cost({}), 0.0)


class TestRagMetrics(unittest.TestCase):
    def test_precision_recall_mrr(self):
        m = rag_metrics({"retrieved_ids": ["a", "b", "c", "x", "y"], "relevant_ids": ["a", "c", "z"], "k": 5})
        self.assertAlmostEqual(m["precision_at_k"], 2 / 5)
        self.assertAlmostEqual(m["recall_at_k"], 2 / 3)
        self.assertEqual(m["mrr"], 1.0)

    def test_mrr_when_first_hit_not_rank_one(self):
        m = rag_metrics({"retrieved_ids": ["x", "y", "a"], "relevant_ids": ["a"]})
        self.assertAlmostEqual(m["mrr"], 1 / 3)

    def test_defaults_k_to_five(self):
        m = rag_metrics({"retrieved_ids": ["a", "b", "c", "d", "e", "f"], "relevant_ids": ["f"]})
        self.assertEqual(m["precision_at_k"], 0)
        self.assertAlmostEqual(m["mrr"], 1 / 6)

    def test_empty_relevant_set_does_not_raise(self):
        m = rag_metrics({"retrieved_ids": ["a", "b"], "relevant_ids": []})
        self.assertEqual(m["recall_at_k"], 0.0)

    def test_none_when_ids_absent(self):
        self.assertIsNone(rag_metrics(None))
        self.assertIsNone(rag_metrics({"model": "x"}))


class TestAccountingRollup(unittest.TestCase):
    def test_sums_tokens_and_groups_by_model(self):
        spans = [
            {"name": "a", "cat": "llm", "attrs": {"model": "claude-haiku-4", "input_tokens": 1000, "output_tokens": 100}},
            {"name": "b", "cat": "llm", "attrs": {"model": "claude-haiku-4", "input_tokens": 500, "output_tokens": 50}},
            {"name": "c", "cat": "tool"},  # no attrs, ignored
        ]
        acc = accounting(spans)
        self.assertEqual(acc["input_tokens"], 1500)
        self.assertEqual(acc["output_tokens"], 150)
        self.assertEqual(acc["by_model"]["claude-haiku-4"]["calls"], 2)
        self.assertGreater(acc["cost_usd"], 0)

    def test_averages_rag_across_spans(self):
        spans = [
            {"name": "r1", "cat": "retr", "attrs": {"retrieved_ids": ["a"], "relevant_ids": ["a"], "k": 5}},
            {"name": "r2", "cat": "retr", "attrs": {"retrieved_ids": ["x"], "relevant_ids": ["a"], "k": 5}},
        ]
        acc = accounting(spans)
        self.assertEqual(acc["rag"]["samples"], 2)
        self.assertAlmostEqual(acc["rag"]["recall_at_k"], 0.5)

    def test_no_attrs_yields_null_rag_and_zero_cost(self):
        acc = accounting([{"name": "a", "cat": "tool"}])
        self.assertIsNone(acc["rag"])
        self.assertEqual(acc["cost_usd"], 0.0)


class TestExportFormats(unittest.TestCase):
    def test_to_json_is_valid_and_includes_cost(self):
        t = Tracer("test")
        with t.span("final", "llm", attrs={"model": "claude-haiku-4", "input_tokens": 100, "output_tokens": 10}):
            pass
        parsed = json.loads(t.to_json())
        self.assertEqual(len(parsed), 1)
        self.assertIn("cost_usd", parsed[0])
        self.assertGreater(parsed[0]["cost_usd"], 0)

    def test_to_otlp_shape_and_attributes(self):
        t = Tracer("test")
        with t.span("llm call", "llm", attrs={"model": "claude-haiku-4", "input_tokens": 100, "output_tokens": 10}):
            pass
        with t.span("search", "retr", attrs={"retrieved_ids": ["a"], "relevant_ids": ["a"], "k": 5}):
            pass
        payload = t.to_otlp("test-service")
        spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
        self.assertEqual(len(spans), 2)
        llm_keys = [a["key"] for a in spans[0]["attributes"]]
        self.assertIn("llm.cost.usd", llm_keys)
        rag_keys = [a["key"] for a in spans[1]["attributes"]]
        self.assertIn("rag.recall_at_k", rag_keys)
        self.assertEqual(
            payload["resourceSpans"][0]["resource"]["attributes"][0]["value"]["stringValue"],
            "test-service",
        )


class TestCategoryInference(unittest.TestCase):
    def test_llm_keywords(self):
        for name in ["claude final response", "planner", "qwen synthesis", "reflection step"]:
            self.assertEqual(infer_cat(name), "llm")

    def test_retrieval_keywords(self):
        for name in ["pgvector search", "embed query", "rerank results"]:
            self.assertEqual(infer_cat(name), "retr")

    def test_tool_keywords(self):
        for name in ["benefits api", "postgres query", "redis cache lookup"]:
            self.assertEqual(infer_cat(name), "tool")

    def test_falls_back_to_orch(self):
        self.assertEqual(infer_cat("gateway routing"), "orch")


if __name__ == "__main__":
    unittest.main()
