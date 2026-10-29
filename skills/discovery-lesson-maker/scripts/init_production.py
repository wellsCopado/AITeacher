#!/usr/bin/env python3
"""只创建主题制作记录；不生成App、课程、模型或视频。"""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--topic', required=True)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    if not args.topic.strip():
        parser.error('主题不能为空')
    if args.out.exists():
        parser.error('目标已存在，请选择新目录，避免覆盖已有工作')
    template = Path(__file__).resolve().parents[1] / 'assets/production-template.json'
    record = json.loads(template.read_text(encoding='utf-8'))
    record['topic'] = args.topic.strip()
    args.out.mkdir(parents=True)
    for directory in ('models', 'media', 'research', 'evidence'):
        (args.out / directory).mkdir()
    path = args.out / 'production.json'
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'record': str(path), 'topic': record['topic'], 'status': 'draft',
                      'note': '仅创建记录；三维、短片、教学及App兼容性均未验证'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
