#!/usr/bin/env python3
"""Refresh the public package from a trusted Fork backend checkout."""
import argparse, pathlib, shutil
parser=argparse.ArgumentParser();parser.add_argument("computer",type=pathlib.Path);args=parser.parse_args()
source=args.computer.resolve();target=pathlib.Path(__file__).resolve().parents[1]/"virtual-computer"
if not (source/"src/sessions.js").is_file():parser.error("Expected the backend computer directory")
for item in sorted((source/"src").iterdir()):
    if item.is_file() and item.suffix==".js" and item.name!="server.js":
        shutil.copyfile(item,target/"src"/item.name)
for name in ["deploy/magick/policy.xml","test/virtual-computer.test.js"]:
    dst=target/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,dst)
print("Updated Virtual computer source and policy; review dependency lock changes separately.")
