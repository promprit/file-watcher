#!/usr/bin/env python3
"""
FileWatcherMonitoring — one-shot Dataverse provisioning (plug & play).

Creates everything the D365-native file watcher needs in a target environment,
idempotently (safe to re-run; existing pieces are skipped):

  1. Global choices fwm_filestatus, fwm_apistatus, fwm_interfacetype (values fixed —
     must match d365/FileWatcherMonitoring.Dataverse/Schema.cs)
  2. Tables         fwm_interface, fwm_connection, fwm_filestate, fwm_fileobservation,
                    fwm_fileevent, fwm_apimessage, fwm_apievent (+ all columns)
  3. Alternate keys filestate(interfaceid,filepath), fileevent(eventid),
                    apimessage(interfaceid,messageid), apievent(eventid)
  4. Plugin assembly upload (signed FileWatcherMonitoring.Dataverse.dll)
  5. Plugin step    sync PostOperation on Create of fwm_fileobservation
  6. Custom APIs    fwm_CheckMissingSla, fwm_ReportApiMessage, fwm_CheckApiSla

Usage:
  # token via Azure CLI (resource = your environment URL):
  export DATAVERSE_TOKEN=$(az account get-access-token \
      --resource https://yourorg.crm.dynamics.com --query accessToken -o tsv)
  python3 provision.py --url https://yourorg.crm.dynamics.com \
      --dll ../FileWatcherMonitoring.Dataverse/bin/Debug/net462/FileWatcherMonitoring.Dataverse.dll

Requires: Python 3.8+ (stdlib only). The caller needs System Customizer or
System Administrator in the target environment.

After this script: create the flows per docs/superpowers/plans/2026-07-17-flow-runbook.md,
seed fwm_interface / fwm_connection rows, and build the model-driven app in the portal.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

LANG = 1033

# Must match Schema.cs exactly.
STATUS_OPTIONS = [
    ("FILE_DETECTED", 100000000),
    ("FILE_STABLE", 100000001),
    ("FILE_DUPLICATE", 100000002),
    ("FILE_STUCK", 100000003),
    ("FILE_MISSING_BY_SLA", 100000004),
]

# Must match Schema.cs exactly.
API_STATUS_OPTIONS = [
    ("MSG_RECEIVED", 100000000),
    ("MSG_PROCESSED", 100000001),
    ("MSG_DUPLICATE", 100000002),
    ("MSG_FAILED", 100000003),
    ("MSG_TIMEOUT", 100000004),
    ("FEED_MISSING_BY_SLA", 100000005),
]

INTERFACE_TYPE_OPTIONS = [
    ("File", 100000000),
    ("Api", 100000001),
]

ASSEMBLY_NAME = "FileWatcherMonitoring.Dataverse"
PLUGIN_TYPE_OBSERVATION = "FileWatcherMonitoring.Dataverse.FileObservationCreatePlugin"
PLUGIN_TYPE_SWEEP = "FileWatcherMonitoring.Dataverse.CheckMissingSlaPlugin"
PLUGIN_TYPE_API_REPORT = "FileWatcherMonitoring.Dataverse.ReportApiMessagePlugin"
PLUGIN_TYPE_API_SLA = "FileWatcherMonitoring.Dataverse.CheckApiSlaPlugin"
PLUGIN_TYPES = [PLUGIN_TYPE_OBSERVATION, PLUGIN_TYPE_SWEEP, PLUGIN_TYPE_API_REPORT, PLUGIN_TYPE_API_SLA]

# uniquename -> (display, description, plugin type, request params, response props)
# param/prop: (uniquename, display, type[10=String 7=Integer], optional)
CUSTOM_APIS = {
    "fwm_CheckMissingSla": (
        "FWM Check Missing SLA", "Absence-driven missing-file sweep for one interface.",
        PLUGIN_TYPE_SWEEP,
        [("InterfaceId", "Interface Id", 10, False)],
        [("EventCount", "Event Count", 7)],
    ),
    "fwm_ReportApiMessage": (
        "FWM Report API Message", "API integrations self-report Received/Processed/Failed here.",
        PLUGIN_TYPE_API_REPORT,
        [("InterfaceId", "Interface Id", 10, False),
         ("MessageId", "Message Id", 10, False),
         ("Action", "Action (Received|Processed|Failed)", 10, False),
         ("CorrelationId", "Correlation Id", 10, True),
         ("ErrorCode", "Error Code", 10, True)],
        [("Status", "Recorded Status", 10)],
    ),
    "fwm_CheckApiSla": (
        "FWM Check API SLA", "Timeout sweep + feed heartbeat for one API interface.",
        PLUGIN_TYPE_API_SLA,
        [("InterfaceId", "Interface Id", 10, False)],
        [("EventCount", "Event Count", 7)],
    ),
}


class Client:
    def __init__(self, url, token):
        self.base = url.rstrip("/") + "/api/data/v9.2/"
        self.token = token

    def call(self, method, path, body=None, ok404=False):
        req = urllib.request.Request(self.base + path, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("Accept", "application/json")
        req.add_header("OData-MaxVersion", "4.0")
        req.add_header("OData-Version", "4.0")
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with urllib.request.urlopen(req, data) as resp:
                text = resp.read().decode("utf-8")
                entity_id = resp.headers.get("OData-EntityId")
                parsed = json.loads(text) if text else {}
                if entity_id and "@id" not in parsed:
                    parsed["@id"] = entity_id
                return resp.status, parsed
        except urllib.error.HTTPError as e:
            if e.code == 404 and ok404:
                return 404, None
            detail = e.read().decode("utf-8", "replace")
            raise SystemExit(f"FAILED {method} {path}\nHTTP {e.code}\n{detail}")

    def get(self, path, ok404=False):
        return self.call("GET", path, ok404=ok404)

    def post(self, path, body):
        return self.call("POST", path, body)


class DryRunClient:
    """Same interface as Client, no HTTP. Existence checks come back 'not found'
    so every planned create is printed; platform-data lookups (sdkmessages,
    sdkmessagefilters, WhoAmI, GlobalOptionSetDefinitions post-create reads)
    return synthetic rows so the run completes end-to-end."""

    _ZERO = "00000000-0000-0000-0000-000000000000"
    _PLATFORM = ("sdkmessages?", "sdkmessagefilters?", "WhoAmI")
    _SYNTHETIC_ROW = {
        "sdkmessageid": _ZERO,
        "sdkmessagefilterid": _ZERO,
        "MetadataId": _ZERO,
        "UserId": "dry-run",
    }

    def __init__(self):
        self.calls = []
        self.posted_choices = set()

    def call(self, method, path, body=None, ok404=False):
        if method != "GET":
            self.calls.append((method, path))
            if path == "GlobalOptionSetDefinitions" and body:
                self.posted_choices.add(body.get("Name"))
            print(f"    DRY-RUN {method} {path}" + (f"  ({len(json.dumps(body))} bytes)" if body else ""))
        if method == "GET":
            if path.startswith("GlobalOptionSetDefinitions"):
                name = path.split("Name='")[-1].rstrip("')")
                if ok404 and name not in self.posted_choices:
                    return 404, None
                return 200, dict(self._SYNTHETIC_ROW)
            if path.startswith(self._PLATFORM):
                if "$filter" in path:
                    return 200, {"value": [dict(self._SYNTHETIC_ROW)]}
                return 200, dict(self._SYNTHETIC_ROW)
            if "$filter" in path:
                return 200, {"value": []}
            return (404, None) if ok404 else (200, {"value": []})
        return 204, {"@id": f"dryrun({self._ZERO})"}

    def get(self, path, ok404=False):
        return self.call("GET", path, ok404=ok404)

    def post(self, path, body):
        return self.call("POST", path, body)


def label(text):
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.Label",
        "LocalizedLabels": [
            {"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": text, "LanguageCode": LANG}
        ],
    }


def string_attr(schema, display, length, required=False, primary=False):
    attr = {
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        "SchemaName": schema,
        "MaxLength": length,
        "RequiredLevel": {"Value": "ApplicationRequired" if required else "None"},
        "DisplayName": label(display),
    }
    if primary:
        attr["IsPrimaryName"] = True
    return attr


def int_attr(schema, display):
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
        "SchemaName": schema,
        "RequiredLevel": {"Value": "None"},
        "DisplayName": label(display),
        "MinValue": 0,
        "MaxValue": 2147483647,
    }


def bigint_attr(schema, display):
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.BigIntAttributeMetadata",
        "SchemaName": schema,
        "RequiredLevel": {"Value": "None"},
        "DisplayName": label(display),
    }


def bool_attr(schema, display):
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
        "SchemaName": schema,
        "RequiredLevel": {"Value": "None"},
        "DisplayName": label(display),
        "OptionSet": {
            "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
            "TrueOption": {"Value": 1, "Label": label("Yes")},
            "FalseOption": {"Value": 0, "Label": label("No")},
        },
    }


def datetime_attr(schema, display):
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
        "SchemaName": schema,
        "RequiredLevel": {"Value": "None"},
        "DisplayName": label(display),
        "Format": "DateAndTime",
    }


TABLES = [
    {
        "schema": "fwm_interface",
        "display": "FWM Interface",
        "collection": "FWM Interfaces",
        "description": "File watcher interface configuration (what to watch).",
        "primary": string_attr("fwm_interfaceid", "Interface Id", 50, required=True, primary=True),
        "attrs": [
            string_attr("fwm_name", "Interface Name", 200),
            string_attr("fwm_inboundpath", "Inbound Path", 500),
            string_attr("fwm_filepattern", "File Pattern", 200),
            int_attr("fwm_pollintervalseconds", "Poll Interval (s)"),
            int_attr("fwm_stabilitycheckseconds", "Stability Check (s)"),
            bool_attr("fwm_duplicatecheckenabled", "Duplicate Check Enabled"),
            int_attr("fwm_stuckthresholdseconds", "Stuck Threshold (s)"),
            string_attr("fwm_sladeadline", "SLA Deadline (HH:mm UTC)", 20),
            bool_attr("fwm_enabled", "Enabled"),
            int_attr("fwm_processingtimeoutseconds", "Processing Timeout (s, API)"),
        ],
        "picklists": [("fwm_interfacetype", "Interface Type", False, "fwm_interfacetype")],
        "keys": [],
    },
    {
        "schema": "fwm_connection",
        "display": "FWM Connection",
        "collection": "FWM Connections",
        "description": "Reusable source connection metadata (no secrets — credentials live in Power Automate connection references).",
        "primary": string_attr("fwm_connectionref", "Connection Ref", 100, required=True, primary=True),
        "attrs": [
            string_attr("fwm_storagetype", "Storage Type", 100),
            string_attr("fwm_endpoint", "Endpoint", 500),
            bool_attr("fwm_enabled", "Enabled"),
        ],
        "picklists": [],
        "keys": [],
    },
    {
        "schema": "fwm_filestate",
        "display": "FWM File State",
        "collection": "FWM File States",
        "description": "Current file lifecycle state (snapshot: current + previous status, not a history log).",
        "primary": string_attr("fwm_filename", "File Name", 500, primary=True),
        "attrs": [
            string_attr("fwm_interfaceid", "Interface Id", 50, required=True),
            # 50 + 380 chars = 860 bytes combined — inside Dataverse's 900-byte
            # alternate-key index limit (nvarchar counts 2 bytes/char).
            string_attr("fwm_filepath", "File Path", 380, required=True),
            bigint_attr("fwm_filesizebytes", "File Size (bytes)"),
            string_attr("fwm_batchid", "Batch Id", 100),
            datetime_attr("fwm_statuschangedat", "Status Changed At"),
            datetime_attr("fwm_firstdetectedat", "First Detected At"),
            datetime_attr("fwm_lastseenat", "Last Seen At"),
        ],
        "picklists": [
            ("fwm_currentstatus", "Current Status", True, "fwm_filestatus"),
            ("fwm_previousstatus", "Previous Status", False, "fwm_filestatus"),
        ],
        "keys": [("fwm_filestate_pathkey", "Interface + File Path", ["fwm_interfaceid", "fwm_filepath"])],
    },
    {
        "schema": "fwm_fileobservation",
        "display": "FWM File Observation",
        "collection": "FWM File Observations",
        "description": "Normalized observation intake written by the watch flows; the engine plugin fires on create. Transient — purge via bulk-delete job.",
        "primary": string_attr("fwm_filepath", "File Path", 500, required=True, primary=True),
        "attrs": [
            string_attr("fwm_interfaceid", "Interface Id", 50, required=True),
            bigint_attr("fwm_filesizebytes", "File Size (bytes)"),
            datetime_attr("fwm_modifiedat", "Source Modified At"),
            datetime_attr("fwm_observedat", "Observed At"),
        ],
        "picklists": [],
        "keys": [],
    },
    {
        "schema": "fwm_fileevent",
        "display": "FWM File Event",
        "collection": "FWM File Events",
        "description": "Append-only audit trail of lifecycle events (written in the same transaction as the state change).",
        "primary": string_attr("fwm_eventid", "Event Id", 100, required=True, primary=True),
        "attrs": [
            string_attr("fwm_batchid", "Batch Id", 100),
            string_attr("fwm_interfaceid", "Interface Id", 50),
            string_attr("fwm_filepath", "File Path", 500),
            datetime_attr("fwm_occurredat", "Occurred At"),
        ],
        "picklists": [("fwm_eventtype", "Event Type", True, "fwm_filestatus")],
        "keys": [("fwm_fileevent_eventidkey", "Event Id", ["fwm_eventid"])],
    },
    {
        "schema": "fwm_apimessage",
        "display": "FWM API Message",
        "collection": "FWM API Messages",
        "description": "API entry-point message state (self-reported via fwm_ReportApiMessage). Message rows are their own state; __heartbeat__ is the feed-SLA sentinel.",
        "primary": string_attr("fwm_messageid", "Message Id", 100, required=True, primary=True),
        "attrs": [
            string_attr("fwm_interfaceid", "Interface Id", 50, required=True),
            string_attr("fwm_correlationid", "Correlation Id", 100),
            string_attr("fwm_batchid", "Batch Id", 100),
            string_attr("fwm_errorcode", "Error Code", 100),
            datetime_attr("fwm_receivedat", "Received At"),
            datetime_attr("fwm_processedat", "Processed At"),
            datetime_attr("fwm_statuschangedat", "Status Changed At"),
        ],
        "picklists": [
            ("fwm_currentstatus", "Current Status", True, "fwm_apistatus"),
            ("fwm_previousstatus", "Previous Status", False, "fwm_apistatus"),
        ],
        "keys": [("fwm_apimessage_msgkey", "Interface + Message Id", ["fwm_interfaceid", "fwm_messageid"])],
    },
    {
        "schema": "fwm_apievent",
        "display": "FWM API Event",
        "collection": "FWM API Events",
        "description": "Append-only audit trail of API message lifecycle events (written in the same transaction as the message state change).",
        "primary": string_attr("fwm_eventid", "Event Id", 100, required=True, primary=True),
        "attrs": [
            string_attr("fwm_batchid", "Batch Id", 100),
            string_attr("fwm_interfaceid", "Interface Id", 50),
            string_attr("fwm_messageid", "Message Id", 100),
            datetime_attr("fwm_occurredat", "Occurred At"),
        ],
        "picklists": [("fwm_eventtype", "Event Type", True, "fwm_apistatus")],
        "keys": [("fwm_apievent_eventidkey", "Event Id", ["fwm_eventid"])],
    },
]


def ensure_global_choice(client, name, display, options):
    status, body = client.get(f"GlobalOptionSetDefinitions(Name='{name}')", ok404=True)
    if status == 200:
        print(f"  = global choice {name} exists")
        return body["MetadataId"]
    payload = {
        "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
        "Name": name,
        "DisplayName": label(display),
        "IsGlobal": True,
        "OptionSetType": "Picklist",
        "Options": [
            {"Value": value, "Label": label(option)} for option, value in options
        ],
    }
    client.post("GlobalOptionSetDefinitions", payload)
    status, body = client.get(f"GlobalOptionSetDefinitions(Name='{name}')")
    print(f"  + created global choice {name}")
    return body["MetadataId"]


def ensure_table(client, table, choice_ids):
    logical = table["schema"].lower()
    status, _ = client.get(f"EntityDefinitions(LogicalName='{logical}')", ok404=True)
    if status == 404:
        payload = {
            "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
            "SchemaName": table["schema"],
            "DisplayName": label(table["display"]),
            "DisplayCollectionName": label(table["collection"]),
            "Description": label(table["description"]),
            "OwnershipType": "OrganizationOwned",
            "HasNotes": False,
            "HasActivities": False,
            "Attributes": [table["primary"]],
        }
        client.post("EntityDefinitions", payload)
        print(f"  + created table {logical}")
    else:
        print(f"  = table {logical} exists")

    for attr in table["attrs"]:
        ensure_attribute(client, logical, attr["SchemaName"].lower(), attr)

    for schema, display, required, choice_name in table["picklists"]:
        picklist = {
            "@odata.type": "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
            "SchemaName": schema,
            "RequiredLevel": {"Value": "ApplicationRequired" if required else "None"},
            "DisplayName": label(display),
            "GlobalOptionSet@odata.bind": f"/GlobalOptionSetDefinitions({choice_ids[choice_name]})",
        }
        ensure_attribute(client, logical, schema.lower(), picklist)

    for key_schema, key_display, key_attrs in table["keys"]:
        ensure_key(client, logical, key_schema, key_display, key_attrs)


def ensure_attribute(client, logical, attr_logical, payload):
    status, _ = client.get(
        f"EntityDefinitions(LogicalName='{logical}')/Attributes(LogicalName='{attr_logical}')", ok404=True
    )
    if status == 200:
        print(f"    = {logical}.{attr_logical}")
        return
    client.post(f"EntityDefinitions(LogicalName='{logical}')/Attributes", payload)
    print(f"    + {logical}.{attr_logical}")


def ensure_key(client, logical, schema, display, attrs):
    key_logical = schema.lower()
    status, _ = client.get(
        f"EntityDefinitions(LogicalName='{logical}')/Keys(LogicalName='{key_logical}')", ok404=True
    )
    if status == 200:
        print(f"    = key {key_logical}")
        return
    payload = {
        "SchemaName": schema,
        "DisplayName": label(display),
        "KeyAttributes": attrs,
    }
    client.post(f"EntityDefinitions(LogicalName='{logical}')/Keys", payload)
    print(f"    + key {key_logical} on ({', '.join(attrs)}) — index builds async")


def find_single(client, path, what):
    _, body = client.get(path)
    rows = body.get("value", [])
    if len(rows) != 1:
        raise SystemExit(f"Expected exactly 1 {what}, got {len(rows)} — query: {path}")
    return rows[0]


def ensure_plugin(client, dll_path):
    if dll_path:
        with open(dll_path, "rb") as handle:
            content = base64.b64encode(handle.read()).decode("ascii")
    else:  # dry-run without a built DLL
        content = base64.b64encode(b"dry-run-placeholder").decode("ascii")

    _, body = client.get(f"pluginassemblies?$select=pluginassemblyid&$filter=name eq '{ASSEMBLY_NAME}'")
    rows = body.get("value", [])
    if rows:
        assembly_id = rows[0]["pluginassemblyid"]
        client.call("PATCH", f"pluginassemblies({assembly_id})", {"content": content})
        print(f"  = assembly {ASSEMBLY_NAME} exists — content updated")
    else:
        _, created = client.post(
            "pluginassemblies",
            {"name": ASSEMBLY_NAME, "content": content, "isolationmode": 2, "sourcetype": 0},
        )
        assembly_id = created["@id"].split("(")[-1].rstrip(")")
        print(f"  + uploaded assembly {ASSEMBLY_NAME}")

    type_ids = {}
    for type_name in PLUGIN_TYPES:
        _, body = client.get(f"plugintypes?$select=plugintypeid&$filter=typename eq '{type_name}'")
        rows = body.get("value", [])
        if rows:
            type_ids[type_name] = rows[0]["plugintypeid"]
            print(f"  = plugin type {type_name}")
        else:
            _, created = client.post(
                "plugintypes",
                {
                    "pluginassemblyid@odata.bind": f"/pluginassemblies({assembly_id})",
                    "typename": type_name,
                    "name": type_name,
                    "friendlyname": type_name,
                },
            )
            type_ids[type_name] = created["@id"].split("(")[-1].rstrip(")")
            print(f"  + registered plugin type {type_name}")
    return type_ids


def ensure_step(client, plugin_type_id):
    step_name = "FWM: process fwm_fileobservation create"
    _, body = client.get(f"sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid&$filter=name eq '{step_name}'")
    if body.get("value"):
        print(f"  = step '{step_name}'")
        return

    message = find_single(
        client, "sdkmessages?$select=sdkmessageid&$filter=name eq 'Create'", "sdkmessage 'Create'"
    )
    message_filter = find_single(
        client,
        "sdkmessagefilters?$select=sdkmessagefilterid&$filter=primaryobjecttypecode eq 'fwm_fileobservation' "
        f"and _sdkmessageid_value eq {message['sdkmessageid']}",
        "sdkmessagefilter for fwm_fileobservation/Create",
    )
    client.post(
        "sdkmessageprocessingsteps",
        {
            "name": step_name,
            "mode": 0,           # synchronous
            "stage": 40,         # PostOperation (inside transaction)
            "rank": 1,
            "supporteddeployment": 0,
            "plugintypeid@odata.bind": f"/plugintypes({plugin_type_id})",
            "sdkmessageid@odata.bind": f"/sdkmessages({message['sdkmessageid']})",
            "sdkmessagefilterid@odata.bind": f"/sdkmessagefilters({message_filter['sdkmessagefilterid']})",
        },
    )
    print(f"  + registered step '{step_name}' (sync PostOperation)")


def ensure_custom_api(client, unique_name, definition, type_ids):
    display, description, plugin_type, params, responses = definition
    _, body = client.get(f"customapis?$select=customapiid&$filter=uniquename eq '{unique_name}'")
    if body.get("value"):
        print(f"  = Custom API {unique_name}")
        return
    _, created = client.post(
        "customapis",
        {
            "uniquename": unique_name,
            "name": unique_name,
            "displayname": display,
            "description": description,
            "bindingtype": 0,          # global
            "isfunction": False,
            "isprivate": False,
            "allowedcustomprocessingsteptype": 0,
            "plugintypeid@odata.bind": f"/plugintypes({type_ids[plugin_type]})",
        },
    )
    api_id = created["@id"].split("(")[-1].rstrip(")")
    for uniquename, param_display, type_code, optional in params:
        client.post(
            "customapirequestparameters",
            {
                "uniquename": uniquename,
                "name": f"{unique_name}.{uniquename}",
                "displayname": param_display,
                "type": type_code,
                "isoptional": optional,
                "customapiid@odata.bind": f"/customapis({api_id})",
            },
        )
    for uniquename, prop_display, type_code in responses:
        client.post(
            "customapiresponseproperties",
            {
                "uniquename": uniquename,
                "name": f"{unique_name}.{uniquename}",
                "displayname": prop_display,
                "type": type_code,
                "customapiid@odata.bind": f"/customapis({api_id})",
            },
        )
    print(f"  + created Custom API {unique_name} ({len(params)} in / {len(responses)} out)")


def seed_rows(client, seed_path):
    """Seed fwm_connection / fwm_interface rows from a JSON file (see
    seed.example.json). Idempotent: rows are matched on their primary name
    column and skipped if present. Entity set names are the default Dataverse
    pluralization (fwm_connection -> fwm_connections)."""
    with open(seed_path) as handle:
        seed = json.load(handle)

    plans = [
        ("fwm_connections", "fwm_connectionref", seed.get("connections", [])),
        ("fwm_interfaces", "fwm_interfaceid", seed.get("interfaces", [])),
    ]
    for entity_set, name_col, rows in plans:
        for row in rows:
            key = row[name_col]
            _, body = client.get(f"{entity_set}?$select={name_col}&$filter={name_col} eq '{key}'")
            if body.get("value"):
                print(f"  = {entity_set} '{key}'")
                continue
            client.post(entity_set, row)
            print(f"  + seeded {entity_set} '{key}'")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="Environment URL, e.g. https://yourorg.crm.dynamics.com")
    parser.add_argument("--token", default=os.environ.get("DATAVERSE_TOKEN"), help="Bearer token (or set DATAVERSE_TOKEN)")
    parser.add_argument("--dll", help="Path to signed FileWatcherMonitoring.Dataverse.dll (omit with --tables-only)")
    parser.add_argument("--tables-only", action="store_true", help="Provision choice/tables/keys only")
    parser.add_argument("--seed", help="JSON file with sample fwm_connection/fwm_interface rows (see seed.example.json)")
    parser.add_argument("--dry-run", action="store_true", help="Print every planned request; no HTTP, no token needed")
    args = parser.parse_args()

    if args.dry_run:
        client = DryRunClient()
    else:
        if not args.token:
            sys.exit("No token. Set DATAVERSE_TOKEN or pass --token. "
                     "E.g.: az account get-access-token --resource <url> --query accessToken -o tsv")
        if not args.tables_only and not args.dll:
            sys.exit("Pass --dll <path to FileWatcherMonitoring.Dataverse.dll> (or use --tables-only).")
        client = Client(args.url, args.token)

    print("WhoAmI check...")
    _, who = client.get("WhoAmI")
    print(f"  connected as UserId {who.get('UserId')}")

    print("1/4 Global choices")
    choice_ids = {
        "fwm_filestatus": ensure_global_choice(client, "fwm_filestatus", "FWM File Status", STATUS_OPTIONS),
        "fwm_apistatus": ensure_global_choice(client, "fwm_apistatus", "FWM API Status", API_STATUS_OPTIONS),
        "fwm_interfacetype": ensure_global_choice(client, "fwm_interfacetype", "FWM Interface Type", INTERFACE_TYPE_OPTIONS),
    }

    print("2/4 Tables, columns, keys")
    for table in TABLES:
        ensure_table(client, table, choice_ids)

    if args.tables_only:
        if args.seed:
            print("Seeding config rows")
            seed_rows(client, args.seed)
        print("Done (tables only).")
        return

    print("3/4 Plugin assembly, types, step")
    type_ids = ensure_plugin(client, args.dll)
    ensure_step(client, type_ids[PLUGIN_TYPE_OBSERVATION])

    print("4/4 Custom APIs")
    for unique_name, definition in CUSTOM_APIS.items():
        ensure_custom_api(client, unique_name, definition, type_ids)

    if args.seed:
        print("Seeding config rows")
        seed_rows(client, args.seed)

    if args.dry_run:
        print(f"\nDry run complete — {len(client.calls)} write requests planned, none sent.")
        return

    print("""
Provisioning complete. Remaining manual steps (see flow runbook):
  1. Wait ~1 min for alternate-key indexes (system jobs) to finish.
  2. Seed fwm_connection + fwm_interface rows.
  3. Create the watch/sweep/alert flows per docs/superpowers/plans/2026-07-17-flow-runbook.md.
  4. Smoke test: create an fwm_fileobservation row -> expect fwm_filestate FILE_DETECTED + fwm_fileevent row.
  5. Build the model-driven app + security roles in the maker portal.""")


if __name__ == "__main__":
    main()
