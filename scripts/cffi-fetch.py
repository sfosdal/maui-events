# /// script
# requires-python = ">=3.12"
# dependencies = ["curl_cffi>=0.7"]
# ///
"""Fetch pages through a browser's TLS fingerprint, for feeds.mjs.

Ticketera (San Juan's ticketer, 2026-10-14) sits behind a Fastly edge rule
that answers plain Node, curl and any "Mozilla" User-Agent with HTTP 406 or
a "Client Challenge" page, yet serves the same URL in full to a client whose
TLS handshake looks like Chrome's. curl_cffi impersonates that handshake, so
this helper is the transport for the feed kinds that need it; the parsing
stays in feeds.mjs. Run by feeds.mjs through uv (one process per batch):

    uv run scripts/cffi-fetch.py <url> ...

Reads nothing else, writes one JSON object to stdout — url → page text, or
url → {"error": "..."} — and paces the calls half a second apart.
"""
import json
import sys
import time

from curl_cffi import requests

out = {}
session = requests.Session(impersonate="chrome")
for i, url in enumerate(sys.argv[1:]):
    if i:
        time.sleep(0.5)
    try:
        r = session.get(url, timeout=30)
        out[url] = r.text if r.status_code == 200 else {"error": f"HTTP {r.status_code}"}
    except Exception as e:  # noqa: BLE001 — every failure is reported the same way
        out[url] = {"error": str(e)}
json.dump(out, sys.stdout)
