import unittest

import numpy as np

from agent.backend.sandbox import _run_worker


class SandboxWindowContractTests(unittest.TestCase):
    def test_window_bounds_are_available_as_python_globals(self):
        dataset = {
            "array": np.arange(20, dtype=np.float32).reshape(1, 20),
            "fs": 10.0,
            "labels": ["FAC1"],
            "groups": ["FAC"],
        }
        code = """
result["startSec"] = startSec
result["endSec"] = endSec
result["durationSec"] = durationSec
result["start_sec"] = start_sec
result["end_sec"] = end_sec
result["window_start_sec"] = window_start_sec
result["window_end_sec"] = window_end_sec
result["t_abs0"] = float(t_abs[0])
result["t_abs_last"] = float(t_abs[-1])
result["workspace_window"] = workspace["executionWindow"]
"""

        out = _run_worker(code, dataset, {}, window_start_sec=42.0, window_end_sec=44.0)

        self.assertTrue(out["ok"], out["error"])
        self.assertEqual(out["result"]["startSec"], 42.0)
        self.assertEqual(out["result"]["endSec"], 44.0)
        self.assertEqual(out["result"]["durationSec"], 2.0)
        self.assertEqual(out["result"]["start_sec"], 42.0)
        self.assertEqual(out["result"]["end_sec"], 44.0)
        self.assertEqual(out["result"]["window_start_sec"], 42.0)
        self.assertEqual(out["result"]["window_end_sec"], 44.0)
        self.assertAlmostEqual(out["result"]["t_abs0"], 42.0)
        self.assertAlmostEqual(out["result"]["t_abs_last"], 43.9)
        self.assertEqual(out["result"]["workspace_window"]["startSec"], 42.0)
        self.assertEqual(out["result"]["workspace_window"]["endSec"], 44.0)

    def test_window_end_defaults_to_loaded_sample_span(self):
        dataset = {
            "array": np.zeros((1, 20), dtype=np.float32),
            "fs": 10.0,
            "labels": ["FAC1"],
            "groups": ["FAC"],
        }

        out = _run_worker("result['endSec'] = endSec", dataset, {}, window_start_sec=5.0)

        self.assertTrue(out["ok"], out["error"])
        self.assertEqual(out["result"]["endSec"], 7.0)


if __name__ == "__main__":
    unittest.main()
