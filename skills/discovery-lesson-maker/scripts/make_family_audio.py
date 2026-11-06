#!/usr/bin/env python3
"""给 lesson-flow.json 里孩子要听的每句话、以及上课流程的固定用语配音。
用法：python3 make_family_audio.py <web/public 目录> [--engine azure|volcengine|openai|mac] [--voice-zh …] [--voice-en …] [--list] [--redo]

声音来源（按听感从好到差）：
  azure       微软 Azure 神经语音，播音级。环境变量 ADW_TTS_KEY、ADW_TTS_REGION（如 eastasia）。默认 晓晓 + Ava。
  volcengine  火山引擎 豆包语音，中文很自然。ADW_TTS_KEY（Access Token）、ADW_TTS_APPID、可选 ADW_TTS_CLUSTER。
  openai      OpenAI 兼容 /audio/speech。ADW_TTS_KEY、可选 ADW_TTS_BASE_URL、ADW_TTS_MODEL。
  mac         这台 Mac 的 say（免费，偏机械，只在没有云端密钥时用）。
不传 --engine 时：有 ADW_TTS_KEY 用 ADW_TTS_ENGINE（默认 azure），否则用 mac。
文件写到 <目录>/audio/family/，文件名由句子算出（和 adw-family.mjs 的 lineFile() 一致），已有的不重录（--redo 全部重录）。
同时写 audio/family/voice.json：来源都是 synthetic、引擎、声线，供制作记录引用。合成声音不是真人：录完必须挑句子亲耳听（见 references/voice-direction.md 的听检清单）。"""
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from pathlib import Path

from family_flow import all_lines, line_file

DEFAULTS = {
    'azure': ('zh-CN-XiaoxiaoNeural', 'en-US-AvaNeural'),
    'volcengine': ('BV001_streaming', 'BV503_streaming'),
    'openai': ('coral', 'coral'),
    'mac': ('Tingting', 'Samantha'),
}
DECOR = re.compile('[\U0001F000-\U0001FAFF☀-➿️‍★☆✓✔✗✘●○◆◇■□▶►→←↑↓]')


def speakable(text):
    """和服务器 voice-cloud.ts 的 speakable() 同一规则：去表情和装饰、叠用的！？只留一个、省略号变停顿、去掉 ~。"""
    zh = re.search('[㐀-鿿]', text)
    t = DECOR.sub('', text)
    t = re.sub('[~～]+', '', t)
    t = re.sub(r'(……|\.{3,}|…)+', '，' if zh else ', ', t)
    t = re.sub('([！!])[！!]+', r'\1', t)
    t = re.sub('([？?])[？?]+', r'\1', t)
    t = re.sub('[？?][！!]+|[！!][？?]+', '？', t)
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(r'[，,]\s*([。.！!？?])', r'\1', t).strip()
    return re.sub('[，,]$', '', t)


def xml(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;').replace("'", '&apos;')


def post(url, body, headers):
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def synth(engine, text, lang, voice, style):
    """返回 24kHz 16 位单声道 WAV 字节。"""
    key = os.environ.get('ADW_TTS_KEY', '')
    if engine == 'azure':
        region = os.environ.get('ADW_TTS_REGION', 'eastasia')
        locale = 'zh-CN' if lang == 'zh' else 'en-US'
        inner = xml(text)
        if style and lang == 'zh':
            inner = f'<mstts:express-as style="{xml(style)}">{inner}</mstts:express-as>'
        ssml = (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" '
                f'xml:lang="{locale}"><voice name="{xml(voice)}">{inner}</voice></speak>')
        return post(f'https://{region}.tts.speech.microsoft.com/cognitiveservices/v1', ssml.encode('utf-8'), {
            'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'ai-discovery-world'})
    if engine == 'volcengine':
        body = {'app': {'appid': os.environ.get('ADW_TTS_APPID', ''), 'token': key, 'cluster': os.environ.get('ADW_TTS_CLUSTER', 'volcano_tts')},
                'user': {'uid': 'family'},
                'audio': {'voice_type': voice, 'encoding': 'wav', 'rate': 24000, 'speed_ratio': 1.0},
                'request': {'reqid': str(uuid.uuid4()), 'text': text, 'text_type': 'plain', 'operation': 'query'}}
        res = json.loads(post('https://openspeech.bytedance.com/api/v1/tts', json.dumps(body).encode('utf-8'),
                              {'Content-Type': 'application/json', 'Authorization': f'Bearer;{key}'}))
        if res.get('code') not in (0, 3000) or not res.get('data'):
            raise RuntimeError(f'火山引擎：{res.get("message") or res.get("code")}')
        return base64.b64decode(res['data'])
    if engine == 'openai':
        base = os.environ.get('ADW_TTS_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
        body = {'model': os.environ.get('ADW_TTS_MODEL', 'gpt-4o-mini-tts'), 'voice': voice, 'input': text, 'response_format': 'wav',
                'instructions': style or ('用标准普通话，像少儿科普节目的专业主持人：亲切、清楚、语速适中，不夸张，不广告腔。' if lang == 'zh'
                                          else 'Clear, natural American English like a warm documentary narrator for children. Moderate pace.')}
        return post(f'{base}/audio/speech', json.dumps(body).encode('utf-8'), {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
    raise ValueError(engine)


def to_m4a(src, out):
    if shutil.which('afconvert'):
        subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', str(src), str(out)], check=True)
    elif shutil.which('ffmpeg'):
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', str(src), '-c:a', 'aac', '-b:a', '96k', str(out)], check=True)
    else:
        sys.exit('需要 afconvert（Mac 自带）或 ffmpeg 把录音转成 m4a')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('public', type=Path, help='放 lesson-flow.json 的目录（通常是 web/public）')
    parser.add_argument('--engine', choices=sorted(DEFAULTS))
    parser.add_argument('--voice-zh')
    parser.add_argument('--voice-en')
    parser.add_argument('--style', default=os.environ.get('ADW_TTS_STYLE', ''), help='Azure 中文说话风格（如 gentle、newscast），OpenAI 为语气说明')
    parser.add_argument('--list', action='store_true', help='只列出要录的句子和文件名')
    parser.add_argument('--redo', action='store_true', help='换了声音后全部重录')
    args = parser.parse_args()
    flow = json.loads((args.public / 'lesson-flow.json').read_text(encoding='utf-8'))
    lines = all_lines(flow)
    if args.list:
        for lang, text, where in lines:
            print(f'{line_file(lang, text)}\t{lang}\t{where}\t{text}')
        return
    engine = args.engine or (os.environ.get('ADW_TTS_ENGINE', 'azure') if os.environ.get('ADW_TTS_KEY') else 'mac')
    if engine != 'mac' and not os.environ.get('ADW_TTS_KEY'):
        sys.exit(f'{engine} 需要环境变量 ADW_TTS_KEY（密钥不要写进课程包或代码）')
    if engine == 'mac' and not shutil.which('say'):
        sys.exit('没有云端密钥时要在 Mac 上运行（需要 say）；或用 --list 列出句子，用别的方式录好按文件名放进 audio/family/')
    voice_zh = args.voice_zh or DEFAULTS[engine][0]
    voice_en = args.voice_en or DEFAULTS[engine][1]
    made = 0
    with tempfile.TemporaryDirectory() as tmp:
        for lang, text, _ in lines:
            out = args.public / line_file(lang, text)
            if out.exists() and not args.redo:
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            voice = voice_en if lang == 'en' else voice_zh
            spoken = speakable(text)
            if engine == 'mac':
                src = Path(tmp) / 'line.aiff'
                subprocess.run(['say', '-v', voice, '-o', str(src), spoken], check=True)
            else:
                src = Path(tmp) / 'line.wav'
                src.write_bytes(synth(engine, spoken, lang, voice, args.style))
            to_m4a(src, out)
            made += 1
    record = {'origin': 'synthetic', 'engine': engine, 'voices': {'zh': voice_zh, 'en': voice_en}, 'style': args.style or None,
              'lines': len(lines), 'reviewed': False,
              'note': '合成声音，不是真人录音。听检通过后把 reviewed 改为 true 并在制作记录 reviews.voice 写明听了哪些句子。'}
    (args.public / 'audio' / 'family').mkdir(parents=True, exist_ok=True)
    (args.public / 'audio' / 'family' / 'voice.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'lines': len(lines), 'made': made, 'engine': engine, 'voices': record['voices'], 'dir': str(args.public / 'audio' / 'family')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
