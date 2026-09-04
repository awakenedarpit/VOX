import unittest
import json
import urllib.request
import urllib.error

class TestVOXInterruption(unittest.TestCase):
    def test_new_task_is_newer(self):
        """Task IDs must be strictly monotonically increasing."""
        current_task_id = 1
        new_task_id = current_task_id + 1
        self.assertGreater(new_task_id, current_task_id)

    def test_stale_result_is_discarded(self):
        """Any result whose task_id is less than current_task_id must be discarded."""
        current_active_task_id = 2
        stale_task_id = 1
        
        # Simulating client logic: if task_id != current_active_task_id: discard
        is_stale = (stale_task_id != current_active_task_id)
        self.assertTrue(is_stale, "Task 1 should be recognized as stale when active task is 2")

    def test_interruption_state_machine(self):
        """Simulate a user query being interrupted before response completes."""
        active_task_id = 0
        transcript = []

        # Step 1: User asks query 1
        active_task_id += 1
        task_1_id = active_task_id
        transcript.append(("user", "Find laptops under 60000", task_1_id))

        # Step 2: User interrupts with query 2
        active_task_id += 1
        task_2_id = active_task_id
        transcript.append(("user", "Actually, make it 50000", task_2_id))

        # Simulating out-of-order backend responses arriving:
        # Backend response 1 arrives late:
        resp_1 = {"task_id": task_1_id, "text": "Here are laptops under 60000"}
        if resp_1["task_id"] == active_task_id:
            transcript.append(("vox", resp_1["text"], resp_1["task_id"]))

        # Backend response 2 arrives:
        resp_2 = {"task_id": task_2_id, "text": "Here are laptops under 50000"}
        if resp_2["task_id"] == active_task_id:
            transcript.append(("vox", resp_2["text"], resp_2["task_id"]))

        # Verify: VOX only spoke response 2, never response 1
        vox_messages = [msg for sender, msg, _ in transcript if sender == "vox"]
        self.assertEqual(len(vox_messages), 1)
        self.assertEqual(vox_messages[0], "Here are laptops under 50000")

    def test_backend_health_endpoint(self):
        """Verify the running backend server /health endpoint."""
        url = "http://127.0.0.1:8000/health"
        req = urllib.request.Request(url, headers={"User-Agent": "VOX-Test"})
        with urllib.request.urlopen(req, timeout=5) as response:
            self.assertEqual(response.status, 200)
            data = json.loads(response.read().decode())
            self.assertTrue(data.get("ok"))

    def test_backend_chat_preserves_task_id(self):
        """Verify the running backend returns the matching task_id in /chat."""
        url = "http://127.0.0.1:8000/chat"
        payload = json.dumps({"text": "Find laptops under 60000", "task_id": 42}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as response:
            self.assertEqual(response.status, 200)
            data = json.loads(response.read().decode())
            self.assertEqual(data.get("task_id"), 42)
            self.assertIn("text", data)
            self.assertIn("audio_base64", data)

    def test_backend_rime_audio_generation(self):
        """Verify the running backend produces real Rime audio."""
        url = "http://127.0.0.1:8000/chat"
        payload = json.dumps({"text": "Hello", "task_id": 99}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=45) as response:
            self.assertEqual(response.status, 200)
            data = json.loads(response.read().decode())
            self.assertEqual(data.get("task_id"), 99)
            self.assertIsNotNone(data.get("audio_base64"), f"Expected audio_base64, got error: {data.get('rime_error')}")
            self.assertEqual(data.get("audio_format"), "audio/mp3")

if __name__ == "__main__":
    unittest.main()
