#!/usr/bin/env python3
"""给 lesson-flow.json 里孩子要听的每句话、以及上课流程的固定用语录音（macOS 的 say + afconvert）。
用法：python3 make_family_audio.py <web/public 目录> [--voice-zh Tingting] [--voice-en Samantha] [--list]
文件写到 <目录>/audio/family/，文件名由句子算出（和 adw-family.mjs 的 lineFile() 一致），已有的不重录。
合成声音不是真人：录完挑几句亲耳听，听着别扭就换更自然的声音（系统设置里下载“增强版/高级版”）。"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from family_flow import all_lines, line_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('public', type=Path, help='放 lesson-flow.json 的目录（通常是 web/public）')
    parser.add_argument('--voice-zh', default='Tingting')
    parser.add_argument('--voice-en', default='Samantha')
    parser.add_argument('--list', action='store_true', help='只列出要录的句子和文件名')
    args = parser.parse_args()
    flow = json.loads((args.public / 'lesson-flow.json').read_text(encoding='utf-8'))
    lines = all_lines(flow)
    if args.list:
        for lang, text, where in lines:
            print(f'{line_file(lang, text)}\t{lang}\t{where}\t{text}')
        return
    if not (shutil.which('say') and shutil.which('afconvert')):
        sys.exit('要在 Mac 上运行（需要 say 和 afconvert）；或用 --list 列出句子，用别的方式录好按文件名放进 audio/family/')
    made = 0
    with tempfile.TemporaryDirectory() as tmp:
        for lang, text, _ in lines:
            out = args.public / line_file(lang, text)
            if out.exists():
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            aiff = Path(tmp) / 'line.aiff'
            voice = args.voice_en if lang == 'en' else args.voice_zh
            subprocess.run(['say', '-v', voice, '-o', str(aiff), text], check=True)
            subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', str(aiff), str(out)], check=True)
            made += 1
    print(json.dumps({'lines': len(lines), 'made': made, 'dir': str(args.public / 'audio' / 'family')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
