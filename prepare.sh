#!/usr/bin/env bash
# يجهّز مشروع Node (assets) ومكتبات libnode و tsfunnel قبل بناء الـ APK. يعمل في GitHub Actions.
set -euo pipefail
cd "$(dirname "$0")"
A=android/app

echo "== 1/3 مشروع Node =="
rm -rf $A/src/main/assets/node; mkdir -p $A/src/main/assets
cp -r server $A/src/main/assets/node
(cd $A/src/main/assets/node && npm install --omit=dev --no-audit --no-fund)

echo "== 2/3 libnode (nodejs-mobile) =="
rm -rf $A/libnode /tmp/nm; mkdir -p /tmp/nm
gh release download --repo nodejs-mobile/nodejs-mobile --pattern '*android.zip' --dir /tmp/nm
unzip -q /tmp/nm/*android.zip -d /tmp/nm/x
find /tmp/nm/x -maxdepth 3 | head -30
SRC="$(dirname "$(find /tmp/nm/x -name node.h | head -1)")"          # .../include/node
ROOT="$(dirname "$(dirname "$SRC")")"                                   # الجذر
BIN="$(dirname "$(dirname "$(find /tmp/nm/x -path '*arm64-v8a*' -name libnode.so | head -1)")")"
mkdir -p $A/libnode/include; cp -r "$SRC" $A/libnode/include/node
cp -r "$BIN" $A/libnode/bin
ls $A/libnode/bin; ls $A/libnode/bin/arm64-v8a

echo "== 3/3 tsfunnel (Go) =="
rm -rf $A/tsfunnel-libs
(cd tsfunnel && rm -f go.sum && go get tailscale.com@latest golang.org/x/crypto/x509roots/fallback && go mod tidy)
mkdir -p $A/tsfunnel-libs/arm64-v8a $A/tsfunnel-libs/armeabi-v7a
(cd tsfunnel && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -buildmode=pie -o ../$A/tsfunnel-libs/arm64-v8a/libtsfunnel.so .)
(cd tsfunnel && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "-s -w" -buildmode=pie -o ../$A/tsfunnel-libs/armeabi-v7a/libtsfunnel.so .)
ls -la $A/tsfunnel-libs/*
