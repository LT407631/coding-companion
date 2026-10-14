import threading
import unittest
from timings import Timings


class TimingsTests(unittest.TestCase):
    def test_counts_failures_and_no_input_values(self):
        clock = iter([1, 1.025, 2, 2.1])
        values = Timings(lambda: next(clock))
        with values.measure('search'):
            pass
        with self.assertRaises(ValueError), values.measure('search'):
            raise ValueError('private-query')
        snapshot = values.snapshot()
        self.assertEqual(snapshot['search']['count'], 2)
        self.assertEqual(snapshot['search']['errors'], 1)
        self.assertEqual(snapshot['search']['average_ms'], 62.5)
        self.assertNotIn('private-query', repr(snapshot))
        with self.assertRaises(ValueError), values.measure('private-url'):
            pass

    def test_concurrent_counts_are_not_lost(self):
        values = Timings()
        def work():
            for _ in range(100):
                with values.measure('sign'):
                    pass
        workers = [threading.Thread(target=work) for _ in range(4)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertEqual(values.snapshot()['sign']['count'], 400)
