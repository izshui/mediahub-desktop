#!/bin/bash
# MediaHub macOS 打包脚本
# 特点：全程离线 —— 通过 --config.electronDist=node_modules/electron/dist 复用本地已下载的
#       Electron 运行时，不联网重新下载；产物做 ad-hoc 签名，本机可直接运行。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP_NAME="MediaHub"
VERSION="$(node -p "require('./package.json').version")"
OUT="$ROOT/dist"
APP="$OUT/mac/$APP_NAME.app"
BUILDER="$ROOT/node_modules/.bin/electron-builder"

# 规避宿主环境的 fs 代理：部分 IDE/沙箱会把 .asar 视为"包"而拒绝复制，
# 导致 electron-builder 拷贝 Electron 运行时（内含 default_app.asar）失败。
export NODE_OPTIONS=""
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ ! -x "$BUILDER" ]; then
  echo "✗ 未找到 electron-builder，请先执行 npm install" >&2
  exit 1
fi
if [ ! -d "$ROOT/node_modules/electron/dist/Electron.app" ]; then
  echo "✗ 未找到本地 Electron 运行时（node_modules/electron/dist），请先执行 node node_modules/electron/install.js" >&2
  exit 1
fi

echo "==> 1/4 生成 app bundle（复用本地 Electron 运行时，不联网）"
rm -rf "$OUT/mac"
"$BUILDER" --mac --x64 --dir --publish never --config.electronDist=node_modules/electron/dist

if [ ! -d "$APP" ]; then
  echo "✗ 未生成 $APP" >&2
  exit 1
fi

echo "==> 2/4 ad-hoc 签名（无开发者证书时的本机可运行签名）"
codesign --force --deep --sign - "$APP"

echo "==> 3/4 打包 zip"
rm -f "$OUT/$APP_NAME-$VERSION-mac-x64.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$APP_NAME-$VERSION-mac-x64.zip"

echo "==> 4/4 制作 dmg（内含 /Applications 拖拽安装快捷方式）"
rm -f "$OUT/$APP_NAME-$VERSION-mac-x64.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT/$APP_NAME-$VERSION-mac-x64.dmg"
rm -rf "$STAGE"

echo "==> 打包完成"
ls -lh "$OUT" | grep -E '\.(dmg|zip)$'
echo
echo "本机安装：open dist/$APP_NAME-$VERSION-mac-x64.dmg"
echo "分发给别人时，对方首次打开需执行：xattr -rd com.apple.quarantine /Applications/$APP_NAME.app"
