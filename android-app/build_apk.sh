#!/usr/bin/env bash
# 纯命令行构建「独立运行版」BiliDL.apk（无需 Gradle / Android Studio）
# 依赖：Android SDK build-tools 34.0.0 + platform android-34 + JDK 17/21
# 注意（Pro 版）：Java 引擎目前只支持 B站。用本脚本打包出来的 APK 里，
# 网页界面会显示 YouTube 选项但后端不支持（/api/parse 会返回不支持），
# 需要先移植 Java 端 YouTube 解析（innertube player + 签名变换）再发布。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
BT="${BUILD_TOOLS:-$SDK/build-tools/34.0.0}"
AJ="${ANDROID_JAR:-$SDK/platforms/android-34/android.jar}"
JAVA_HOME="${JAVA_HOME:-/opt/jdk21}"
OUT="${1:-$ROOT/../dist/BiliDL.apk}"
KS="${KEYSTORE:-$ROOT/../build/bilidl.keystore}"
KS_PASS="${KS_PASS:-bilidl2024}"; KS_ALIAS="${KS_ALIAS:-bilidl}"
for t in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$JAVA_HOME/bin/javac"; do
  [ -x "$t" ] || { echo "缺少工具：$t" >&2; exit 1; }
done
export PATH="$JAVA_HOME/bin:$PATH"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/gen" "$WORK/classes" "$WORK/dex" "$(dirname "$OUT")"
echo "[1/5] 编译资源"
"$BT/aapt2" compile --dir "$ROOT/src/main/res" -o "$WORK/res.zip"
echo "[2/5] 链接资源与清单"
"$BT/aapt2" link -o "$WORK/base.apk" -I "$AJ" \
  --manifest "$ROOT/src/main/AndroidManifest.xml" --java "$WORK/gen" \
  -A "$ROOT/src/main/assets" --min-sdk-version 26 --target-sdk-version 34 "$WORK/res.zip"
echo "[3/5] 编译 Java"
"$JAVA_HOME/bin/javac" -nowarn -source 8 -target 8 -classpath "$ROOT/lib/json.jar:$AJ" -d "$WORK/classes" \
  $(find "$ROOT/src/main/java" "$WORK/gen" -name '*.java')
echo "[4/5] dex + 打包"
"$BT/d8" --lib "$AJ" --min-api 26 --release --output "$WORK/dex" $(find "$WORK/classes" -name '*.class')
cp "$WORK/base.apk" "$WORK/unaligned.apk"
( cd "$WORK/dex" && zip -q -X "$WORK/unaligned.apk" classes.dex )
"$BT/zipalign" -f -p 4 "$WORK/unaligned.apk" "$WORK/aligned.apk"
echo "[5/5] 签名"
[ -f "$KS" ] || "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -storepass "$KS_PASS" \
  -keypass "$KS_PASS" -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=BiliDL, OU=BiliDL, O=BiliDL, L=CN, ST=CN, C=CN" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$OUT" "$WORK/aligned.apk"
"$BT/apksigner" verify "$OUT" >/dev/null && echo "签名校验通过"
"$BT/aapt2" dump badging "$OUT" | head -2
ls -lh "$OUT"
