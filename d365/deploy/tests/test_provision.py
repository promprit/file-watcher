"""Drift guards for the deploy tooling. Run: python3 -m unittest discover d365/deploy/tests

Cross-checks provision.py's table/choice definitions against the C# Schema.cs
(the single source of truth the plugin compiles against), validates alternate-key
index budgets, and executes a full --dry-run.
"""
import json
import os
import re
import subprocess
import sys
import unittest

DEPLOY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_CS = os.path.join(DEPLOY_DIR, "..", "FileWatcherMonitoring.Dataverse", "Schema.cs")

sys.path.insert(0, DEPLOY_DIR)
import provision  # noqa: E402


def schema_cs_text():
    with open(SCHEMA_CS) as handle:
        return handle.read()


def table_columns(table):
    """All logical column names provision.py creates for a TABLES entry."""
    cols = {table["primary"]["SchemaName"].lower()}
    cols.update(a["SchemaName"].lower() for a in table["attrs"])
    cols.update(schema.lower() for schema, _, _, _ in table["picklists"])
    return cols


class ChoiceValuesMatchSchemaCs(unittest.TestCase):
    def test_file_status_choice_values_match(self):
        text = schema_cs_text()
        cs_pairs = dict(re.findall(r"FileStatus\.(FILE_[A-Z_]+),\s*(\d{9})", text))
        self.assertEqual(len(cs_pairs), 5, "Schema.cs should map 5 file statuses")
        for name, value in provision.STATUS_OPTIONS:
            self.assertEqual(int(cs_pairs[name]), value,
                             f"choice value drift for {name}: Schema.cs={cs_pairs[name]} provision.py={value}")

    def test_api_status_choice_values_match(self):
        text = schema_cs_text()
        cs_pairs = dict(re.findall(r"ApiStatus\.((?:MSG|FEED)_[A-Z_]+),\s*(\d{9})", text))
        self.assertEqual(len(cs_pairs), 6, "Schema.cs should map 6 API statuses")
        for name, value in provision.API_STATUS_OPTIONS:
            self.assertEqual(int(cs_pairs[name]), value,
                             f"choice value drift for {name}: Schema.cs={cs_pairs[name]} provision.py={value}")

    def test_interface_type_choice_values_match(self):
        text = schema_cs_text()
        self.assertIn("InterfaceTypeFile = 100000000", text)
        self.assertIn("InterfaceTypeApi = 100000001", text)
        self.assertEqual(dict(provision.INTERFACE_TYPE_OPTIONS),
                         {"File": 100000000, "Api": 100000001})


class ColumnsMatchSchemaCs(unittest.TestCase):
    CS_CLASS_TO_TABLE = {
        "FileState": "fwm_filestate",
        "FileEventTable": "fwm_fileevent",
        "FileObservationTable": "fwm_fileobservation",
        "InterfaceTable": "fwm_interface",
        "ApiMessageTable": "fwm_apimessage",
        "ApiEventTable": "fwm_apievent",
    }

    def test_every_schema_cs_column_is_provisioned(self):
        text = schema_cs_text()
        tables_by_logical = {t["schema"].lower(): t for t in provision.TABLES}
        for cs_class, logical in self.CS_CLASS_TO_TABLE.items():
            block = re.search(
                rf"class {cs_class}\b(.*?)\n        \}}", text, re.S).group(1)
            cs_columns = set(re.findall(r'= "(fwm_[a-z]+)"', block)) - {logical}
            provisioned = table_columns(tables_by_logical[logical])
            missing = cs_columns - provisioned
            self.assertFalse(
                missing,
                f"{logical}: Schema.cs references columns provision.py never creates: {sorted(missing)}")


class AlternateKeyBudget(unittest.TestCase):
    LIMIT_BYTES = 900  # Dataverse alternate-key index limit; nvarchar = 2 bytes/char

    def test_key_columns_fit_index_budget(self):
        for table in provision.TABLES:
            lengths = {}
            lengths[table["primary"]["SchemaName"].lower()] = table["primary"]["MaxLength"]
            for attr in table["attrs"]:
                if "MaxLength" in attr:
                    lengths[attr["SchemaName"].lower()] = attr["MaxLength"]
            for _, _, key_attrs in table["keys"]:
                total = sum(lengths[a] * 2 for a in key_attrs)
                self.assertLessEqual(
                    total, self.LIMIT_BYTES,
                    f"{table['schema']} key {key_attrs}: {total} bytes exceeds {self.LIMIT_BYTES}")

    def test_expected_keys_exist(self):
        keys = {t["schema"]: [k[2] for k in t["keys"]] for t in provision.TABLES}
        self.assertIn(["fwm_interfaceid", "fwm_filepath"], keys["fwm_filestate"])
        self.assertIn(["fwm_eventid"], keys["fwm_fileevent"])
        self.assertIn(["fwm_interfaceid", "fwm_messageid"], keys["fwm_apimessage"])
        self.assertIn(["fwm_eventid"], keys["fwm_apievent"])


class SeedFileShape(unittest.TestCase):
    def test_seed_example_rows_use_provisioned_columns(self):
        with open(os.path.join(DEPLOY_DIR, "seed.example.json")) as handle:
            seed = json.load(handle)
        tables_by_logical = {t["schema"].lower(): t for t in provision.TABLES}
        plans = [("fwm_connection", seed["connections"]), ("fwm_interface", seed["interfaces"])]
        for logical, rows in plans:
            provisioned = table_columns(tables_by_logical[logical])
            self.assertTrue(rows, f"seed file has no {logical} rows")
            for row in rows:
                unknown = set(row) - provisioned
                self.assertFalse(unknown, f"seed row for {logical} uses unknown columns: {sorted(unknown)}")


class DryRunExecutes(unittest.TestCase):
    def test_full_dry_run_exits_zero(self):
        result = subprocess.run(
            [sys.executable, os.path.join(DEPLOY_DIR, "provision.py"),
             "--url", "https://dry.example.com", "--dry-run",
             "--seed", os.path.join(DEPLOY_DIR, "seed.example.json")],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Dry run complete", result.stdout)
        self.assertIn("fwm_filestate_pathkey", result.stdout.lower() + result.stdout)


if __name__ == "__main__":
    unittest.main()
