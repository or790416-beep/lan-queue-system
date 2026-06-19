#!/usr/bin/env bash
# scripts/generate-audio.sh
# 一次產生所有叫號語音檔(在 macOS 本機執行;需要內建 say 與 ffmpeg)
set -euo pipefail

OUT_DIR="public/audio"
VOICE="Meijia"      # zh-TW 女聲;可用 `say -v '?' | grep -i zh` 查可用語音
MAX_NUMBER=200      # 號碼上限,依實際考生人數調整
COUNTERS=(1 2)

mkdir -p "$OUT_DIR"
for c in "${COUNTERS[@]}"; do
  for ((n=1; n<=MAX_NUMBER; n++)); do
    text="室內配線叫號，${n}號請到${c}號櫃檯辦理"
    aiff="$OUT_DIR/call-${n}-${c}.aiff"
    say -v "$VOICE" "$text" -o "$aiff"
    ffmpeg -y -loglevel error -i "$aiff" -ac 1 -codec:a libmp3lame -qscale:a 5 "$OUT_DIR/call-${n}-${c}.mp3"
    rm -f "$aiff"
  done
done
echo "完成:$OUT_DIR 共 $(( MAX_NUMBER * ${#COUNTERS[@]} )) 個 mp3"
