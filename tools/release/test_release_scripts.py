"""Mote 发布脚本 shell 层测试。

覆盖：tools/release/publish_macos.sh / tools/release/publish_windows.sh。
全部用 SKIP_UPLOAD=true 走 dry-run，不碰真实 OSS 凭据、签名、Sparkle sign_update。
拒绝路径传坏参数，期望脚本以非 0 退出码拒绝并 stderr 含关键字。

运行前保证：python3（系统自带）、VERSION.txt 非空。
不需要 Sparkle sign_update、不需要 oss2 venv、不需要 Developer ID 证书。

用法：
  python3 tools/release/test_release_scripts.py -v
"""

from __future__ import annotations

import base64
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RELEASE = REPO / "tools" / "release"
VERSION = (REPO / "VERSION.txt").read_text().strip()
# 测试用 Ed25519 种子（RFC 8032 固定向量，只用于"文件存在性"检查）
TEST_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
TEST_SEED_B64 = base64.b64encode(bytes.fromhex(TEST_SEED_HEX)).decode()
IS_DARWIN = sys.platform == "darwin"


# --------------------------------------------------------------------------- Runner

class Runner:
    """在隔离 HOME 下运行 mote 发布脚本。"""

    def __init__(self):
        self.home = Path(tempfile.mkdtemp(prefix="mote-home-"))
        self.env = {**os.environ, "HOME": str(self.home)}
        # mote 的配置目录
        self.cfg = self.home / ".config" / "mote-updates"
        self.cfg.mkdir(parents=True)
        # 生成必须存在的 seed 文件（脚本只验 -f，不验内容）
        self._write(self.cfg / "ed25519_seed.b64", TEST_SEED_B64)
        self._write(self.cfg / "sparkle_ed25519_seed.b64", TEST_SEED_B64)
        # publish_windows.sh 还需要 OSS env 文件存在（SKIP_UPLOAD 时也会检查）
        self._write(self.home / ".config" / "xiaotu-updates" / ".env",
                    "OSS_ACCESS_KEY_ID=dummy\nOSS_ACCESS_KEY_SECRET=dummy\nOSS_BUCKET=xiaotu-update\nOSS_REGION=cn-hangzhou\n")

    def _write(self, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def run(self, script: str, args: list[str] | None = None, *,
            expect_code: int = 0, expect_stderr_contains: str | None = None,
            env_override: dict[str, str] | None = None,
            skip_upload: bool = True) -> subprocess.CompletedProcess[str]:
        cmd = [script] + (args or [])
        env = {**self.env, **(env_override or {})}
        if skip_upload:
            env.setdefault("SKIP_UPLOAD", "true")
        result = subprocess.run(
            cmd, capture_output=True, text=True, env=env,
            cwd=str(REPO), timeout=30,
        )
        got = result.returncode
        if got != expect_code:
            detail = f"exit {got}, want {expect_code}\n"
            if result.stderr:
                detail += f"  stderr: {result.stderr[-600:]}\n"
            if result.stdout:
                detail += f"  stdout: {result.stdout[-300:]}"
            raise AssertionError(detail)
        if expect_stderr_contains and expect_stderr_contains not in result.stderr:
            raise AssertionError(
                f"stderr 不含 '{expect_stderr_contains}': {result.stderr[-400:]}")
        return result


# --------------------------------------------------------------------------- publish_macos.sh

@unittest.skipUnless(IS_DARWIN, "发布 shell 脚本测试仅在 macOS 运行")
class TestPublishMacos(unittest.TestCase):
    """mote publish_macos.sh：拒绝路径覆盖。

    注意：合法路径需要真实 DMG + 真实 Sparkle sign_update（二进制），
    本测试只跑拒绝路径，不测完整 dry-run。
    """

    @classmethod
    def setUpClass(cls):
        cls.r = Runner()
        cls.script = str(RELEASE / "publish_macos.sh")

    def test_dmg_path_must_exist(self):
        """DMG_PATH 默认 dist/Mote-macOS-native-$VERSION.dmg，不存在就拒。"""
        missing = str(Path(tempfile.mkdtemp()) / "nothing.dmg")
        self.r.run(self.script, env_override={"DMG_PATH": missing},
                   expect_code=1, expect_stderr_contains="DMG 不存在")

    def test_sign_key_must_exist(self):
        """v2 清单签名种子文件必须存在。"""
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "SIGN_KEY": str(Path(tempfile.mkdtemp()) / "missing.b64"),
        }, expect_code=1, expect_stderr_contains="更新签名私钥不存在")

    def test_sign_update_must_be_found(self):
        """2026-11-20 起 Sparkle appcast 与 v2 清单共用 SIGN_KEY，
        SPARKLE_KEY 不再单独校验；缺失的是 Sparkle 的 sign_update 工具。"""
        home = Path(tempfile.mkdtemp())
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "HOME": str(home),
            "SIGN_KEY": str(self.r.cfg / "ed25519_seed.b64"),
            "SPARKLE_BIN": str(home / "no-sparkle"),
        }, expect_code=1, expect_stderr_contains="未找到 Sparkle 的 sign_update")

    def test_channel_must_be_stable_or_beta(self):
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "CHANNEL": "nightly",
        }, expect_code=2, expect_stderr_contains="必须是 stable/beta")

    def test_notes_url_must_be_absolute_http_or_https(self):
        """相对路径会变成死链。"""
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "NOTES_URL": "/mote/release-notes.html",
        }, expect_code=2, expect_stderr_contains="绝对 http(s)")

    def test_rollout_percent_must_be_1_to_100(self):
        """灰度比例越界或非数字直接拒绝，避免清单写出非法值。"""
        for bad in ("0", "101", "abc"):
            self.r.run(self.script, env_override={
                "DMG_PATH": self._fake_dmg(),
                "ROLLOUT_PERCENT": bad,
            }, expect_code=2, expect_stderr_contains="ROLLOUT_PERCENT")

    def test_mandatory_requires_valid_reason(self):
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "MANDATORY": "1",
        }, expect_code=2, expect_stderr_contains="MANDATORY_REASON")
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "MANDATORY": "1",
            "MANDATORY_REASON": "BECAUSE",
        }, expect_code=2, expect_stderr_contains="MANDATORY_REASON")

    def test_mandatory_deadline_must_be_iso_utc(self):
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "MANDATORY": "1",
            "MANDATORY_REASON": "SECURITY",
            "MANDATORY_DEADLINE": "2026-12-01",
        }, expect_code=2, expect_stderr_contains="ISO 8601 UTC")

    def test_mandatory_fields_only_with_mandatory(self):
        self.r.run(self.script, env_override={
            "DMG_PATH": self._fake_dmg(),
            "MANDATORY_REASON": "SECURITY",
        }, expect_code=2, expect_stderr_contains="只在 MANDATORY=1")

    # ---- helpers ----

    def _fake_dmg(self) -> str:
        """伪造 DMG 文件（仅用于存在性检查）。"""
        fake = Path(tempfile.mkstemp(suffix=".dmg")[1])
        fake.write_bytes(b"fake-dmg")
        return str(fake)


# --------------------------------------------------------------------------- publish_windows.sh

@unittest.skipUnless(IS_DARWIN, "发布 shell 脚本测试仅在 macOS 运行")
class TestPublishWindows(unittest.TestCase):
    """mote publish_windows.sh：拒绝路径覆盖。"""

    @classmethod
    def setUpClass(cls):
        cls.r = Runner()
        cls.script = str(RELEASE / "publish_windows.sh")

    def test_build_must_be_numeric(self):
        """tag 序号从 1 起：1~3 位构建号不得被旧 4 位门槛拒绝。"""
        result = subprocess.run(
            [self.script], capture_output=True, text=True,
            env={**self.r.env, "BUILD": "12", "SKIP_UPLOAD": "true"},
            cwd=str(REPO), timeout=30,
        )
        self.assertNotIn("用户显式传的 BUILD 非法", result.stderr)
        self.r.run(self.script, env_override={"BUILD": "2026abcdef"},
                   expect_code=1, expect_stderr_contains="用户显式传的 BUILD 非法")

    def test_channel_must_be_stable_or_beta(self):
        self.r.run(self.script, env_override={
            "BUILD": "202611190001",
            "CHANNEL": "nightly",
        }, expect_code=2, expect_stderr_contains="必须是 stable/beta")

    def test_notes_url_must_be_absolute_http_or_https(self):
        self.r.run(self.script, env_override={
            "BUILD": "202611190001",
            "NOTES_URL": "relative/path.html",
        }, expect_code=2, expect_stderr_contains="绝对 http(s)")

    def test_sign_key_must_exist(self):
        self.r.run(self.script, env_override={
            "BUILD": "202611190001",
            "SIGN_KEY": str(Path(tempfile.mkdtemp()) / "missing.b64"),
        }, expect_code=1, expect_stderr_contains="v2 清单签名种子不存在")

    def test_rollout_percent_must_be_1_to_100(self):
        for bad in ("0", "101", "abc"):
            self.r.run(self.script, env_override={
                "BUILD": "202611190001",
                "ROLLOUT_PERCENT": bad,
            }, expect_code=2, expect_stderr_contains="ROLLOUT_PERCENT")

    def test_mandatory_requires_valid_reason(self):
        self.r.run(self.script, env_override={
            "BUILD": "202611190001",
            "MANDATORY": "1",
        }, expect_code=2, expect_stderr_contains="MANDATORY_REASON")


# --------------------------------------------------------------------------- main

def main() -> int:
    print(f"\n=== mote manifest_v2 selftest ===")
    r1 = subprocess.run(
        [sys.executable, str(RELEASE / "manifest_v2.py"), "selftest"],
        check=False,
    )
    print(f"\n=== mote guard selftest ===")
    r2 = subprocess.run(
        [sys.executable, str(RELEASE / "guard.py"), "selftest"],
        check=False,
    )
    print(f"\n=== mote release_scripts unittest ===")
    unittest.main(argv=["", "-v"], exit=False)
    ok = (r1.returncode == 0 and r2.returncode == 0)
    codes = f"manifest_v2={r1.returncode}, guard={r2.returncode}"
    print(f"\n=== 汇总 exit codes: {codes} ===")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
