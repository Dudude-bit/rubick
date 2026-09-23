"""Which platforms a pull request builds: python3 -m unittest scripts/build_matrix_test.py"""

import importlib.util
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("build_matrix", ROOT / "scripts/build-matrix.py")
build_matrix = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_matrix)

EVERYTHING = list(build_matrix.PLATFORMS)


def pull_request(changed=(), labels=(), added=""):
    return build_matrix.plan("pull_request", list(labels), "", list(changed), {}, added)[0]


class Plan(unittest.TestCase):
    def test_a_new_toolchain_builds_every_platform(self):
        """Would merge a rustc that breaks macOS having built Linux only."""
        self.assertEqual(pull_request(["rust-toolchain.toml"]), EVERYTHING)
        self.assertEqual(pull_request(["src-tauri/tauri.macos.conf.json"]), EVERYTHING)
        self.assertEqual(pull_request(["src-tauri/src/lib.rs"]), ["linux-x64"])

    def test_adding_build_all_builds_every_platform(self):
        """Would leave the label doing nothing until the next push."""
        self.assertEqual(pull_request(labels=["build-all"], added="build-all"), EVERYTHING)

    def test_adding_any_other_label_builds_nothing(self):
        """Would restart every build in flight whenever a PR was labelled."""
        self.assertEqual(pull_request(["Cargo.lock"], ["deps"], added="deps"), [])

    def test_the_workflow_hears_a_label_being_added(self):
        """Would plan on a label only at the next push, whatever the script does."""
        workflow = (ROOT / ".github/workflows/build.yml").read_text()
        pull = workflow.split("  pull_request:", 1)[1].split("\n\n", 1)[0]
        types = re.search(r"types: \[([^\]]*)\]", pull)
        self.assertIsNotNone(types, pull)
        self.assertIn("labeled", [t.strip() for t in types.group(1).split(",")])
        self.assertIn("ADDED_LABEL:", workflow)


if __name__ == "__main__":
    unittest.main()
