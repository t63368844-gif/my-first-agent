#!/bin/bash
# Загрузка skills/*.md в REMOTE KV (production)
for f in skills/*.md; do
  name=$(basename "$f" .md)
  echo "Uploading: $name → remote SKILLS..."
  npx wrangler kv key put --binding=SKILLS --remote "$name" --path "$f"
  echo "✅ uploaded: $name"
done
