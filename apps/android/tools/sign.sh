#!/usr/bin/env bash
# Signs the unsigned release APK built by CI with the family key and puts it in apps/android/release.
#   apps/android/tools/sign.sh <unsigned.apk> <key folder> <versionName> <versionCode> <commit>
# The key folder holds adw-pad.p12 and password.txt; it is kept outside git (see ../README.md).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
jar="$work/apksig-2.3.0.jar"
curl -sfL -o "$jar" https://repo1.maven.org/maven2/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar
echo "6ef7a58375aa68fb492b58edd97607bee8ee5c5c  $jar" | sha1sum -c - >/dev/null
javac -nowarn -d "$work" -cp "$jar" "$here/Sign.java"
out="$here/../release"
mkdir -p "$out"
java -cp "$work:$jar" Sign sign "$2/adw-pad.p12" "$2/password.txt" adw "$1" "$out/ai-discovery-world-pad.apk"
# Android 11+ refuses an APK whose uncompressed entries (resources.arsc) are not 4-byte aligned
python3 - "$out/ai-discovery-world-pad.apk" <<'PY'
import struct, sys, zipfile
f = open(sys.argv[1], 'rb'); bad = []
for i in zipfile.ZipFile(sys.argv[1]).infolist():
    f.seek(i.header_offset); h = f.read(30)
    n, e = struct.unpack('<HH', h[26:30]); data = i.header_offset + 30 + n + e
    if i.compress_type == 0 and data % (4096 if i.filename.endswith('.so') else 4): bad.append(i.filename)
print('aligned' if not bad else 'NOT aligned: ' + ', '.join(bad)); sys.exit(1 if bad else 0)
PY
sha=$(sha256sum "$out/ai-discovery-world-pad.apk" | cut -d' ' -f1)
printf '{\n  "versionName": "%s",\n  "versionCode": %s,\n  "commit": "%s",\n  "built": "%s",\n  "sha256": "%s"\n}\n' "$3" "$4" "$5" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" > "$out/version.json"
cat "$out/version.json"
