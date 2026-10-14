import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from watch_state import WatchState
from watch_updates import WatchUpdates
from test_watch_state import op


class UpdatesTests(unittest.TestCase):
    def setUp(self):
        folder=Path(__file__).parent/'build';folder.mkdir(exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=folder)
        self.state=WatchState(Path(self.tmp.name)/'state.db');self.count=10;self.now=100000;self.calls=0
        self.state.apply([op(kind='favorite')])
        self.updates=WatchUpdates(self.state,self.load,clock=lambda:self.now)

    def load(self,sid):
        self.calls+=1
        if self.count is None:raise OSError('offline')
        return self.count

    def tearDown(self):
        self.updates.close();self.tmp.cleanup()

    def test_baseline_new_episodes_seen_and_throttle(self):
        self.updates._run();self.assertEqual(self.updates.snapshot()['items']['1']['new'],0)
        self.count=13;self.updates._run();self.assertEqual(self.calls,1)
        self.now+=21601;self.updates._run();self.assertEqual(self.updates.snapshot()['items']['1']['new'],3)
        self.state.apply([op(value={**op()['value'],'ep':11,'epCnt':13,'finished':True})])
        item=self.updates.snapshot()['items']['1'];self.assertEqual(item['new'],2);self.assertEqual(item['next'],12)

    def test_failure_keeps_counts_and_first_success_is_baseline(self):
        self.count=None;self.updates._run();self.assertEqual(self.updates.snapshot()['items'],{})
        self.count=10;self.now+=601;self.updates._run();self.assertEqual(self.updates.snapshot()['items']['1']['new'],0)
        self.count=None;self.now+=21601;self.updates._run();self.assertEqual(self.updates.snapshot()['items']['1']['available'],10)

    def test_stale_catalogue_does_not_mark_follow_check_fresh(self):
        import ast
        from types import SimpleNamespace
        tree = ast.parse((Path(__file__).parent / 'nas_server.py').read_text())
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'follow_count')
        catalogue = SimpleNamespace(get=lambda *args: (SimpleNamespace(body=b'{"episodes":[1,2,3]}'), 'STALE'))
        env = {'catalog': catalogue, 'request_key': lambda *args: 'episodes'}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), '<follow_count>', 'exec'), env)
        with self.assertRaises(RuntimeError):
            env['follow_count']('1')
        catalogue.get = lambda *args: (SimpleNamespace(body=b'{"episodes":[1,2,3]}'), 'HIT')
        self.assertEqual(env['follow_count']('1'), 3)

    def test_remove_favorite_and_bounded_work(self):
        self.state.apply([op(str(n),kind='favorite') for n in range(2,22)])
        self.updates._run();self.assertEqual(self.calls,12)
        rev=self.state.snapshot()['rows'][0]['rev'];self.state.apply([{**op(kind='favorite',base=rev),'value':None}])
        self.assertNotIn('1',self.updates.snapshot()['items'])


if __name__ == '__main__':unittest.main()
