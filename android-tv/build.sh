#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}"
TV_JAVA="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export JAVA_HOME="$TV_JAVA"
export PATH="$TV_JAVA/bin:$PATH"
TOOLS="$SDK_ROOT/build-tools/35.0.0"
PLATFORM="$SDK_ROOT/platforms/android-35/android.jar"
for item in "$PLATFORM" "$TOOLS/aapt2" "$TOOLS/d8" "$TOOLS/apksigner" "$TV_JAVA/bin/javac"; do
  test -f "$item" || { echo "Missing Android build tool: $item" >&2; exit 1; }
done
mkdir -p build/light/classes build/light/dex build/light/generated
"$TOOLS/aapt2" compile --dir res -o build/light/resources.zip
"$TOOLS/aapt2" link -o build/light/base.apk --manifest AndroidManifest.xml -I "$PLATFORM" --java build/light/generated -A assets build/light/resources.zip
rm -f build/light/classes/net/codingcompanion/tv/TclExternalPlayer*.class
TV_SOURCES=()
while IFS= read -r file; do TV_SOURCES+=("$file"); done < <(find src/net/codingcompanion/tv -name '*.java' ! -name 'TclExternalPlayer.java')
"$TV_JAVA/bin/javac" --release 8 -encoding UTF-8 -classpath "$PLATFORM" -d build/light/classes "${TV_SOURCES[@]}" build/light/generated/net/codingcompanion/tv/R.java
TV_CLASSES=()
while IFS= read -r file; do TV_CLASSES+=("$file"); done < <(find build/light/classes -name '*.class')
"$TOOLS/d8" --min-api 21 --lib "$PLATFORM" --output build/light/dex "${TV_CLASSES[@]}"
cp build/light/base.apk build/light/unsigned.apk
(cd build/light/dex && zip -q -u ../unsigned.apk classes.dex)
"$TOOLS/zipalign" -f 4 build/light/unsigned.apk build/light/aligned.apk
# The standard local debug certificate is sufficient for a private sideload build.
KEYSTORE="${TV_KEYSTORE:-$HOME/.android/debug.keystore}"
test -f "$KEYSTORE" || { echo "Missing signing keystore: $KEYSTORE" >&2; exit 1; }
"$TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out build/coding-companion-tv-1.0.40.apk build/light/aligned.apk
"$TOOLS/apksigner" verify --verbose build/coding-companion-tv-1.0.40.apk
"$TOOLS/aapt2" dump badging build/coding-companion-tv-1.0.40.apk
# Keep the wrapper free of native decoder libraries and within the package limit.
python3 - <<'PYSIZE'
import pathlib, zipfile
apk=pathlib.Path('build/coding-companion-tv-1.0.40.apk')
with zipfile.ZipFile(apk) as archive:
    assert not any(n.startswith('lib/') for n in archive.namelist()), 'Unexpected bundled native decoder'
assert apk.stat().st_size < 30_000_000, 'TV package exceeds the authorized 30 MB limit'
print('Lightweight APK bytes:', apk.stat().st_size)
PYSIZE
