#!/usr/bin/env bash
# scripts/generate-audio.sh
# 在 macOS 本機執行;需要內建 say 與 ffmpeg
set -euo pipefail

OUT_DIR="public/audio"
VOICE="Meijia"
MAX_NUMBER=200
COUNTERS=(1 2)

mkdir -p "$OUT_DIR"

# 前綴提示(單獨一個檔,給後台「室內配線叫號」按鈕用)
say -v "$VOICE" "室內配線叫號" -o "$OUT_DIR/prefix.aiff"
ffmpeg -y -loglevel error -i "$OUT_DIR/prefix.aiff" -ac 1 -codec:a libmp3lame -qscale:a 5 "$OUT_DIR/prefix.mp3"
rm -f "$OUT_DIR/prefix.aiff"

# 平常叫號(無前綴)
for c in "${COUNTERS[@]}"; do
  for ((n=1; n<=MAX_NUMBER; n++)); do
    text="${n}號請到${c}號櫃檯辦理"
    aiff="$OUT_DIR/call-${n}-${c}.aiff"
    say -v "$VOICE" "$text" -o "$aiff"
    ffmpeg -y -loglevel error -i "$aiff" -ac 1 -codec:a libmp3lame -qscale:a 5 "$OUT_DIR/call-${n}-${c}.mp3"
    rm -f "$aiff"
  done
done

echo "完成:$OUT_DIR 共 $(( MAX_NUMBER * ${#COUNTERS[@]} + 1 )) 個 mp3"
