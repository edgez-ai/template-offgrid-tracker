"""Guard against treating queued radio traffic or stale RAM as wake success."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'capture', Path(__file__).resolve().parents[1] / 'test_pawr_twt_openocd.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class AssessmentTests(unittest.TestCase):
    def counters(self, **changes):
        result = dict(session=123, active=1, user_rx=2, ack_completed=2,
                      ack_failed=0, feedback_skipped=0, led_on=2, led_off=2,
                      host_released=1)
        result.update(changes)
        return result

    def test_delivery_does_not_require_rtt_active_log(self):
        self.assertTrue(all(capture.assess(123, self.counters(), 2, 2).values()))

    def test_queued_only_is_not_delivery(self):
        result = capture.assess(123, self.counters(user_rx=0, ack_completed=0,
                                                led_on=0, led_off=0), 2, 0)
        self.assertFalse(result['all_delivered'])
        self.assertFalse(result['all_acknowledged'])

    def test_old_session_counters_cannot_pass(self):
        self.assertFalse(capture.assess(456, self.counters(), 2, 2)['same_session'])

    def test_delivery_and_missing_feedback_are_distinct(self):
        result = capture.assess(123, self.counters(ack_completed=1,
                                                feedback_skipped=1), 2, 1)
        self.assertTrue(result['all_delivered'])
        self.assertFalse(result['all_acknowledged'])

    def test_led_still_on_is_not_complete(self):
        self.assertFalse(capture.assess(123, self.counters(led_off=1), 2, 2)[
            'led_cycles_complete'])

    def test_no_commands_cannot_pass(self):
        result = capture.assess(123, self.counters(user_rx=0, ack_completed=0,
                                                led_on=0, led_off=0), 0, 0)
        self.assertFalse(result['all_delivered'])
        self.assertFalse(result['all_acknowledged'])


if __name__ == '__main__':
    unittest.main()
