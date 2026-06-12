import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(name):
    return (ROOT / name).read_text(encoding="utf-8")


class MemoryExtensionStaticTests(unittest.TestCase):
    def test_manifest_exposes_sidepanel_and_local_bridge(self):
        manifest = json.loads(read_text("manifest.json"))

        self.assertEqual(manifest["side_panel"]["default_path"], "popup.html")
        self.assertIn("clipboardRead", manifest["permissions"])
        self.assertIn("nativeMessaging", manifest["permissions"])
        self.assertIn("http://127.0.0.1/*", manifest["host_permissions"])

    def test_background_native_proxy_uses_backend_pack_contract(self):
        source = read_text("background.js")

        self.assertIn("memory_pack_browser", source)
        self.assertIn("if (response.body !== undefined) return response.body;", source)
        self.assertRegex(source, re.compile(r"callNativeMemory\('memory_pack_browser',\s*body\)"))
        self.assertNotIn("callNativeMemory('memory_pack_browser', { body })", source)
        self.assertIn("storedToken: ''", source)
        self.assertIn("hasStoredToken", source)

    def test_sidepanel_ui_supports_preview_edit_insert_and_config(self):
        popup = read_text("popup.html")
        controller = read_text("popup-memory.js")

        for element_id in [
            "memoryPreviewBtn",
            "memoryInsertBtn",
            "memoryCopyBtn",
            "memoryPackMarkdown",
            "memoryBridgeBaseUrl",
            "memoryAuthMode",
            "memoryNativeHostName",
            "memoryStoredToken",
        ]:
            self.assertIn(f'id="{element_id}"', popup)

        self.assertIn("renderMemoryPreview(res.result)", controller)
        self.assertIn("result?.hits || []", controller)
        self.assertIn("chrome.runtime.sendMessage", controller)
        self.assertIn("PREVIEW_MEMORY_PACK", controller)
        self.assertIn("INSERT_MEMORY_PACK", controller)

    def test_content_script_reads_typed_prompt_and_inserts_without_submit(self):
        source = read_text("content.js")

        self.assertIn("function getMemorySource", source)
        self.assertIn("function insertMemoryPack", source)
        self.assertIn("message?.type === 'GET_MEMORY_SOURCE'", source)
        self.assertIn("message?.type === 'INSERT_MEMORY_PACK'", source)
        self.assertIn("prompt_box", source)
        insert_block = source[
            source.index("message?.type === 'INSERT_MEMORY_PACK'"):
            source.index("message?.type === 'SEND_PROMPT'")
        ]
        self.assertNotIn("clickSend(", insert_block)

    def test_native_host_installer_uses_launcher_and_validated_origins(self):
        batch = read_text("install_native_host.bat")
        installer = read_text("install_native_host.ps1")
        launcher = read_text("run_host.bat")
        example = json.loads(read_text("native_host.example.json"))

        self.assertIn("install_native_host.ps1", batch)
        self.assertIn("run_host.bat", installer)
        self.assertIn("allowed_origins", installer)
        self.assertIn("Test-ExtensionId", installer)
        self.assertIn("NativeMessagingHosts", installer)
        self.assertNotIn('"path": "%SCRIPT_DIR%\\\\native_host.py"', batch)
        self.assertIn("native_host.py", launcher)
        self.assertTrue(example["path"].endswith("run_host.bat"))


if __name__ == "__main__":
    unittest.main()
