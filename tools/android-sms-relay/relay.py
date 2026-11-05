#!/usr/bin/env python3
"""Forward allowlisted Android inbox messages through Termux:API, with durable retries."""
import argparse
import datetime as dt
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("Configuration must be a private regular file (chmod 600)")


def load_config(path):
    private_file(path)
    config = json.loads(path.read_text())
    url = urllib.parse.urlsplit(config.get("endpoint", ""))
    local = config.get("allow_local_http") is True and url.hostname in ("127.0.0.1", "localhost", "::1")
    if url.scheme != "https" and not (local and url.scheme == "http"):
        raise ValueError("Use an HTTPS receiving endpoint")
    if not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Invalid receiving endpoint")
    if not re.fullmatch(r"/integrations/sms/[A-Za-z0-9_-]{8,128}", url.path):
        raise ValueError("Use the device endpoint displayed by ClassicFin Hub")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", config.get("secret", "")):
        raise ValueError("Device secret must contain 64 hexadecimal characters")
    senders = config.get("senders")
    if not isinstance(senders, list) or not 1 <= len(senders) <= 20 or any(
        not isinstance(s, str) or not 1 <= len(s.strip()) <= 40 for s in senders
    ):
        raise ValueError("Configure an explicit allowlist of SMS senders")
    config["senders"] = {s.strip().casefold() for s in senders}
    seconds = config.get("poll_seconds", 15)
    if type(seconds) is not int or not 5 <= seconds <= 3600:
        raise ValueError("Polling interval must be 5–3600 seconds")
    config["poll_seconds"] = seconds
    return config


def init_config(path):
    if path.exists() or path.is_symlink():
        raise ValueError("Configuration exists; refusing to overwrite the device secret")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = {"endpoint": input("Device HTTPS endpoint: ").strip(),
            "secret": getpass.getpass("Device secret (hidden): ").strip(),
            "senders": [s.strip() for s in input("Allowed SMS sender IDs, comma-separated: ").split(",")],
            "poll_seconds": 15}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(data, file)
    try:
        load_config(path)
    except Exception:
        path.unlink()
        raise
    print("Device configured. Existing inbox messages will be skipped by default.")


def open_queue(path):
    if path.is_symlink():
        raise ValueError("Queue cannot be a symbolic link")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    private_file(path)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY, payload TEXT, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        last_code INTEGER, created_at INTEGER NOT NULL)""")
    db.execute("CREATE INDEX IF NOT EXISTS messages_due ON messages(state,next_attempt,created_at)")
    db.commit()
    return db


def received_at(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        stamp = value / 1000 if value > 100000000000 else value
        result = dt.datetime.fromtimestamp(stamp, dt.timezone.utc)
    elif isinstance(value, str):
        result = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if result.tzinfo is None:
            result = result.astimezone()  # Android's own configured timezone.
        result = result.astimezone(dt.timezone.utc)
    else:
        raise ValueError("SMS receipt timestamp unavailable")
    return result


def normalize_message(row):
    sender = str(row.get("number", row.get("address", row.get("sender", "")))).strip()
    body = row.get("body")
    if not sender or len(sender) > 40 or not isinstance(body, str) or not 1 <= len(body) <= 2000:
        raise ValueError("Unsupported SMS envelope")
    stamp = received_at(row.get("received", row.get("date", row.get("receivedAt"))))
    iso = stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # Some Termux versions omit the native row ID. A content fingerprint remains
    # stable across polling and cannot reveal the original message from logs.
    identity = json.dumps([sender, iso, body], separators=(",", ":"), ensure_ascii=False)
    message_id = "android-" + hashlib.sha256(identity.encode()).hexdigest()
    return {"messageId": message_id, "sender": sender, "receivedAt": iso, "body": body}, stamp.timestamp()


def android_page(offset, limit):
    result = subprocess.run(["termux-sms-list", "-t", "inbox", "-l", str(limit), "-o", str(offset)],
                            capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError("Android SMS access failed; check Termux:API and SMS permission")
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise RuntimeError("Android did not return an SMS inbox list")
    return rows


def collect(db, config, reader=android_page, now=None, import_existing=False):
    now = int(time.time() if now is None else now)
    bind_queue(db, config)
    db.execute("UPDATE messages SET payload=NULL WHERE state='dead' AND created_at<?", (now-7*86400,))
    if db.execute("SELECT count(*) FROM messages WHERE state='pending'").fetchone()[0] >= 10000:
        raise RuntimeError("Pending queue is full; restore connectivity before collecting more messages")
    baseline = db.execute("SELECT value FROM metadata WHERE key='start_time'").fetchone()
    if baseline is None:
        start = 0 if import_existing else now
        db.execute("INSERT INTO metadata VALUES ('start_time',?)", (str(start),))
        db.commit()
    else:
        if import_existing and baseline[0] != "0":
            raise ValueError("Historical import must be chosen on first run, using a separate new queue")
        start = int(baseline[0])
    added = 0
    # Scan across pages after outages instead of silently limiting to the latest
    # inbox page. A bounded cap fails visibly and preserves already queued data.
    for offset in range(0, 50000, 100):
        rows = reader(offset, 100)
        if not rows:
            break
        for row in rows:
            sender = str(row.get("number", row.get("address", row.get("sender", "")))).strip()
            if sender.casefold() not in config["senders"]:
                continue  # Never retain unrelated personal inbox messages.
            try:
                message, stamp = normalize_message(row)
            except (ValueError, OverflowError):
                identity = hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                db.execute("INSERT OR IGNORE INTO messages(message_id,payload,state,last_code,created_at) VALUES (?,NULL,'dead',422,?)", ("invalid-"+identity,now))
                continue
            if stamp < start:
                continue
            inserted = db.execute("""INSERT OR IGNORE INTO messages(message_id,payload,state,created_at)
                SELECT ?,?,?,? WHERE (SELECT count(*) FROM messages WHERE state='pending')<10000""",
                (message["messageId"], json.dumps(message, ensure_ascii=False, separators=(",", ":")), "pending", now)).rowcount
            if not inserted and not db.execute("SELECT 1 FROM messages WHERE message_id=?",(message["messageId"],)).fetchone():
                db.commit()
                raise RuntimeError("Pending queue reached its capacity; already collected messages retained")
            added += inserted
        db.commit()
        if len(rows) < 100:
            break
    else:
        raise RuntimeError("Inbox scan limit reached; queued messages retained, inspect inbox backlog")
    return added


def bind_queue(db, config):
    identity = hashlib.sha256(config['endpoint'].encode()).hexdigest()
    previous = db.execute("SELECT value FROM metadata WHERE key='device_endpoint'").fetchone()
    if previous is not None and previous[0] != identity:
        raise ValueError("Use a separate queue for a different device or workspace")
    db.execute("INSERT OR IGNORE INTO metadata VALUES ('device_endpoint',?)", (identity,))
    db.commit()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None  # Never forward the device signature to another destination.


def send(config, payload, now):
    raw = payload.encode("utf-8")
    stamp = str(now)
    signature = hmac.new(bytes.fromhex(config["secret"]), stamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    request = urllib.request.Request(config["endpoint"], data=raw, method="POST", headers={
        "Content-Type": "application/json", "X-SMS-Timestamp": stamp, "X-SMS-Signature": signature})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            body = response.read(4096)
            try:
                accepted = json.loads(body).get("accepted") is True
            except (ValueError, AttributeError):
                accepted = False
            return response.status, accepted
    except urllib.error.HTTPError as error:
        return error.code, False
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, False


def deliver(db, config, sender=send, now=None, dry_run=False):
    now = int(time.time() if now is None else now)
    bind_queue(db, config)
    rows = db.execute("SELECT message_id,payload,attempts FROM messages WHERE state='pending' AND next_attempt<=? ORDER BY created_at,message_id LIMIT 100", (now,)).fetchall()
    if dry_run:
        return {"pending": len(rows), "sent": 0, "dead": 0, "dry_run": True}
    sent = dead = 0
    for message_id, payload, attempts in rows:
        code, accepted = sender(config, payload, now)
        if code in (200, 202) and accepted:
            # Keep only a dedupe fingerprint after acknowledgment, not SMS text.
            db.execute("UPDATE messages SET state='sent',payload=NULL,last_code=? WHERE message_id=?", (code, message_id))
            sent += 1
        elif code in (400, 409, 413, 422):
            db.execute("UPDATE messages SET state='dead',last_code=?,attempts=attempts+1 WHERE message_id=?", (code, message_id))
            dead += 1
        else:
            delay = 3600 if code in (401, 403) else min(3600, 15 * 2 ** min(attempts, 8))
            db.execute("UPDATE messages SET last_code=?,attempts=attempts+1,next_attempt=? WHERE message_id=?", (code, now + delay, message_id))
        db.commit()
        if code in (401, 403):
            break  # Keep the queue and pause until credentials/access are repaired.
    return {"processed": len(rows), "sent": sent, "dead": dead}


def cycle(db, config, reader=android_page, sender=send, now=None, import_existing=False, dry_run=False):
    # Always attempt the existing queue first. A full queue or malformed inbox
    # page must not prevent delivery of records already durably collected.
    first = deliver(db, config, sender=sender, now=now, dry_run=dry_run)
    collection_error = False
    try:
        collected = collect(db, config, reader=reader, now=now, import_existing=import_existing)
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError):
        collected = 0
        collection_error = True
    second = deliver(db, config, sender=sender, now=now, dry_run=dry_run)
    return {"collected": collected, "sent": first["sent"]+second["sent"], "dead": first["dead"]+second["dead"],
            "collection_error": collection_error, "dry_run": dry_run}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path.home() / ".classicfin-sms/config.json")
    parser.add_argument("--queue", type=Path)
    parser.add_argument("--init", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--import-existing", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if args.init:
        init_config(args.config)
        return
    config = load_config(args.config)
    db = open_queue(args.queue or args.config.with_name("queue.sqlite"))
    try:
        if args.status:
            print(json.dumps(dict(db.execute("SELECT state,count(*) FROM messages GROUP BY state"))))
            return
        while True:
            try:
                result = cycle(db, config, import_existing=args.import_existing, dry_run=args.dry_run)
                print(json.dumps({"event": "sms_relay", **result}), flush=True)
                if result["collection_error"] and args.once:
                    raise RuntimeError("Collection needs attention; existing queue delivery was attempted")
            except (ValueError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError):
                # Do not print provider envelopes, secrets, endpoint URLs or bodies.
                print(json.dumps({"event": "sms_relay", "state": "attention_required"}), flush=True)
                if args.once:
                    raise RuntimeError("Relay needs attention; verify Android permissions, inbox timestamps and configuration") from None
            if args.once or args.dry_run:
                break
            time.sleep(config["poll_seconds"])
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        print("Relay stopped. Check configuration, permissions and queue status; queued messages are retained.", file=sys.stderr)
        sys.exit(1)
