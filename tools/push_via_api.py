#!/usr/bin/env python3
"""
通过 GitHub API 提交代码，可选同时创建 Release。

为什么需要这个脚本
------------------
某些网络环境下 `github.com:443` 被阻断，`git push` 会失败：

    fatal: unable to access 'https://github.com/...':
    Recv failure: Connection was reset

但 `api.github.com` 和 `uploads.github.com` 通常是通的，
所以用 Git Data API 手工建 commit，用 `gh release` 上传资产。

用法
----
    python tools/push_via_api.py                     # 只提交源码
    python tools/push_via_api.py --release           # 提交源码 + 建 Release
    python tools/push_via_api.py --only-release      # 只建 Release（不提交）
    python tools/push_via_api.py --release --tag v1.5.3
    python tools/push_via_api.py --release --notes-file .notes.md
    python tools/push_via_api.py --release --notes "本次更新说明"

版本号默认从 config/app.config.js 读，安装包默认找
packages/cheering-mcserver-status-<version>.zip
"""

import argparse
import base64
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = "Cheering571"
REPO = "sunpanel-MCServer-Status"
BRANCH = "main"

FILES = [
    "README.md",
    "app.json",
    "config/app.config.js",
    "config/components.config.js",
    "locales/zh-CN.js",
    "locales/en-US.js",
    "package.json",
    "src/api/bridge.js",
    "src/components/card.js",
    "src/components/config.js",
    "tools/push_via_api.py",
]

MESSAGE = """chore: 推送到 MCServer-Status"""


# ------------------------------------------------------------------ 工具
def gh(*args, input_data=None):
    """调用 gh CLI，返回解析后的 JSON（无输出时返回 None）"""
    cmd = ["gh"] + list(args)
    if input_data is not None:
        cmd += ["--input", "-"]
        p = subprocess.run(cmd, input=input_data.encode("utf-8"), capture_output=True)
    else:
        p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(
            f"gh {' '.join(args)} 失败:\n{p.stderr.decode('utf-8', 'replace')}"
        )
    out = p.stdout.decode("utf-8", "replace").strip()
    return json.loads(out) if out else None


def read_version():
    """从 app.config.js 里读 version"""
    p = os.path.join(ROOT, "config", "app.config.js")
    with io.open(p, "r", encoding="utf-8") as fp:
        m = re.search(r"version:\s*'([^']+)'", fp.read())
    return m.group(1) if m else "0.0.0"


def read_micro_app_id():
    p = os.path.join(ROOT, "config", "app.config.js")
    with io.open(p, "r", encoding="utf-8") as fp:
        m = re.search(r"microAppId:\s*'([^']+)'", fp.read())
    return m.group(1) if m else ""


# ------------------------------------------------------------------ 提交
def push_code():
    ref = gh("api", f"repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
    commit_sha = ref["object"]["sha"]
    commit = gh("api", f"repos/{OWNER}/{REPO}/git/commits/{commit_sha}")
    base_tree = commit["tree"]["sha"]
    print(f"base commit : {commit_sha}")
    print(f"base tree   : {base_tree}")
    print()

    tree_items = []
    for rel in FILES:
        full = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.exists(full):
            print(f"  跳过(缺失): {rel}")
            continue
        with open(full, "rb") as fp:
            b64 = base64.b64encode(fp.read()).decode("ascii")
        blob = gh("api", "-X", "POST", f"repos/{OWNER}/{REPO}/git/blobs",
                  input_data=json.dumps({"content": b64, "encoding": "base64"}))
        tree_items.append({"path": rel, "mode": "100644", "type": "blob",
                           "sha": blob["sha"]})
        print(f"  blob {rel:<34} {blob['sha'][:8]}")

    if not tree_items:
        print("没有可提交的文件")
        return None

    new_tree = gh("api", "-X", "POST", f"repos/{OWNER}/{REPO}/git/trees",
                  input_data=json.dumps({"base_tree": base_tree, "tree": tree_items}))
    print(f"\nnew tree    : {new_tree['sha']}")

    new_commit = gh("api", "-X", "POST", f"repos/{OWNER}/{REPO}/git/commits",
                    input_data=json.dumps({
                        "message": MESSAGE,
                        "tree": new_tree["sha"],
                        "parents": [commit_sha],
                    }))
    print(f"new commit  : {new_commit['sha']}")

    gh("api", "-X", "PATCH", f"repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}",
       input_data=json.dumps({"sha": new_commit["sha"], "force": False}))
    print(f"branch {BRANCH} -> {new_commit['sha']}\n")
    return new_commit["sha"]


# ------------------------------------------------------------------ Release
def release_exists(tag):
    p = subprocess.run(
        ["gh", "release", "view", tag, "--repo", f"{OWNER}/{REPO}"],
        capture_output=True,
    )
    return p.returncode == 0


def create_release(tag, zip_path, title=None, notes=None, notes_file=None):
    if not os.path.exists(zip_path):
        raise FileNotFoundError(f"安装包不存在: {zip_path}")

    title = title or tag
    print(f"Release {tag}")
    print(f"  包  : {zip_path} ({os.path.getsize(zip_path) // 1024} KB)")

    if release_exists(tag):
        # 已存在：只更新资产
        print("  Release 已存在，改为上传/覆盖资产")
        p = subprocess.run(
            ["gh", "release", "upload", tag, zip_path, "--clobber",
             "--repo", f"{OWNER}/{REPO}"],
            capture_output=True,
        )
        if p.returncode != 0:
            raise RuntimeError(p.stderr.decode("utf-8", "replace"))
        print("  资产已覆盖")
        return

    cmd = ["gh", "release", "create", tag, zip_path, "--repo", f"{OWNER}/{REPO}",
           "--title", title]
    if notes:
        cmd += ["--notes", notes]
    elif notes_file and os.path.exists(notes_file):
        cmd += ["--notes-file", notes_file]
    else:
        cmd += ["--notes", f"版本 {tag}"]

    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace"))
    print("  已创建")
    print(" ", p.stdout.decode("utf-8", "replace").strip())


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(
        description="通过 GitHub API 提交代码 / 创建 Release")
    ap.add_argument("--release", action="store_true", help="提交后创建 Release")
    ap.add_argument("--only-release", action="store_true",
                    help="只创建 Release，不提交代码")
    ap.add_argument("--tag", help="Release 标签，默认 v<version>")
    ap.add_argument("--zip", help="安装包路径，默认 packages/<id>-<version>.zip")
    ap.add_argument("--title", help="Release 标题")
    ap.add_argument("--notes", help="Release 说明正文")
    ap.add_argument("--notes-file", help="Release 说明文件")
    args = ap.parse_args()

    version = read_version()
    app_id = read_micro_app_id()
    tag = args.tag or f"v{version}"
    zip_path = args.zip or os.path.join(
        ROOT, "packages", f"{app_id}-{version}.zip")

    do_push = not args.only_release
    do_release = args.release or args.only_release

    if not do_push and not do_release:
        do_push = True

    try:
        if do_push:
            print("=== 提交代码 ===")
            push_code()
        if do_release:
            print("=== 创建 Release ===")
            print(f"  版本: {version}")
            create_release(tag, zip_path, title=args.title,
                           notes=args.notes, notes_file=args.notes_file)
        print("\n完成")
    except Exception as e:
        print(f"\n失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
