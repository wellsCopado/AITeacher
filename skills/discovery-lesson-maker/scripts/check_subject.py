#!/usr/bin/env python3
"""核对主角身份、实际节点绑定和功能教学记录；不代替视觉与教育效果审查。"""
import argparse
from datetime import date
import json
from pathlib import Path

from check_production import digest, inspect_gltf, local_file


def validate(root, expected_subject, draft=False, require_real_instance=False):
    root = Path(root).resolve()
    errors = []
    facts = {}
    try:
        record = json.loads(local_file(root, 'scope.json').read_text())
        identity = record['identity']
        if identity.get('resolvedSubject') != expected_subject:
            errors.append('主角身份与明确要求不一致，不能用替代对象继续扩课')
        if not identity.get('request') or not identity.get('basis'):
            errors.append('缺少用户原话或对象选择依据')
        model = record['model']
        path = local_file(root, model['file'])
        current_sha = digest(path)
        if model.get('sha256') != current_sha:
            errors.append('主角资产SHA256缺失或不一致')
        info = inspect_gltf(root, path)
        nodes = set(info['nodeNames'])
        features = identity.get('requiredFeatures', [])
        if not features:
            errors.append('没有主角核心辨识结构')
        feature_ids = {f.get('id') for f in features}
        if '人形' in expected_subject or identity.get('kind') == 'humanoid':
            if identity.get('kind') != 'humanoid':
                errors.append('人形机器人不能以机械臂等其他子类替代')
            required = {'head': 1, 'torso': 1, 'arms': 2, 'legs': 2, 'hands': 2, 'feet': 2}
            for feature, count in required.items():
                item = next((f for f in features if f.get('id') == feature), {})
                if feature not in feature_ids or len(set(item.get('nodes', []))) < count:
                    errors.append('完整人形缺少必要结构：' + feature)
        for item in features:
            names = item.get('nodes', [])
            if not names or len(set(names)) < item.get('minNodes', 1) or not set(names).issubset(nodes):
                errors.append('辨识结构没有绑定实际节点：' + str(item.get('id')))
        sources = {s['id'] for s in record.get('sources', [])}
        if require_real_instance:
            real = identity.get('realObject', {})
            if identity.get('representation') != 'reference-reconstruction':
                errors.append('本轮要求真实对象重建，不能用自创教学角色替代')
            if not isinstance(real, dict) or not real.get('name') or not real.get('basis'):
                errors.append('缺少真实种类/型号/建筑及选型依据')
                real = real if isinstance(real, dict) else {}
            anchors = real.get('anchors', [])
            if not isinstance(anchors, list) or not anchors:
                errors.append('缺少将参考落实到形体、比例或配置的具体依据')
                anchors = []
            real_sources = real.get('sourceIds', [])
            ids = set(real_sources) if isinstance(real_sources, list) else set()
            for anchor in anchors:
                if not isinstance(anchor, dict):
                    errors.append('真实对象参考特征必须是对象')
                    continue
                anchor_sources = anchor.get('sourceIds', [])
                if not anchor.get('feature') or not anchor.get('basis') or not isinstance(anchor_sources, list) or not anchor_sources:
                    errors.append('真实对象参考只有名称，缺少特征与几何依据')
                if isinstance(anchor_sources, list):
                    ids.update(anchor_sources)
            if not ids or not ids.issubset(sources):
                errors.append('真实对象没有关联有效直接来源')
            if any(s.get('verification') != 'read' for s in record.get('sources', []) if s['id'] in ids):
                errors.append('真实对象依据未实际读取，不能用检索标题填型号')
        if identity.get('superlative'):
            date.fromisoformat(identity.get('checkedAt', ''))
            ranking_sources = identity.get('rankingSourceIds', [])
            if not identity.get('comparisonScope') or not ranking_sources or not set(ranking_sources).issubset(sources):
                errors.append('最高/第一等比较缺少核实日期、比较口径或直接来源')
            if any(s.get('verification') != 'read' for s in record.get('sources', []) if s['id'] in ranking_sources):
                errors.append('排名依据尚未实际读取，不能只凭检索标题确认第一')
        parts = record.get('parts', [])
        if not parts:
            errors.append('缺少部件功能介绍')
        for part in parts:
            label = str(part.get('id', '?'))
            for field in ['title', 'function', 'mechanism', 'observation']:
                if not isinstance(part.get(field), str) or not part[field].strip():
                    errors.append(label + '缺少功能/机制/观察说明：' + field)
            if not part.get('nodes') or not set(part['nodes']).issubset(nodes):
                errors.append(label + '部件绑定不在实际模型中')
            if not part.get('sourceIds') or not set(part['sourceIds']).issubset(sources):
                errors.append(label + '功能说明没有实际来源')
        explained_nodes = {node for part in parts for node in part.get('nodes', [])
                           if all(part.get(field) for field in ['function', 'mechanism', 'observation'])}
        for feature in features:
            if not set(feature.get('nodes', [])).issubset(explained_nodes):
                errors.append('核心结构缺少功能教学覆盖：' + str(feature.get('id')))
        experiment = record.get('experiment', {})
        for field in ['question', 'prediction', 'control', 'observedChange', 'explanation']:
            if not isinstance(experiment.get(field), str) or not experiment[field].strip():
                errors.append('关键机制实验缺少：' + field)
        if not experiment.get('sourceIds') or not set(experiment['sourceIds']).issubset(sources):
            errors.append('关键机制实验没有实际来源')
        for lane in ['identity', 'teaching']:
            review = record.get('reviews', {}).get(lane, {})
            if review.get('status') != 'passed':
                if not draft:
                    errors.append(lane + '尚无实际审查通过记录')
                continue
            if review.get('assetSha256') != current_sha or not review.get('evidence'):
                errors.append(lane + '审查未对应当前主角及实际证据')
            for evidence in review.get('evidence', []):
                proof = local_file(root, evidence['file'])
                if digest(proof) != evidence.get('sha256'):
                    errors.append(lane + '审查证据SHA256不一致')
        facts = {'subject': identity.get('resolvedSubject'), 'features': len(features),
                 'parts': len(parts), 'modelNodes': len(nodes), 'vertices': info['vertices']}
    except (OSError, ValueError, TypeError, KeyError) as error:
        errors.append(str(error))
    return {'errors': errors, 'checks': facts,
            'meaning': '只核对身份声明、节点和功能教学证据一致性；不能证明节点形态正确、审美达标或孩子学会。'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--expected-subject', required=True)
    parser.add_argument('--draft', action='store_true')
    parser.add_argument('--require-real-instance', action='store_true', help='真实实体重建要求；只校验参考记录，不识别网格真伪')
    args = parser.parse_args()
    result = validate(args.directory, args.expected_subject, args.draft, args.require_real_instance)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(bool(result['errors']))


if __name__ == '__main__':
    main()
