"""Keep the console's labels in step with the reasons the server emits."""

from pathlib import Path
import re

from relayguard.gateway import _ERROR_MESSAGES

STATIC = Path(__file__).resolve().parents[1] / "src" / "relayguard" / "static"


def console_reasons():
    source = (STATIC / "app.js").read_text(encoding="utf-8")
    block = source.split("const reasons = {", 1)[1].split("};", 1)[0]
    return set(re.findall(r"([a-z_]+):", block))


def test_every_emitted_reason_has_a_console_label():
    emitted = set(_ERROR_MESSAGES) | {
        # Success and lifecycle events.
        "forwarded", "credential_created", "credential_revoked", "credential_rotated",
        # Application-level rejections outside _ERROR_MESSAGES.
        "admin_auth_failed", "request_cancelled", "headers_too_large",
        # Demo scenario outcomes.
        "allowed", "unexpected_response",
    }
    labels = console_reasons()
    assert emitted - labels == set(), "Add Korean labels and English catalog entries for these reasons"
    assert labels - emitted == set(), "Remove console labels for reasons the server never emits"


def test_english_catalog_entries_keep_placeholders():
    catalog = (STATIC / "i18n.js").read_text(encoding="utf-8")
    pairs = re.findall(r'^\s*"((?:[^"\\]|\\.)*)": "((?:[^"\\]|\\.)*)",?$', catalog, re.M)
    assert len(pairs) > 400
    for korean, english in pairs:
        assert set(re.findall(r"\{(\w+)\}", korean)) == set(re.findall(r"\{(\w+)\}", english)), korean
        assert korean.count("`") == english.count("`"), korean
