import unittest

from backend.main import conversation_memory, is_follow_up, build_messages, remember_turn


class TestFollowUpHandling(unittest.TestCase):
    def setUp(self):
        conversation_memory.clear()

    def test_make_it_is_follow_up(self):
        self.assertTrue(is_follow_up('Actually, make it 50000'))

    def test_follow_up_includes_previous_request(self):
        remember_turn('test-session', 'Find laptops under 60000', 'Here are some laptops under 60000.')
        messages = build_messages('Actually, make it 50000', 'en-IN', 'test-session')
        combined = '\n'.join(m['content'] for m in messages)
        self.assertIn('Find laptops under 60000', combined)
        self.assertIn('make it 50000', combined)


if __name__ == '__main__':
    unittest.main()
