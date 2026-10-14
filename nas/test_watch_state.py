import json
import sys
import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, str(Path(__file__).parent))
from watch_state import WatchState, install_watch_state
from test_site_auth import AuthTests
from watch_updates import WatchUpdates, install_watch_updates


def op(sid='1', kind='history', base=0, value=None, seed=False):
    if value is None:
        value = {'title': '测试', 'cover': '', 'ep': 43, 'epCnt': 81, 'pos': 25, 'dur': 90, 'finished': False}
    return {'sid': sid, 'kind': kind, 'base': base, 'value': value, 'seed': seed}


class StoreTests(unittest.TestCase):
    def setUp(self):
        folder = Path(__file__).parent / 'build'; folder.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=folder)
        self.store = WatchState(Path(self.tmp.name) / 'state.db')

    def tearDown(self):
        self.tmp.cleanup()

    def test_cas_offline_conflict_deliberate_rewatch_and_persistence(self):
        first = self.store.apply([op()])[0]
        newer = self.store.apply([op(base=first['rev'], value={**first['value'], 'ep': 44})])[0]
        stale = self.store.apply([op(base=first['rev'])])[0]
        self.assertFalse(stale['ok']); self.assertEqual(stale['value']['ep'], 44)
        rewind = self.store.apply([op(base=newer['rev'], value={**first['value'], 'ep': 2, 'pos': 3})])[0]
        self.assertTrue(rewind['ok']); self.assertEqual(rewind['value']['ep'], 2)
        self.assertEqual(WatchState(self.store.path).snapshot(), self.store.snapshot())

    def test_delete_tombstone_and_seed_never_resurrect(self):
        first = self.store.apply([op(kind='favorite')])[0]
        deleted = self.store.apply([{**op(kind='favorite', base=first['rev']), 'value': None}])[0]
        seed = self.store.apply([op(kind='favorite', seed=True)])[0]
        self.assertFalse(seed['ok']); self.assertIsNone(seed['value'])
        self.assertEqual(seed['rev'], deleted['rev'])
        self.assertEqual(self.store.values('favorite'), [])

    def test_parallel_compare_and_swap_only_one_wins(self):
        with ThreadPoolExecutor(6) as pool:
            result = list(pool.map(lambda _: self.store.apply([op()])[0], range(6)))
        self.assertEqual(sum(v['ok'] for v in result), 1)

    def test_fields_independent_incremental_read_and_seed_time(self):
        a = self.store.apply([op()])[0]
        b = self.store.apply([op(kind='favorite', value={'title':'旧收藏','cover':'','ts':123}, seed=True)])[0]
        self.assertEqual(b['value']['ts'], 123)
        self.assertEqual([v['kind'] for v in self.store.snapshot(a['rev'])['rows']], ['favorite'])
        self.assertEqual(len(self.store.snapshot()['rows']), 2)

    def test_history_is_bounded_with_deletion_markers(self):
        for start in range(0, 210, 30):
            self.store.apply([op(str(i+10), value={**op()['value'], 'ts':i+1}, seed=True) for i in range(start,start+30)])
        self.assertEqual(len(self.store.values('history')), 200)
        self.assertEqual(len(self.store.snapshot()['rows']), 210)
        self.assertFalse(self.store.apply([op('10', seed=True)])[0]['ok'])

    def test_invalid_batch_atomic_and_numeric_bounds(self):
        for value in ({'ep':-1}, {'pos':float('nan')}, {'title':'a'*501}, {'finished':'yes'}, {'cover':'javascript:x'}):
            with self.assertRaises(ValueError):
                self.store.apply([op(), op(sid='2', value={**op()['value'], **value})])
            self.assertEqual(self.store.snapshot()['cursor'], 0)


class ApiTests(AuthTests):
    def setUp(self):
        super().setUp()
        self.store = WatchState(self.root/'watch.db')
        install_watch_state(self.app, self.store)
        self.updates = WatchUpdates(self.store, lambda sid: 81)
        install_watch_updates(self.app, self.updates)

    def tearDown(self):
        self.updates.close(); super().tearDown()

    def test_sync_auth_origin_limits_and_server_identity(self):
        self.assertEqual(self.request('/watch-state')[0], 401)
        self.assertEqual(self.request('/watch-updates')[0], 401)
        self.assertEqual(self.request('/watch-state','POST',{})[0], 401)
        cookie,_ = self.login(); server = self.store.snapshot()['server']
        body = {'server':server,'operations':[op()]}
        self.assertEqual(self.request('/watch-state','POST',body,cookie,origin='https://evil.test')[0],403)
        self.assertEqual(self.request('/watch-state','POST',{**body,'server':'other'},cookie)[0],409)
        self.assertEqual(self.request('/watch-state','POST',body,cookie,raw=b' '*140000)[0],413)
        status,headers,response=self.request('/watch-state','POST',body,cookie)
        self.assertEqual(status,200);self.assertIn('no-store',headers['cache-control'])
        self.assertTrue(json.loads(response)['rows'][0]['ok'])
        self.assertEqual(self.request('/watch-state?since=-1',cookie=cookie)[0],422)


if __name__ == '__main__': unittest.main()
