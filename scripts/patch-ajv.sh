#!/bin/sh
# Patches @mariozechner/pi-ai to handle ajv.compile() failing in restricted
# runtimes (Cloudflare Workers, etc.). Safe to run multiple times.
# Unnecessary once https://github.com/badlogic/pi-mono/pull/2396 is merged.

FILE="node_modules/@mariozechner/pi-ai/dist/utils/validation.js"

if [ ! -f "$FILE" ]; then
  echo "pi-ai not installed, skipping ajv patch"
  exit 0
fi

if grep -q "may throw in restricted runtimes" "$FILE" 2>/dev/null; then
  echo "ajv patch already applied"
  exit 0
fi

sed -i.bak \
  's|// Compile the schema|// Compile the schema — may throw in restricted runtimes (e.g. Workers)|; s|const validate = ajv.compile(tool.parameters);|let validate; try { validate = ajv.compile(tool.parameters); } catch { return toolCall.arguments; }|' \
  "$FILE" && rm -f "${FILE}.bak"

echo "ajv patch applied to $FILE"
