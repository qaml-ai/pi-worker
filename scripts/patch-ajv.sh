#!/bin/sh
# Patches @mariozechner/pi-ai to handle ajv.compile() failing in restricted
# runtimes (Cloudflare Workers, etc.). Safe to run multiple times.
# Unnecessary once https://github.com/badlogic/pi-mono/pull/2396 is merged.

FOUND=0

for FILE in $(find . -path "*/@mariozechner/pi-ai/dist/utils/validation.js" -not -path "./.git/*" 2>/dev/null); do
  if grep -q "may throw in restricted runtimes" "$FILE" 2>/dev/null; then
    echo "ajv patch already applied: $FILE"
    FOUND=1
    continue
  fi

  sed -i.bak \
    's|// Compile the schema|// Compile the schema — may throw in restricted runtimes (e.g. Workers)|; s|const validate = ajv.compile(tool.parameters);|let validate; try { validate = ajv.compile(tool.parameters); } catch { return toolCall.arguments; }|' \
    "$FILE" && rm -f "${FILE}.bak"

  echo "ajv patch applied: $FILE"
  FOUND=1
done

if [ "$FOUND" = "0" ]; then
  echo "pi-ai not installed, skipping ajv patch"
fi
