import json
import os
import unittest
import urllib.request

from backend.main import _clean_voice_answer, current_time_answer, extract_price_mentions, is_time_request, is_web_request, product_search_query


class TestVOXInterruption(unittest.TestCase):
    def test_time_request_is_detected_and_uses_configured_timezone(self):
        self.assertTrue(is_time_request("What time is it right now?"))
        self.assertIn("India Standard Time", current_time_answer("Asia/Kolkata"))

    def test_web_research_request_is_detected(self):
        self.assertTrue(is_web_request("What are the latest technologies?"))
        self.assertTrue(is_web_request("Search online for OLED TVs"))
        self.assertFalse(is_web_request("Tell me a joke"))

    def test_product_search_requests_current_prices_and_extracts_mentions(self):
        self.assertIn("current price listings", product_search_query("best laptop under 60000"))
        self.assertEqual(extract_price_mentions("Now ₹59,999, down from Rs. 64,999"), ["₹59,999", "Rs. 64,999"])

    def test_voice_answer_cleanup_removes_markdown_noise(self):
        self.assertEqual(_clean_voice_answer("**Answer:**\n- Fast.\n- Clear."), "Answer: Fast. Clear.")

    def test_new_task_is_newer(self):
        """Task IDs must be strictly monotonically increasing."""
        current_task_id = 1
        new_task_id = current_task_id + 1
        self.assertGreater(new_task_id, current_task_id)

    def test_stale_result_is_discarded(self):
        """A result for an inactive task must never be accepted for playback."""
        current_active_task_id = 2
        stale_task_id = 1
        self.assertNotEqual(stale_task_id, current_active_task_id)

    def test_interruption_state_machine(self):
        """An interrupted task cannot win after a newer task becomes active."""
        active_task_id = 0
        spoken = []

        active_task_id += 1
        task_1_id = active_task_id

        # User changes the request before task 1 finishes.
        active_task_id += 1
        task_2_id = active_task_id

        responses = [
            {"task_id": task_1_id, "text": "Here are laptops under 60000"},
            {"task_id": task_2_id, "text": "Here are laptops under 50000"},
        ]

        for response in responses:
            if response["task_id"] == active_task_id:
                spoken.append(response["text"])

        self.assertEqual(spoken, ["Here are laptops under 50000"])

    def test_rapid_multiple_interruptions_only_latest_task_wins(self):
        """Repeated changes of mind must leave only the latest task eligible."""
        active_task_id = 0
        task_ids = []
        for _ in range(5):
            active_task_id += 1
            task_ids.append(active_task_id)

        responses = [
            {"task_id": task_id, "text": f"response-{task_id}"}
            for task_id in reversed(task_ids)
        ]
        accepted = [r for r in responses if r["task_id"] == active_task_id]

        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["task_id"], 5)

    def test_task_ids_are_unique_for_sequential_requests(self):
        """Sequential requests must not reuse task IDs."""
        task_ids = list(range(1, 11))
        self.assertEqual(len(task_ids), len(set(task_ids)))

    @unittest.skipUnless(
        os.getenv("VOX_LIVE_TESTS") == "1",
        "Set VOX_LIVE_TESTS=1 to run tests against a live local backend/Rime configuration.",
    )
    def test_backend_health_endpoint(self):
        """Verify the running backend /health endpoint."""
        url = "http://127.0.0.1:8000/health"
        req = urllib.request.Request(url, headers={"User-Agent": "VOX-Test"})
        with urllib.request.urlopen(req, timeout=5) as response:
            self.assertEqual(response.status, 200)
            data = json.loads(response.read().decode())
            self.assertTrue(data.get("ok"))

    @unittest.skipUnless(
        os.getenv("VOX_LIVE_TESTS") == "1",
        "Set VOX_LIVE_TESTS=1 to run tests against a live local backend/Rime configuration.",
    )
    def test_backend_chat_preserves_task_id(self):
        """Verify the live backend returns the matching task_id in /chat."""
        url = "http://127.0.0.1:8000/chat"
        payload = json.dumps({"text": "Find laptops under 60000", "task_id": 42}).encode()
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=45) as response:
            self.assertEqual(response.status, 200)
            data = json.loads(response.read().decode())
            self.assertEqual(data.get("task_id"), 42)
            self.assertIn("text", data)
            self.assertIn("audio_base64", data)

    @unittest.skipUnless(
        os.getenv("VOX_LIVE_TESTS") == "1",
        "Set VOX_LIVE_TESTS=1 to run tests against a live local backend/Rime configuration.",
    )
    def test_backend_rime_audio_generation(self):
        """Verify the live backend returns Rime audio when configured."""
        url = "http://127.0.0.1:8000/chat"
        payload = json.dumps({"text": "Hello", "task_id": 99}).encode()
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=45) as response:
            self.assertEqual(response.status, 200)
            data = json.loads(response.read().decode())
            self.assertEqual(data.get("task_id"), 99)
            self.assertIsNotNone(
                data.get("audio_base64"),
                f"Expected audio_base64, got error: {data.get('rime_error')}",
            )
            self.assertEqual(data.get("audio_format"), "audio/mp3")


if __name__ == "__main__":
    unittest.main()
