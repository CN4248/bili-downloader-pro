#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 纯命令行构建 BiliDL.apk（不需要 Gradle / Android Studio）
#
#   依赖：Android SDK build-tools 34.0.0 + platform android-34 + JDK 17/21
#   用法：bash android/build_apk.sh [输出路径]
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/34.0.0}"
ANDROID_JAR="${ANDROID_JAR:-$SDK/platforms/android-34/android.jar}"
JAVA_HOME="${JAVA_HOME:-/opt/jdk21}"
OUT="${1:-$ROOT/../dist/BiliDL.apk}"
KEYSTORE="${KEYSTORE:-$ROOT/../build/bilidl.keystore}"
KS_PASS="${KS_PASS:-bilidl2024}"
KS_ALIAS="${KS_ALIAS:-bilidl}"

for tool in "$BUILD_TOOLS/aapt2" "$BUILD_TOOLS/d8" "$BUILD_TOOLS/zipalign" \
            "$BUILD_TOOLS/apksigner" "$JAVA_HOME/bin/javac" "$JAVA_HOME/bin/keytool"; do
    [ -x "$tool" ] || { echo "缺少工具：$tool" >&2; exit 1; }
done
[ -f "$ANDROID_JAR" ] || { echo "缺少 android.jar：$ANDROID_JAR" >&2; exit 1; }

export PATH="$JAVA_HOME/bin:$PATH"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/compiled" "$WORK/gen" "$WORK/classes" "$WORK/dex" "$(dirname "$OUT")"

echo "[1/6] 编译资源"
"$BUILD_TOOLS/aapt2" compile --dir "$ROOT/res" -o "$WORK/compiled/res.zip"

echo "[2/6] 链接清单与资源"
"$BUILD_TOOLS/aapt2" link \
    -o "$WORK/base.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$ROOT/AndroidManifest.xml" \
    --java "$WORK/gen" \
    --min-sdk-version 21 \
    --target-sdk-version 34 \
    "$WORK/compiled/res.zip"

echo "[3/6] 编译 Java"
# 注意：-classpath 而不是 -bootclasspath，否则 lambda 找不到 LambdaMetafactory
"$JAVA_HOME/bin/javac" -nowarn -source 8 -target 8 \
    -classpath "$ANDROID_JAR" -d "$WORK/classes" \
    $(find "$ROOT/src" "$WORK/gen" -name '*.java')

echo "[4/6] dex"
# d8 内部会调 java，必须让 java 在 PATH 里
"$BUILD_TOOLS/d8" --lib "$ANDROID_JAR" --min-api 21 --release \
    --output "$WORK/dex" $(find "$WORK/classes" -name '*.class')

echo "[5/6] 打包 + 对齐"
cp "$WORK/base.apk" "$WORK/unaligned.apk"
( cd "$WORK/dex" && zip -q -X "$WORK/unaligned.apk" classes.dex )
"$BUILD_TOOLS/zipalign" -f -p 4 "$WORK/unaligned.apk" "$WORK/aligned.apk"

echo "[6/6] 签名"
if [ ! -f "$KEYSTORE" ]; then
    echo "     生成自签名证书：$KEYSTORE"
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KEYSTORE" \
        -storepass "$KS_PASS" -keypass "$KS_PASS" -alias "$KS_ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=BiliDL, OU=BiliDL, O=BiliDL, L=CN, ST=CN, C=CN" >/dev/null 2>&1
fi
"$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
    --out "$OUT" "$WORK/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --print-certs "$OUT" | head -3

echo "✅ 已生成：$OUT"
"$BUILD_TOOLS/aapt2" dump badging "$OUT" | head -3
