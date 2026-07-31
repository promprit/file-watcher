#!/usr/bin/env python3
"""
FileWatcherMonitoring — automated post-provisioning smoke test.

Proves the whole engine path in a real environment without any flows:
observation create -> plugin fires in-transaction -> state + event rows.

  1. Ensures a smoke interface exists (SMOKE-001, 5s stability window).
  2. Creates an fwm_fileobservation row  -> expects fwm_filestate FILE_DETECTED
     + one fwm_fileevent, same batch id.
  3. Waits past the stability window, re-observes the same size
     -> expects FILE_STABLE + second event, SAME batch id.
  4. (--cleanup) deletes the rows it created.

Usage:
  export DATAVERSE_TOKEN=$(az account get-access-token \
      --resource https://yourorg.crm.dynamics.com --query accessToken -o tsv)
  python3 smoke.py --url https://yourorg.crm.dynamics.com [--cleanup]

Exit code 0 = all assertions passed. Stdlib only.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

CHOICE = {  # must match Schema.cs
    "FILE_DETECTED": 100000000,
    "FILE_STABLE": 100000001,
}
INTERFACE_ID = "SMOKE-001"
STABILITY_SECONDS = 5


class Client:
    def __init__(self, url, token):
        self.base = url.rstrip("/") + "/api/data/v9.2/"
        self.token = token

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("Accept", "application/json")
        req.add_header("OData-Version", "4.0")
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with urllib.request.urlopen(req, data) as resp:
                text = resp.read().decode("utf-8")
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            raise SystemExit(f"FAILED {method} {path}\nHTTP {e.code}\n{e.read().decode('utf-8', 'replace')}")

    def rows(self, entity_set, odata_filter):
        return self.call("GET", f"{entity_set}?$filter={urllib.parse.quote(odata_filter)}").get("value", [])


def check(label_text, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label_text}" + (f" — {detail}" if detail and not condition else ""))
    return condition


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", default=os.environ.get("DATAVERSE_TOKEN"))
    parser.add_argument("--cleanup", action="store_true", help="Delete the rows this run created")
    args = parser.parse_args()
    if not args.token:
        sys.exit("No token. Set DATAVERSE_TOKEN or pass --token.")

    client = Client(args.url, args.token)
    ok = True

    print("1. Smoke interface")
    existing = client.rows("fwm_interfaces", f"fwm_interfaceid eq '{INTERFACE_ID}'")
    if existing:
        print(f"  = {INTERFACE_ID} exists")
    else:
        client.call("POST", "fwm_interfaces", {
            "fwm_interfaceid": INTERFACE_ID,
            "fwm_name": "Automated smoke test",
            "fwm_inboundpath": "/smoke/",
            "fwm_filepattern": ".*\\.csv$",
            "fwm_pollintervalseconds": 60,
            "fwm_stabilitycheckseconds": STABILITY_SECONDS,
            "fwm_duplicatecheckenabled": True,
            "fwm_stuckthresholdseconds": 600,
            "fwm_sladeadline": "23:59",
            "fwm_enabled": True,
        })
        print(f"  + created {INTERFACE_ID}")

    file_path = f"/smoke/smoke-{uuid.uuid4().hex[:8]}.csv"
    print(f"2. First observation ({file_path})")
    client.call("POST", "fwm_fileobservations", {
        "fwm_interfaceid": INTERFACE_ID,
        "fwm_filepath": file_path,
        "fwm_filesizebytes": 100,
        "fwm_modifiedat": "2026-01-01T00:00:00Z",
        "fwm_observedat": "2026-01-01T00:00:00Z",
    })

    states = client.rows("fwm_filestates", f"fwm_interfaceid eq '{INTERFACE_ID}' and fwm_filepath eq '{file_path}'")
    ok &= check("state row exists", len(states) == 1, f"got {len(states)}")
    state = states[0] if states else {}
    ok &= check("status = FILE_DETECTED", state.get("fwm_currentstatus") == CHOICE["FILE_DETECTED"],
                f"got {state.get('fwm_currentstatus')}")
    batch_id = state.get("fwm_batchid")
    ok &= check("batch id assigned", bool(batch_id))

    events = client.rows("fwm_fileevents", f"fwm_batchid eq '{batch_id}'") if batch_id else []
    ok &= check("one event, FILE_DETECTED", len(events) == 1
                and events[0].get("fwm_eventtype") == CHOICE["FILE_DETECTED"], f"got {len(events)}")

    print(f"3. Waiting {STABILITY_SECONDS + 2}s, re-observing same size")
    time.sleep(STABILITY_SECONDS + 2)
    client.call("POST", "fwm_fileobservations", {
        "fwm_interfaceid": INTERFACE_ID,
        "fwm_filepath": file_path,
        "fwm_filesizebytes": 100,
        "fwm_modifiedat": "2026-01-01T00:00:00Z",
        "fwm_observedat": "2026-01-01T00:00:10Z",
    })

    states = client.rows("fwm_filestates", f"fwm_interfaceid eq '{INTERFACE_ID}' and fwm_filepath eq '{file_path}'")
    state = states[0] if states else {}
    ok &= check("status = FILE_STABLE", state.get("fwm_currentstatus") == CHOICE["FILE_STABLE"],
                f"got {state.get('fwm_currentstatus')}")
    ok &= check("batch id UNCHANGED", state.get("fwm_batchid") == batch_id)
    events = client.rows("fwm_fileevents", f"fwm_batchid eq '{batch_id}'") if batch_id else []
    ok &= check("two events on the batch", len(events) == 2, f"got {len(events)}")

    if args.cleanup:
        print("4. Cleanup")
        for entity_set, id_attr, rows in (
            ("fwm_filestates", "fwm_filestateid", states),
            ("fwm_fileevents", "fwm_fileeventid", events),
        ):
            for row in rows:
                row_id = row.get(id_attr)
                if row_id:
                    client.call("DELETE", f"{entity_set}({row_id})")
            print(f"  - cleaned {entity_set}")
        for obs in client.rows("fwm_fileobservations", f"fwm_filepath eq '{file_path}'"):
            client.call("DELETE", f"fwm_fileobservations({obs['fwm_fileobservationid']})")
        print("  - cleaned fwm_fileobservations")

    print("\nSMOKE " + ("PASSED — engine path is live in this environment." if ok else "FAILED — see FAIL lines above."))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
