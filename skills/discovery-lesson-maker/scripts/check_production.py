#!/usr/bin/env python3
"""检查制作记录与实际文件；不执行课程JS，也不判断写实或学习效果。"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
from urllib.parse import unquote


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def local_file(root, name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise ValueError(f'不是包内相对路径：{name!r}')
    raw = Path(unquote(name))
    if raw.is_absolute() or '..' in raw.parts:
        raise ValueError(f'路径越界：{name}')
    path = (root / raw).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f'文件缺失或越界：{name}')
    return path


def inspect_gltf(root, path):
    """只验glTF/GLB容器和引用，不能冒称Khronos完整验证。"""
    root, path = Path(root).resolve(), Path(path).resolve()
    binary_chunks = []
    if path.suffix.lower() == '.glb':
        data = path.read_bytes()
        if len(data) < 20 or struct.unpack_from('<4sII', data) != (b'glTF', 2, len(data)):
            raise ValueError('GLB文件头、版本或长度无效')
        offset, chunks = 12, []
        while offset < len(data):
            if offset + 8 > len(data):
                raise ValueError('GLB分块头截断')
            size, kind = struct.unpack_from('<II', data, offset)
            offset += 8
            if size % 4 or offset + size > len(data):
                raise ValueError('GLB分块长度无效')
            chunks.append((kind, data[offset:offset + size]))
            offset += size
        if not chunks or chunks[0][0] != 0x4E4F534A:
            raise ValueError('GLB首块不是JSON')
        doc = json.loads(chunks[0][1].decode('utf-8').rstrip('\x00 \t\r\n'))
        binary_chunks = [payload for kind, payload in chunks if kind == 0x004E4942]
    elif path.suffix.lower() == '.gltf':
        doc = json.loads(path.read_text(encoding='utf-8'))
    else:
        raise ValueError('三维主角需GLB/glTF；其他格式须依据宿主支持补充检查，不能把图/视频改名代替')
    if str(doc.get('asset', {}).get('version')) != '2.0':
        raise ValueError('不是glTF 2.0')
    accessors = doc.get('accessors', [])
    mesh_vertices = 0
    for mesh in doc.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            index = primitive.get('attributes', {}).get('POSITION')
            if not isinstance(index, int) or not 0 <= index < len(accessors):
                raise ValueError('网格没有有效POSITION访问器')
            count = accessors[index].get('count', 0)
            if not isinstance(count, int) or count <= 0:
                raise ValueError('主角网格没有顶点')
            mesh_vertices += count
    if not mesh_vertices:
        raise ValueError('没有实际三维网格')
    references = 0
    for collection in ('buffers', 'images'):
        for entry in doc.get(collection, []):
            uri = entry.get('uri')
            if uri and not uri.startswith('data:'):
                relative = (path.parent / unquote(uri)).resolve().relative_to(root).as_posix()
                target = local_file(root, relative)
                references += 1
                if collection == 'buffers' and target.stat().st_size < entry.get('byteLength', 0):
                    raise ValueError('外部缓冲区截断')
    embedded = [b for b in doc.get('buffers', []) if not b.get('uri')]
    if embedded and (not binary_chunks or len(binary_chunks[0]) < embedded[0].get('byteLength', 0)):
        raise ValueError('GLB二进制缓冲区缺失或截断')
    return {'meshes': len(doc.get('meshes', [])), 'vertices': mesh_vertices,
            'nodeNames': [n['name'] for n in doc.get('nodes', []) if isinstance(n.get('name'), str)],
            'localReferences': references, 'check': '容器/网格声明/引用；非完整glTF验证或写实审查'}


def probe_video(path):
    executable = shutil.which('ffprobe')
    if not executable:
        raise ValueError('未找到ffprobe，不能声称已经检查短片编码')
    result = subprocess.run([executable, '-v', 'error', '-show_entries',
                             'format=duration:stream=codec_type,width,height,avg_frame_rate',
                             '-of', 'json', str(path)], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError('ffprobe无法读取短片：' + result.stderr.strip()[:180])
    info = json.loads(result.stdout)
    video = next((s for s in info.get('streams', []) if s.get('codec_type') == 'video'), None)
    duration = float(info.get('format', {}).get('duration', 0))
    if not video or not math.isfinite(duration) or duration <= 0:
        raise ValueError('没有可用的视频流或时长')
    return {'duration': duration, 'width': video['width'], 'height': video['height'],
            'fps': video.get('avg_frame_rate'), 'audioStreams': sum(
                s.get('codec_type') == 'audio' for s in info.get('streams', []))}


def probe_audio(path):
    executable = shutil.which('ffprobe')
    if not executable:
        raise ValueError('未找到ffprobe，不能检查实际音频流')
    result = subprocess.run([executable, '-v', 'error', '-show_entries',
                             'format=duration:stream=codec_type,sample_rate,channels',
                             '-of', 'json', str(path)], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError('无法解码旁白音频')
    info = json.loads(result.stdout)
    track = next((s for s in info.get('streams', []) if s.get('codec_type') == 'audio'), None)
    duration = float(info.get('format', {}).get('duration', 0))
    if not track or not math.isfinite(duration) or duration <= 0:
        raise ValueError('没有可用音频流或时长')
    return {'duration': duration, 'sampleRate': track.get('sample_rate'),
            'channels': track.get('channels'), 'listened': False}


def validate(root, stage='assets', expected_topic=None, probe_media=False):
    root = Path(root).resolve()
    errors, warnings, facts = [], [], {'models': {}, 'clips': {}, 'narration': {}}
    try:
        record = json.loads(local_file(root, 'production.json').read_text(encoding='utf-8'))
        if not isinstance(record, dict):
            raise ValueError('production.json必须是对象')
    except (ValueError, OSError) as exc:
        return {'errors': [str(exc)], 'warnings': [], 'checks': {}, 'reviewStatus': {}}

    def check_file(name, sha=None):
        path = local_file(root, name)
        if sha is not None and (not isinstance(sha, str) or sha != digest(path)):
            raise ValueError(f'文件SHA256缺失或不一致：{name}')
        return path

    def attempt(label, function):
        try:
            return function()
        except (ValueError, OSError, KeyError, TypeError, IndexError, struct.error,
                StopIteration, subprocess.TimeoutExpired) as exc:
            errors.append(f'{label}：{exc}')
            return None

    if record.get('format') != 'discovery-production/1':
        errors.append('未知制作记录格式；这不是App的课程Schema')
    if not isinstance(record.get('topic'), str) or not record['topic'].strip():
        errors.append('主题为空')
    if expected_topic is not None and record.get('topic') != expected_topic:
        errors.append('制作主题与用户给定主题不一致')

    def indexed(field):
        items = record.get(field, [])
        if not isinstance(items, list) or any(not isinstance(i, dict) for i in items):
            errors.append(f'{field}必须是对象数组')
            return {}
        result = {}
        for item in items:
            key = item.get('id')
            if not isinstance(key, str) or not key or key in result:
                errors.append(f'{field}存在缺失或重复id')
            else:
                result[key] = item
        return result

    assets, clips, sources = indexed('assets'), indexed('clips'), indexed('sources')
    narration = indexed('narration')
    requirements = record.get('requirements', {})
    if not isinstance(requirements, dict):
        errors.append('requirements必须是对象')
        requirements = {}
    for key in ('video', 'action'):
        if key in requirements and not isinstance(requirements[key], bool):
            errors.append(f'requirements.{key}必须是布尔值')
        if requirements.get(key) is False and not requirements.get('reason'):
            errors.append(f'不要求{key}时必须记录本轮需求依据，不能为通过检查删掉要求')
    video_required = requirements.get('video', True) is not False
    action_required = requirements.get('action', True) is not False
    scene = record.get('scene', {})
    app = record.get('app', {})
    if not isinstance(scene, dict) or not isinstance(app, dict):
        errors.append('scene/app必须是对象')
        scene, app = {}, {}
    if stage != 'record':
        if scene.get('heroAsset') not in assets:
            errors.append('缺少真实三维主角资产；照片、视频或占位声明不能代替')
        if video_required and not clips:
            errors.append('缺少写实动画短片文件')
    for key, asset in assets.items():
        path = attempt(key, lambda a=asset: check_file(a.get('file'), a.get('sha256', '')))
        if asset.get('sourceId') not in sources:
            errors.append(f'{key}未关联真实来源条目')
        if stage != 'record' and (asset.get('licenseScope') not in ('commercial', 'personal-noncommercial')
                                  or not asset.get('license')):
            errors.append(f'{key}许可范围未知')
        if key == scene.get('heroAsset') and path:
            facts['models'][key] = attempt(key, lambda p=path: inspect_gltf(root, p))
    for key, clip in clips.items():
        path = attempt(key, lambda c=clip: check_file(c.get('file'), c.get('sha256', '')))
        if clip.get('sourceId') not in sources:
            errors.append(f'{key}未关联来源/生成记录')
        if stage != 'record' and (clip.get('licenseScope') not in ('commercial', 'personal-noncommercial')
                                  or not clip.get('license')):
            errors.append(f'{key}短片许可范围未知')
        if path:
            with path.open('rb') as stream:
                header = stream.read(16)
            if path.suffix.lower() not in ('.mp4', '.webm', '.mov', '.m4v'):
                errors.append(f'{key}不是可交付短片；GIF/图片/提示词不算成片')
            elif header[:4] != b'\x1aE\xdf\xa3' and header[4:8] not in (
                    b'ftyp', b'wide', b'moov', b'mdat', b'free', b'skip'):
                errors.append(f'{key}文件内容不符合视频容器头，不能只改后缀')
            elif probe_media:
                facts['clips'][key] = attempt(key, lambda p=path: probe_video(p))
            else:
                warnings.append(f'{key}仅核对文件与校验值，尚未探测编码/播放')
    for key, source in sources.items():
        if source.get('file'):
            # 自主建模和本地生成记录是有效来源，不要求编造远程URL。
            attempt(key + '本地来源', lambda s=source: check_file(s['file'], s.get('sha256')))
        elif not str(source.get('url', '')).startswith(('https://', 'http://')):
            errors.append(f'{key}缺少直接来源URL')
        if source.get('verification') not in ('read', 'metadata-only', 'not-verified'):
            errors.append(f'{key}核实状态必须明确')
    for key, item in narration.items():
        path = attempt(key, lambda a=item: check_file(a.get('file'), a.get('sha256', '')))
        if item.get('origin') not in ('human-recording', 'synthetic'):
            errors.append(f'{key}必须如实区分真人录音与合成语音')
        if item.get('sourceId') not in sources:
            errors.append(f'{key}缺少旁白来源')
        if stage != 'record' and (not item.get('license') or item.get('licenseScope') not in (
                'commercial', 'personal-noncommercial')):
            errors.append(f'{key}缺少旁白来源或授权范围')
        attempt(key + '文稿', lambda a=item: check_file(a.get('transcriptFile')))
        if path and probe_media:
            facts['narration'][key] = attempt(key, lambda p=path: probe_audio(p))
    for claim in record.get('claims', []):
        if not isinstance(claim, dict) or not claim.get('sourceIds') or any(
                key not in sources for key in claim.get('sourceIds', [])):
            errors.append('关键事实未关联有效直接来源')
        elif claim.get('status') == 'verified' and any(
                sources[key].get('verification') != 'read' for key in claim['sourceIds']):
            errors.append('事实声称已核实，但来源仅为检索线索/未读')

    def verify_proof(review, label):
        if not isinstance(review, dict):
            raise ValueError('证明记录不是对象')
        evidence = review.get('evidence', [])
        artifacts = review.get('artifacts', {})
        if not evidence or not isinstance(evidence, list) or not artifacts or not isinstance(artifacts, dict):
            raise ValueError('passed记录缺少实际证据及对应当前产物校验值')
        for item in evidence:
            check_file(item['file'], item.get('sha256', ''))
        for filename, sha in artifacts.items():
            check_file(filename, sha)
        return True

    reviews = record.get('reviews', {})
    if not isinstance(reviews, dict):
        errors.append('reviews必须是对象')
        reviews = {}
    for lane, review in reviews.items():
        if not isinstance(review, dict) or review.get('status') not in (
                'pending', 'passed', 'failed', 'not-applicable'):
            errors.append(f'{lane}审查状态无效')
            continue
        if review['status'] == 'passed':
            attempt(lane, lambda r=review: verify_proof(r, lane))
        if review['status'] == 'not-applicable' and not review.get('reason'):
            errors.append(f'{lane}不适用但没有理由')
    if stage == 'course':
        brief = record.get('brief', {})
        if not isinstance(brief, dict) or not brief.get('question') or not brief.get('objectives'):
            errors.append('缺少主题核心问题和可验证学习目标')
            brief = brief if isinstance(brief, dict) else {}
        weave = brief.get('learningWeave', {})
        for dimension in ('chineseExpression', 'english', 'math', 'science', 'interest', 'confidence', 'emotionalSupport'):
            if not isinstance(weave, dict) or not isinstance(weave.get(dimension), str) or not weave[dimension].strip():
                errors.append(f'缺少本课{dimension}自然结合的设计记录')
        if not probe_media:
            errors.append('课程候选检查必须加--probe-media读取实际视频流')
        if app.get('status') != 'compatible':
            errors.append('宿主App兼容性尚未验证')
        if not app.get('schemaSource') or not app.get('capabilitiesSource'):
            errors.append('缺少宿主真实Schema/能力来源')
        content = attempt('App课程', lambda: check_file(app.get('contentFile')))
        native = app.get('nativeValidation') or {}
        if native.get('status') != 'passed' or native.get('exitCode') != 0 or not native.get('command'):
            errors.append('没有真实宿主原生校验通过的记录')
        else:
            attempt('App原生校验', lambda: verify_proof(native, 'App原生校验'))
            if content and native.get('artifacts', {}).get(app.get('contentFile')) != digest(content):
                errors.append('宿主原生校验未对应当前课程内容')
        required_lanes = ['science', 'visual', 'interaction', 'teachingFlow']
        if action_required:
            required_lanes.append('motion')
        if video_required:
            required_lanes.append('video')
        for lane in required_lanes:
            if reviews.get(lane, {}).get('status') != 'passed':
                errors.append(f'{lane}尚无当前证据支持通过')
        hero_file = assets.get(scene.get('heroAsset'), {}).get('file')
        for lane in (['visual', 'interaction'] + (['motion'] if action_required else [])):
            if not hero_file or hero_file not in reviews.get(lane, {}).get('artifacts', {}):
                errors.append(f'{lane}证据未关联当前主角资产')
        clip_files = {c.get('file') for c in clips.values()}
        if video_required and not clip_files.intersection(reviews.get('video', {}).get('artifacts', {})):
            errors.append('video证据未关联实际短片')
        if app.get('contentFile') not in reviews.get('teachingFlow', {}).get('artifacts', {}):
            errors.append('teachingFlow未关联当前课程内容')
        if record.get('voiceRequired', True):
            if not narration or reviews.get('voice', {}).get('status') != 'passed':
                errors.append('缺少实际旁白和声音听检/同步审查记录')
            if not {n.get('file') for n in narration.values()}.intersection(reviews.get('voice', {}).get('artifacts', {})):
                errors.append('voice证据未关联实际旁白文件')
        if scene.get('entry'):
            attempt('场景入口', lambda: check_file(scene['entry']))
        elif not scene.get('componentId'):
            errors.append('缺少实际场景入口或宿主组件标识')
        core = {'orbit', 'zoom', 'inspect-underside', 'reset-pose'}
        if action_required:
            core.update({'play-action', 'pause-action'})
        if not core.issubset(scene.get('requiredCapabilities', [])):
            errors.append('必需的真三维观察和动画控制能力不能从制作记录中删掉')
        verified = set()
        for capability in scene.get('verifiedCapabilities', []):
            if isinstance(capability, dict) and capability.get('status') == 'passed':
                if attempt('场景能力', lambda c=capability: verify_proof(c, c.get('id'))) is not None:
                    verified.add(capability.get('id'))
        missing = set(scene.get('requiredCapabilities', [])) - verified
        if missing:
            errors.append('场景能力没有当前证明：' + ', '.join(sorted(missing)))
    return {'stage': stage, 'topic': record.get('topic'), 'errors': errors, 'warnings': warnings,
            'checks': facts, 'appStatus': app.get('status', 'pending'),
            'reviewStatus': {k: v.get('status') for k, v in reviews.items() if isinstance(v, dict)},
            'meaning': '只核对资料/文件/证据一致性；不是独立的写实、运行、兼容或教学效果验收'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--stage', choices=('record', 'assets', 'course'), default='assets')
    parser.add_argument('--expected-topic')
    parser.add_argument('--probe-media', action='store_true')
    args = parser.parse_args()
    result = validate(args.directory, args.stage, args.expected_topic, args.probe_media)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(bool(result['errors']))


if __name__ == '__main__':
    main()
