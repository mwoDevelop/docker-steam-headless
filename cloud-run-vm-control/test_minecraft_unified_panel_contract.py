import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class MinecraftUnifiedPanelContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "docs/vm-control/admin.html").read_text(encoding="utf-8")
        cls.javascript = (ROOT / "docs/vm-control/admin.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "docs/vm-control/styles.css").read_text(encoding="utf-8")

    def test_create_and_existing_servers_share_one_card(self):
        self.assertEqual(self.html.count("<h3>Minecraft servers</h3>"), 1)
        self.assertNotIn("<h3>Create Minecraft server</h3>", self.html)
        self.assertNotIn("<h3>Existing Minecraft server</h3>", self.html)
        self.assertIn('id="software-minecraft-create-panel"', self.html)
        self.assertIn('id="software-minecraft-existing-panel"', self.html)
        self.assertIn(".minecraft-server-card", self.styles)

    def test_server_picker_contains_new_mode_and_filters_removed_servers(self):
        renderer = self.javascript.split("function renderSoftware() {", 1)[1].split("\n  function ", 1)[0]
        self.assertIn("+ Create new server", renderer)
        self.assertIn('!== "removed"', renderer)
        self.assertIn('selectedMinecraftServer === "__new__"', renderer)
        self.assertIn("softwareMinecraftCreatePanel.hidden", renderer)
        self.assertIn("softwareMinecraftExistingPanel.hidden", renderer)

    def test_selection_follows_create_remove_and_endpoint_changes(self):
        self.assertIn("state.softwareMinecraftSelection = minecraftServerId.trim().toLowerCase();", self.javascript)
        self.assertIn('command === "remove-minecraft"', self.javascript)
        self.assertIn('state.softwareMinecraftSelection = "";', self.javascript)
        self.assertIn("admin.js?v=unified-minecraft-panel-20260827", self.html)


if __name__ == "__main__":
    unittest.main()
