#!/usr/bin/env bash
# CI (.github/workflows/apps.yml): in an Android emulator, open the tablet app and check that it found the family
# server by itself (the emulator sees the runner as 10.0.2.2) and shows the pairing screen. Then the same for the
# signed APK that ships in apps/android/release, if there is one.
set -uo pipefail
out="${RUNNER_TEMP:-/tmp}"

try_app() { # apk, label
  adb uninstall world.aidiscovery.pad >/dev/null 2>&1
  adb install -r "$1" || { echo "✗ $2: install failed"; return 1; }
  adb logcat -c
  adb shell am start -n world.aidiscovery.pad/.MainActivity
  for _ in $(seq 45); do
    adb logcat -d -s ADW:I | grep -q "page: .*配对码" && break
    sleep 2
  done
  adb logcat -d -s ADW:* | tail -30
  adb exec-out screencap -p > "$out/$2.png"
  if adb logcat -d -s ADW:I | grep -q "page: .*配对码"; then echo "✓ $2: found the server and shows the pairing screen"; else echo "✗ $2: no pairing screen"; return 1; fi
}

status=0
try_app apps/android/app/build/outputs/apk/debug/app-debug.apk pad-app-debug || status=1
signed=apps/android/release/ai-discovery-world-pad.apk
if [ -f "$signed" ]; then
  # the release build logs no page text, so only check it installs, starts and loads the Pad page
  adb uninstall world.aidiscovery.pad >/dev/null 2>&1
  if adb install -r "$signed"; then
    adb logcat -c
    adb shell am start -n world.aidiscovery.pad/.MainActivity
    ok=0
    for _ in $(seq 30); do adb logcat -d -s ADW:I | grep -q "loaded http://10.0.2.2:8787/pad/" && { ok=1; break; }; sleep 2; done
    sleep 6; adb exec-out screencap -p > "$out/pad-app-release.png"
    if [ $ok = 1 ]; then echo "✓ shipped APK: installs, finds the server, loads the Pad page"; else echo "✗ shipped APK did not load the Pad page"; adb logcat -d -s ADW:* | tail -20; status=1; fi
  else
    echo "✗ shipped APK: install failed"; status=1
  fi
fi
exit $status
