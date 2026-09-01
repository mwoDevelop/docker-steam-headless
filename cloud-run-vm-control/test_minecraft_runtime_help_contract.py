from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class MinecraftRuntimeHelpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "docs" / "vm-control" / "admin.html").read_text(encoding="utf-8")
        cls.javascript = (ROOT / "docs" / "vm-control" / "runtime-help.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "docs" / "vm-control" / "runtime-help.css").read_text(encoding="utf-8")

    def test_runtime_field_has_accessible_contextual_help(self):
        self.assertIn('id="minecraft-runtime-info"', self.html)
        self.assertIn('aria-haspopup="dialog"', self.html)
        self.assertIn('id="minecraft-runtime-info-dialog"', self.html)
        self.assertIn('aria-labelledby="minecraft-runtime-info-title"', self.html)

    def test_all_supported_runtimes_have_help_content(self):
        for runtime in ("paper", "purpur", "fabric", "forge", "neoforge"):
            self.assertIn(f"    {runtime}: {{", self.javascript)
        for section in ("Extensions", "Client compatibility", "Choose this runtime when", "Compatibility and migration"):
            self.assertIn(section, self.javascript)

    def test_dialog_uses_current_runtime_and_restores_focus(self):
        self.assertIn("RUNTIME_HELP[select.value]", self.javascript)
        self.assertIn("dialog.showModal()", self.javascript)
        self.assertIn('dialog.addEventListener("close", () => openButton.focus())', self.javascript)

    def test_help_assets_are_cache_busted_and_responsive(self):
        self.assertIn('./runtime-help.css?v=20260901', self.html)
        self.assertIn('./runtime-help.js?v=20260901', self.html)
        self.assertIn("@media (max-width: 680px)", self.styles)


if __name__ == "__main__":
    unittest.main()
