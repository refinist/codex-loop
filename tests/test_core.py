import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from loop_core import *


def decision(action='continue', delay=60):
    return {'action': action, 'delay_seconds': delay, 'reason': 'Observed pending work', 'noop': True}


def timestamp(text):
    return dt.datetime.fromisoformat(text).timestamp()


class Parsing(unittest.TestCase):
    def test_modes(self):
        cases = [('', 'dynamic', None), ('/loop', 'dynamic', None),
                 ('$codex-loop check CI', 'dynamic', 'check CI'),
                 ('5m', 'fixed', None), ('/loop 5m check CI', 'fixed', 'check CI'),
                 ('check CI every 2 hours', 'fixed', 'check CI'),
                 ('check every PR', 'dynamic', 'check every PR'),
                 ('check every 20m', 'fixed', 'check'),
                 ('every 5 minutes', 'fixed', None),
                 ('5m check every 2 hours', 'fixed', 'check every 2 hours')]
        for text, mode, prompt in cases:
            with self.subTest(text=text):
                parsed = parse_request(text)
                self.assertEqual((parsed['mode'], parsed['prompt']), (mode, prompt))

    def test_intervals(self):
        for token, seconds in [('1s',60),('61s',120),('7m',360),('90m',7200),('5h',21600),('24h',86400),('2d',172800)]:
            with self.subTest(token=token):
                self.assertEqual(interval_schedule(token)['effective_seconds'], seconds)
        for token in ['0m','-1m','2w','32d','1000001s']:
            with self.subTest(token=token), self.assertRaises(ValueError):
                interval_schedule(token)

    def test_multiline_and_shell_text_preserved(self):
        text = 'check `date` $(touch /tmp/no)\nthen report'
        self.assertEqual(parse_request(text)['prompt'], text)


class CronTests(unittest.TestCase):
    def test_numeric_fields(self):
        cron = Cron('1,15-19/2 */2 * * 0,7')
        self.assertEqual(cron.values[0], {1,15,17,19})
        self.assertEqual(cron.values[4], {0})

    def test_invalid(self):
        for text in ['* * * *','60 * * * *','*/0 * * * *','0 0 * * MON','0 0 L * *','0 0 31 2 *']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                Cron(text).next(timestamp('2026-01-01T00:00:00+00:00'), 'UTC')

    def test_local_timezone(self):
        stamp = timestamp('2026-10-13T00:00:00+00:00')
        self.assertEqual(Cron('0 9 * * *').next(stamp,'Asia/Shanghai'), stamp+3600)

    def test_dom_dow_or(self):
        stamp = timestamp('2026-10-13T00:00:00+00:00')  # Tuesday
        self.assertEqual(Cron('0 0 20 * 3').next(stamp,'UTC'), stamp+86400)

    def test_leap_day(self):
        self.assertEqual(Cron('0 0 29 2 *').next(timestamp('2026-01-01T00:00:00+00:00'),'UTC'), timestamp('2028-02-29T00:00:00+00:00'))

    def test_dst_spring_gap(self):
        got = Cron('30 2 * * *').next(timestamp('2026-03-08T00:00:00-05:00'), 'America/New_York')
        self.assertEqual(got, timestamp('2026-03-09T02:30:00-04:00'))

    def test_dst_fall_repeat(self):
        got = Cron('30 1 * * *').next(timestamp('2026-11-01T01:30:00-04:00'), 'America/New_York')
        self.assertEqual(got, timestamp('2026-11-01T01:30:00-05:00'))


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.state = new_session('.', 'UTC')
        self.t = timestamp('2026-10-13T00:01:00+00:00')

    def test_immediate_both_modes(self):
        for req in ['check', '5m check']:
            with self.subTest(req=req):
                state = new_session('.', 'UTC')
                self.assertEqual(add_job(state, req, self.t)['due_at'],self.t)
                self.assertIsNotNone(claim(state,self.t))

    def test_dynamic_completion_relative(self):
        job = add_job(self.state,'check',self.t)
        owned = claim(self.state,self.t)
        finish(self.state,job['id'],owned['lease'],decision(delay=300),self.t+100)
        self.assertEqual(job['due_at'],self.t+400)
        self.assertIsNone(claim(self.state,self.t+399))

    def test_single_claim_and_stale_lease(self):
        add_job(self.state,'check',self.t)
        add_job(self.state,'other',self.t)
        owned = claim(self.state,self.t)
        self.assertIsNone(claim(self.state,self.t))
        with self.assertRaises(ValueError):
            finish(self.state,owned['id'],'wrong',decision(),self.t)
        cancel(self.state,owned['id'])
        with self.assertRaises(ValueError):
            finish(self.state,owned['id'],owned['lease'],decision(),self.t)
        self.assertIsNotNone(claim(self.state,self.t))

    def test_delay_validation_before_mutation(self):
        job = add_job(self.state,'check',self.t)
        owned = claim(self.state,self.t)
        for delay in [0,59,3601,60.5,True,None]:
            with self.subTest(delay=delay), self.assertRaises(ValueError):
                finish(self.state,job['id'],owned['lease'],decision(delay=delay),self.t)
            self.assertEqual(job['runs'],0)

    def test_fallback_once_and_reset(self):
        job = add_job(self.state,'check',self.t)
        owned = claim(self.state,self.t)
        finish(self.state,job['id'],owned['lease'],decision('fallback',None),self.t)
        self.assertEqual(job['due_at'],self.t+1200)
        owned = claim(self.state,self.t+1200)
        finish(self.state,job['id'],owned['lease'],decision(),self.t+1200)
        self.assertFalse(job['fallback_used'])
        owned = claim(self.state,self.t+1260)
        finish(self.state,job['id'],owned['lease'],decision('fallback',None),self.t+1260)
        owned = claim(self.state,self.t+2460)
        finish(self.state,job['id'],owned['lease'],decision('fallback',None),self.t+2460)
        self.assertEqual(job['status'],'stopped')

    def test_five_minute_cadence_and_coalescing(self):
        job = add_job(self.state,'5m check',self.t)
        owned = claim(self.state,self.t)
        finish(self.state,job['id'],owned['lease'],decision(),self.t+1800)
        self.assertEqual(job['due_at'],self.t+285)
        owned = claim(self.state,self.t+1800)
        finish(self.state,job['id'],owned['lease'],decision(),self.t+1800)
        self.assertEqual(job['due_at'],self.t+2085)
        self.assertIsNone(claim(self.state,self.t+1800))

    def test_jitter_stable(self):
        job = add_job(self.state,'10m check',self.t)
        a = next_fixed(job,self.t,'UTC')
        b = next_fixed(job,self.t+600,'UTC')
        self.assertEqual(b-a,600)
        nominal = Cron(job['cron']).next(self.t,'UTC')
        self.assertGreaterEqual(a,nominal)
        self.assertLessEqual(a,nominal+300)

    def test_one_shot(self):
        job = add_job(self.state,'remind',self.t,'0 9 * * *',True)
        nominal = Cron(job['cron']).next(self.t,'UTC')
        self.assertTrue(nominal-90 <= job['due_at'] <= nominal)
        self.assertIsNone(claim(self.state,self.t))
        owned = claim(self.state,nominal)
        finish(self.state,job['id'],owned['lease'],decision(),nominal)
        self.assertEqual(job['status'],'stopped')

    def test_off_hour_one_shot_not_shifted(self):
        job = add_job(self.state,'remind',self.t,'3 9 * * *',True)
        self.assertEqual(job['due_at'],Cron(job['cron']).next(self.t,'UTC'))

    def test_expiry_final_fire(self):
        job = add_job(self.state,'check',self.t)
        owned = claim(self.state,self.t+TTL)
        self.assertTrue(owned['final_fire'])
        finish(self.state,job['id'],owned['lease'],decision(),self.t+TTL)
        self.assertEqual(job['status'],'stopped')

    def test_restore(self):
        dynamic = add_job(self.state,'check',self.t)
        fixed = add_job(self.state,'5m check',self.t)
        one = add_job(self.state,'remind',self.t,'3 9 * * *',True)
        reopen(self.state,self.t+86400)
        self.assertEqual(dynamic['status'],'stopped')
        self.assertEqual(one['status'],'stopped')
        self.assertEqual(fixed['status'],'waiting')
        self.assertGreater(fixed['due_at'],self.t+86400)
        reopen(self.state,self.t+TTL)
        self.assertEqual(fixed['status'],'stopped')

    def test_interrupted_fixed_blocks(self):
        job = add_job(self.state,'5m check',self.t)
        claim(self.state,self.t)
        reopen(self.state,self.t+1)
        self.assertEqual(job['status'],'blocked')

    def test_wakeup_and_disable(self):
        job = add_job(self.state,'check',self.t)
        owned = claim(self.state,self.t)
        finish(self.state,job['id'],owned['lease'],decision(delay=3600),self.t)
        wake(self.state,job['id'],self.t+1)
        with patch.dict(os.environ, {'CODEX_LOOP_DISABLE':'1'}):
            self.assertIsNone(claim(self.state,self.t+1))
        self.assertIsNotNone(claim(self.state,self.t+1))

    def test_blocked_final_fire_remains_visible(self):
        job = add_job(self.state,'check',self.t)
        owned = claim(self.state,self.t+TTL)
        finish(self.state,job['id'],owned['lease'],decision('blocked',None),self.t+TTL)
        self.assertEqual(job['status'],'blocked')

    def test_noop_count_resets(self):
        job = add_job(self.state,'check',self.t)
        for n in range(2):
            owned = claim(self.state,self.t+n*60)
            finish(self.state,job['id'],owned['lease'],decision(),self.t+n*60)
        self.assertEqual(job['noop_count'],2)
        owned = claim(self.state,self.t+120)
        changed = decision()
        changed['noop'] = False
        finish(self.state,job['id'],owned['lease'],changed,self.t+120)
        self.assertEqual(job['noop_count'],0)

    def test_job_limit(self):
        for _ in range(50):
            add_job(self.state,'check',self.t)
        with self.assertRaises(ValueError):
            add_job(self.state,'check',self.t)
        cancel(self.state,next(iter(self.state['tasks'])))
        add_job(self.state,'check',self.t)

    def test_blocked_no_reschedule(self):
        job = add_job(self.state,'check',self.t)
        owned = claim(self.state,self.t)
        finish(self.state,job['id'],owned['lease'],decision('blocked',None),self.t)
        self.assertIsNone(claim(self.state,self.t+10000))


class StorageAndDefaults(unittest.TestCase):
    def test_precedence_hot_reload_empty_fallback_and_utf8_limit(self):
        with tempfile.TemporaryDirectory() as root:
            project, home = Path(root)/'project', Path(root)/'home'
            (project/'.codex').mkdir(parents=True)
            home.mkdir()
            (home/'loop.md').write_text('user task')
            job = {'prompt':None}
            self.assertEqual(resolve_prompt(job,str(project),str(home))[0], 'user task')
            path = project/'.codex/loop.md'
            path.write_text('project task')
            self.assertEqual(resolve_prompt(job,str(project),str(home))[0],'project task')
            path.write_text('changed')
            self.assertEqual(resolve_prompt(job,str(project),str(home))[0],'changed')
            self.assertEqual(resolve_prompt({'prompt':'explicit'},str(project),str(home))[0],'explicit')
            path.write_text('中'*9000)
            text, _ = resolve_prompt(job,str(project),str(home))
            self.assertIn('truncated',text)
            self.assertNotIn('\ufffd',text)
            path.write_text('  ')
            self.assertEqual(resolve_prompt(job,str(project),str(home))[0],'user task')
            (home/'loop.md').unlink()
            self.assertEqual(resolve_prompt(job,str(project),str(home))[1],'built-in')

    def test_atomic_state_and_rollback(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(Path(root).resolve()/'state.json')
            with store.transaction(root) as state:
                add_job(state,'check',0)
            before = store.path.read_text()
            with self.assertRaises(RuntimeError):
                with store.transaction() as state:
                    state['tasks'].clear()
                    raise RuntimeError('abort')
            self.assertEqual(store.path.read_text(),before)
            self.assertEqual(store.path.stat().st_mode & 0o777,0o600)
            with self.assertRaises(ValueError):
                with store.transaction('/'):
                    pass

    def test_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root)/'target'
            target.write_text('untouched')
            link = Path(root)/'state'
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                with Store(link).transaction(root):
                    pass
            self.assertEqual(target.read_text(),'untouched')


if __name__ == '__main__':
    unittest.main()
