import configparser
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "gcp-vm/power-action.sh"
LEGACY = ROOT / "gcp-additional/install-chrome.sh"


class ChromeDefaultBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = subprocess.check_output(
            ["bash", str(AGENT), "render-chrome-default-browser"], text=True
        )
        cls.legacy_script = subprocess.check_output(
            ["bash", str(LEGACY), "--print-browser-helper"], text=True
        )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.user_home = Path(self.temp.name)
        self.env = dict(os.environ, HOME=str(self.user_home))
        for name in ("XDG_CONFIG_HOME", "XDG_DATA_HOME"):
            self.env.pop(name, None)

    def install_chrome_stub(self):
        entry = self.user_home / ".local/share/flatpak/exports/share/applications/com.google.Chrome.desktop"
        entry.parent.mkdir(parents=True)
        entry.write_text("[Desktop Entry]\nName=Chrome\n")

    def run_helper(self, script=None):
        return subprocess.run(["bash"], input=script or self.script, text=True,
                              env=self.env, check=True, capture_output=True)

    def read_ini(self, relative):
        config = configparser.ConfigParser(interpolation=None)
        config.optionxform = str
        config.read(self.user_home / relative)
        return config

    def test_missing_chrome_does_not_change_existing_preferences(self):
        path = self.user_home / ".config/mimeapps.list"
        path.parent.mkdir()
        content = "[Default Applications]\nx-scheme-handler/https=firefox.desktop\n"
        path.write_text(content)
        self.run_helper()
        self.assertEqual(path.read_text(), content)
        self.assertFalse((self.user_home / ".config/xfce4/helpers.rc").exists())

    def test_repairs_generic_and_xfce_defaults_preserving_other_settings(self):
        self.install_chrome_stub()
        for name in ("mimeapps.list", "xfce-mimeapps.list"):
            path = self.user_home / ".config" / name
            path.parent.mkdir(exist_ok=True)
            path.write_text("[Default Applications]\ntext/plain=editor.desktop\n"
                            "x-scheme-handler/https=xfce4-web-browser.desktop\n")
        helpers = self.user_home / ".config/xfce4/helpers.rc"
        helpers.parent.mkdir()
        helpers.write_text("[Helpers]\nWebBrowser=custom-WebBrowser\nTerminalEmulator=xterm\n")
        self.run_helper()
        for name in ("mimeapps.list", "xfce-mimeapps.list"):
            config = self.read_ini(".config/" + name)
            for mime in ("x-scheme-handler/http", "x-scheme-handler/https",
                         "text/html", "application/xhtml+xml"):
                self.assertEqual(config["Default Applications"][mime], "com.google.Chrome.desktop")
            self.assertEqual(config["Default Applications"]["text/plain"], "editor.desktop")
        config = self.read_ini(".config/xfce4/helpers.rc")
        self.assertEqual(config["Helpers"]["WebBrowser"], "com.google.Chrome")
        self.assertEqual(config["Helpers"]["TerminalEmulator"], "xterm")
        launcher = self.read_ini(".local/share/xfce4/helpers/com.google.Chrome.desktop")
        self.assertIn('"%s"', launcher["Desktop Entry"]["X-XFCE-CommandsWithParameter"])

    def test_repeated_run_and_image_reset_restore_chrome(self):
        self.install_chrome_stub()
        self.run_helper()
        original = (self.user_home / ".config/mimeapps.list").read_text()
        self.run_helper()
        self.assertEqual((self.user_home / ".config/mimeapps.list").read_text(), original)
        (self.user_home / ".config/xfce-mimeapps.list").write_text(
            "[Default Applications]\nx-scheme-handler/https=firefox.desktop\n"
        )
        (self.user_home / ".config/xfce4/helpers.rc").write_text(
            "[Helpers]\nWebBrowser=custom-WebBrowser\n"
        )
        self.run_helper()
        self.assertEqual(self.read_ini(".config/xfce-mimeapps.list")
                         ["Default Applications"]["x-scheme-handler/https"], "com.google.Chrome.desktop")
        self.assertEqual(self.read_ini(".config/xfce4/helpers.rc")
                         ["Helpers"]["WebBrowser"], "com.google.Chrome")

    def test_legacy_executes_the_same_browser_configuration(self):
        self.assertEqual(self.script, self.legacy_script)
        self.install_chrome_stub()
        self.run_helper(self.legacy_script)
        self.assertEqual(self.read_ini(".config/xfce4/helpers.rc")
                         ["Helpers"]["WebBrowser"], "com.google.Chrome")

    def test_host_preparation_persists_bind_mounts_before_container_creation(self):
        source = AGENT.read_text()
        prepare = source.split("prepare_desktop_integration() {", 1)[1].split("\n}\n", 1)[0]
        renderer = "render_chrome_default_browser() { cat <<'PAYLOAD'\n" + self.script + "PAYLOAD\n}\n"
        shell = renderer + "prepare_desktop_integration() {" + prepare + "\n}\n"
        shell += 'COMPOSE_DIR="$TEST_COMPOSE_DIR"\nprepare_desktop_integration\n'
        subprocess.run(["bash", "-e"], input=shell, text=True,
                       env=dict(self.env, TEST_COMPOSE_DIR=str(self.user_home)), check=True)
        override = (self.user_home / "docker-compose.desktop-integration.override.yml").read_text()
        for target in ("/etc/X11/xorg.conf.d/99-sunshine-keyboard.conf",
                       "/usr/local/bin/vm-chrome-default",
                       "/etc/xdg/autostart/vm-chrome-default.desktop"):
            self.assertIn(target + ":ro", override)
        rule = (self.user_home / "desktop-integration/99-sunshine-keyboard.conf").read_text()
        self.assertIn('MatchProduct "Keyboard passthrough"', rule)
        self.assertIn('Driver "evdev"', rule)
        self.assertEqual((self.user_home / "desktop-integration/vm-chrome-default").read_text(), self.script)


if __name__ == "__main__":
    unittest.main()
