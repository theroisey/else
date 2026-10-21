#!/usr/bin/env python3
"""Regression checks for offline policy scoping and preservation."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location("relay_policy",Path(__file__).with_name("stalwart-relay-policy.py"))
policy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

def baseline():
    return {kind:{field:{"match":{"0":{"if":"existing_condition","then":"existing_result"}},"else":"existing_fallback"} for field in fields} for kind,fields in policy.FIELDS.items()}

class PolicyTests(unittest.TestCase):
    def test_preserves_every_existing_branch_fallback_and_input(self):
        before=baseline(); original=copy.deepcopy(before)
        result=policy.generate(before,"10.200.44.3","10.200.44.2","noreply@example.test",policy.VERSION)
        self.assertEqual(before,original)
        for kind,fields in result["update"].items():
            for field,expression in fields.items():
                self.assertEqual(expression["match"]["1"],before[kind][field]["match"]["0"])
                self.assertEqual(expression["else"],before[kind][field]["else"])
                self.assertEqual(expression["match"]["0"]["if"],"listener = 'else-relay'")
        for kind,field in [("MtaStageMail","isSenderAllowed"),("MtaStageRcpt","allowRelaying")]:
            self.assertEqual(result["update"][kind][field]["match"]["0"]["then"],"remote_ip = '10.200.44.3' && is_tls && sender = 'noreply@example.test'")
        listener=result["create"]["NetworkListener"]
        self.assertEqual(listener["bind"],{"10.200.44.2:10025":True})
        self.assertTrue(listener["useTls"])
        self.assertFalse(listener["tlsImplicit"])
    def test_refuses_unsupported_version_and_unsafe_identities(self):
        for source,server,sender,version in [
            ("8.8.8.8","10.0.0.2","noreply@example.test",policy.VERSION),
            ("10.0.0.3","127.0.0.1","noreply@example.test",policy.VERSION),
            ("10.0.0.2","10.0.0.2","noreply@example.test",policy.VERSION),
            ("10.0.0.0/24","10.0.0.2","noreply@example.test",policy.VERSION),
            ("10.0.0.3","10.0.0.2","x' || true || 'y@example.test",policy.VERSION),
            ("10.0.0.3","10.0.0.2","noreply@example.test","0.15.0"),
        ]:
            with self.assertRaises(ValueError): policy.generate(baseline(),source,server,sender,version)
    def test_refuses_duplicate_or_incomplete_exports(self):
        before=baseline()
        before["MtaStageAuth"]["require"]["else"]="listener = 'else-relay'"
        with self.assertRaises(ValueError): policy.generate(before,"10.0.0.3","10.0.0.2","noreply@example.test",policy.VERSION)
        before=baseline();del before["MtaStageMail"]["isSenderAllowed"]["else"]
        with self.assertRaises(ValueError): policy.generate(before,"10.0.0.3","10.0.0.2","noreply@example.test",policy.VERSION)

if __name__=="__main__": unittest.main()
