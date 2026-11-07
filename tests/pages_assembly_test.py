"""Exercise the production Pages assembly script with real rsync."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / ".github/scripts/assemble-pages.sh"
FIXED_TIMESTAMP = 1577836800


@unittest.skipUnless(shutil.which("rsync"), "rsync is not installed; skipping Pages assembly tests")
class PagesAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.write("incoming/site-production/index.html", "new-root")
        self.write("incoming/site-production/deployed-version.json", '{"revision":"new"}')
        self.write("incoming/site-production/assets/current.js", "current asset")

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        # Equal metadata reproduces rsync's quick-check collision deterministically.
        os.utime(path, (FIXED_TIMESTAMP, FIXED_TIMESTAMP))

    def stored_site(self):
        self.write("stored-site/index.html", "old-root")
        self.write("stored-site/deployed-version.json", '{"revision":"old"}')
        self.write("stored-site/assets/obsolete.js", "obsolete asset")
        self.write("stored-site/.git/config", "must not publish")
        self.write("stored-site/pr-preview/pr-4/index.html", "keep PR4")
        self.write("stored-site/branch-preview/keep-123/index.html", "keep branch")

    def assemble(self, preview="", remove=False):
        return subprocess.run(
            ["bash", str(SCRIPT)],
            cwd=self.root,
            env={**os.environ, "PREVIEW_PATH": preview, "REMOVE_PREVIEW": str(remove).lower()},
            capture_output=True,
            text=True,
            check=False,
        )

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "site/index.html").read_text(), "new-root")
        self.assertEqual(
            (self.root / "site/deployed-version.json").read_text(), '{"revision":"new"}'
        )
        self.assertTrue((self.root / "site/assets/current.js").is_file())
        self.assertTrue((self.root / "site/.nojekyll").is_file())
        self.assertFalse((self.root / "site/assets/obsolete.js").exists())
        self.assertFalse((self.root / "site/.git").exists())

    def assert_other_previews_preserved(self):
        self.assertEqual((self.root / "site/pr-preview/pr-4/index.html").read_text(), "keep PR4")
        self.assertEqual(
            (self.root / "site/branch-preview/keep-123/index.html").read_text(), "keep branch"
        )

    def test_first_deployment_without_stored_site(self):
        self.assert_success(self.assemble())

    def test_production_replaces_same_size_and_timestamp_files(self):
        self.stored_site()
        self.assert_success(self.assemble())
        self.assert_other_previews_preserved()

    def test_new_pr_preview_preserves_production_and_other_previews(self):
        self.stored_site()
        self.write("incoming/site-preview/index.html", "preview content")
        self.assert_success(self.assemble("pr-preview/pr-7"))
        self.assertEqual(
            (self.root / "site/pr-preview/pr-7/index.html").read_text(), "preview content"
        )
        self.assert_other_previews_preserved()

    def test_revision_marker_updates_when_root_index_is_unchanged(self):
        self.stored_site()
        self.write("stored-site/index.html", "new-root")
        self.assert_success(self.assemble())
        self.assert_other_previews_preserved()

    def test_branch_preview_replaces_same_size_and_timestamp_files(self):
        # Keep production unchanged to isolate the preview's own quick-check collision.
        self.stored_site()
        self.write("stored-site/index.html", "new-root")
        self.write("stored-site/deployed-version.json", '{"revision":"new"}')
        self.write("stored-site/branch-preview/update-123/index.html", "old-preview")
        self.write("stored-site/branch-preview/update-123/obsolete.js", "remove me")
        self.write("incoming/site-preview/index.html", "new-preview")
        self.assert_success(self.assemble("branch-preview/update-123"))
        self.assertEqual(
            (self.root / "site/branch-preview/update-123/index.html").read_text(), "new-preview"
        )
        self.assertFalse((self.root / "site/branch-preview/update-123/obsolete.js").exists())
        self.assert_other_previews_preserved()

    def test_removal_needs_no_preview_artifact(self):
        self.stored_site()
        self.write("stored-site/pr-preview/pr-7/index.html", "remove me")
        self.assert_success(self.assemble("pr-preview/pr-7", remove=True))
        self.assertFalse((self.root / "site/pr-preview/pr-7").exists())
        self.assert_other_previews_preserved()

    def test_invalid_preview_path_fails_without_removing_outside_site(self):
        self.write("protected/index.html", "keep me")
        result = self.assemble("../protected", remove=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "protected/index.html").read_text(), "keep me")


if __name__ == "__main__":
    unittest.main()
