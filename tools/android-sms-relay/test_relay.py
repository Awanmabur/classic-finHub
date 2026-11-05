import contextlib
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("relay", Path(__file__).with_name("relay.py"))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.config = {"endpoint": "https://example.invalid/integrations/sms/"+"a"*32,
                       "secret": "b"*64, "senders": {"mtn"}, "poll_seconds": 15}
        self.db = relay.open_queue(self.root / "queue.sqlite")

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def rows(self, *rows):
        return lambda offset, limit: list(rows) if offset == 0 else []

    def message(self, sender="MTN", at=1800000001, body="MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: Jane Doe; Ref: ABC12345"):
        return {"number": sender, "received": at, "body": body}

    def test_collects_only_allowlisted_new_messages_and_deduplicates(self):
        rows = self.rows(self.message(), self.message("Friend"), self.message(at=1799999999))
        self.assertEqual(relay.collect(self.db, self.config, rows, now=1800000000), 1)
        self.assertEqual(relay.collect(self.db, self.config, rows, now=1800000020), 0)
        payload = self.db.execute("SELECT payload FROM messages").fetchone()[0]
        self.assertNotIn("Friend", payload)
        self.assertIn('"receivedAt":"2027-', payload)

    def test_explicit_first_run_historical_import(self):
        self.assertEqual(relay.collect(self.db, self.config, self.rows(self.message(at=1799999000)),
                                       now=1800000000, import_existing=True), 1)

    def test_cannot_silently_turn_a_live_queue_into_historical_import(self):
        relay.collect(self.db, self.config, self.rows(), now=1800000000)
        with self.assertRaises(ValueError):
            relay.collect(self.db, self.config, self.rows(), import_existing=True)

    def test_acknowledgment_scrubs_sms_text_and_retains_dedupe(self):
        reader = self.rows(self.message())
        relay.collect(self.db, self.config, reader, now=1800000000)
        result = relay.deliver(self.db, self.config, lambda c, p, n: (202, True), now=1800000001)
        self.assertEqual(result["sent"], 1)
        self.assertEqual(self.db.execute("SELECT state,payload FROM messages").fetchone(), ("sent", None))
        self.assertEqual(relay.collect(self.db, self.config, reader, now=1800000040), 0)

    def test_transient_error_is_persisted_and_retried_after_backoff(self):
        relay.collect(self.db, self.config, self.rows(self.message()), now=1800000000)
        relay.deliver(self.db, self.config, lambda c, p, n: (429, False), now=1800000001)
        self.assertEqual(self.db.execute("SELECT state,attempts,next_attempt FROM messages").fetchone(),
                         ("pending", 1, 1800000016))
        self.assertEqual(relay.deliver(self.db, self.config, lambda c, p, n: (200, True), now=1800000010)["sent"], 0)
        self.assertEqual(relay.deliver(self.db, self.config, lambda c, p, n: (200, True), now=1800000016)["sent"], 1)

    def test_credentials_failure_keeps_queue_and_permanent_conflict_deadletters(self):
        relay.collect(self.db, self.config, self.rows(self.message()), now=1800000000)
        relay.deliver(self.db, self.config, lambda c, p, n: (403, False), now=1800000001)
        self.assertEqual(self.db.execute("SELECT state FROM messages").fetchone()[0], "pending")
        relay.deliver(self.db, self.config, lambda c, p, n: (409, False), now=1800004001)
        self.assertEqual(self.db.execute("SELECT state FROM messages").fetchone()[0], "dead")

    def test_queue_cannot_be_rebound_to_another_workspace(self):
        relay.collect(self.db, self.config, self.rows(self.message()), now=1800000000)
        with self.assertRaises(ValueError):
            relay.deliver(self.db, {**self.config, "endpoint": self.config["endpoint"]+"other"})

    def test_full_queue_drains_before_collection_can_block(self):
        payload=json.dumps(relay.normalize_message(self.message())[0])
        self.db.executemany("INSERT INTO messages(message_id,payload,state,created_at) VALUES (?,?,'pending',?)",
                            [("queued-"+str(i),payload,1800000000) for i in range(10000)])
        self.db.commit()
        result=relay.cycle(self.db,self.config,reader=self.rows(),sender=lambda c,p,n:(202,True),now=1800000001)
        self.assertEqual(result["sent"],200)
        self.assertFalse(result["collection_error"])

    def test_unrelated_malformed_inbox_page_never_prevents_delivery(self):
        relay.collect(self.db,self.config,self.rows(self.message()),now=1800000000)
        rows=self.rows(*[self.message(sender="Friend",at="not a date") for _ in range(100)])
        result=relay.cycle(self.db,self.config,reader=rows,sender=lambda c,p,n:(202,True),now=1800000001)
        self.assertEqual(result["sent"],1)
        self.assertFalse(result["collection_error"])

    def test_collection_stops_at_capacity_without_discarding_queued_messages(self):
        relay.bind_queue(self.db,self.config)
        self.db.execute("INSERT INTO metadata VALUES ('start_time','1800000000')")
        self.db.executemany("INSERT INTO messages(message_id,payload,state,created_at) VALUES (?,?,'pending',?)",
                            [("queued-"+str(i),'{}',1800000000) for i in range(9999)])
        self.db.commit()
        with self.assertRaises(RuntimeError):
            relay.collect(self.db,self.config,self.rows(self.message(),self.message(at=1800000002)),now=1800000001)
        self.assertEqual(self.db.execute("SELECT count(*) FROM messages WHERE state='pending'").fetchone()[0],10000)
        self.assertEqual(self.db.execute("SELECT count(*) FROM messages WHERE message_id LIKE 'android-%'").fetchone()[0],1)

    def test_invalid_allowlisted_message_does_not_block_valid_messages(self):
        rows = self.rows(self.message(at="invalid"), self.message())
        self.assertEqual(relay.collect(self.db, self.config, rows, now=1800000000), 1)
        self.assertEqual(dict(self.db.execute("SELECT state,count(*) FROM messages GROUP BY state")), {"dead": 1, "pending": 1})

    def test_config_rejects_insecure_endpoint_and_open_permissions(self):
        file = self.root / "config.json"
        data = {**self.config, "senders": ["MTN"]}
        file.write_text(json.dumps(data)); file.chmod(0o600)
        self.assertEqual(relay.load_config(file)["senders"], {"mtn"})
        file.chmod(0o644)
        with self.assertRaises(ValueError): relay.load_config(file)
        file.chmod(0o600)
        file.write_text(json.dumps({**data, "endpoint": "http://example.invalid/integrations/sms/"+"a"*32}))
        with self.assertRaises(ValueError): relay.load_config(file)

    def test_real_http_request_uses_documented_raw_body_signature(self):
        received = []
        secret = self.config["secret"]
        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                raw = handler.rfile.read(int(handler.headers["Content-Length"]))
                timestamp = handler.headers["X-SMS-Timestamp"]
                expected = hmac.new(bytes.fromhex(secret), timestamp.encode()+b"."+raw, hashlib.sha256).hexdigest()
                received.append((handler.headers["X-SMS-Signature"] == expected, json.loads(raw)))
                handler.send_response(202); handler.end_headers(); handler.wfile.write(b'{"accepted":true}')
            def log_message(self, *args): pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            config = {**self.config, "endpoint": "http://127.0.0.1:"+str(server.server_port)+"/integrations/sms/"+"a"*32}
            message, _ = relay.normalize_message(self.message(body="MTN · UTF-8 confirmation"))
            self.assertEqual(relay.send(config, json.dumps(message, ensure_ascii=False), 1800000000), (202, True))
            self.assertTrue(received[0][0]); self.assertEqual(received[0][1]["body"], message["body"])
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
