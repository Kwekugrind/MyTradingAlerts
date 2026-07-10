name: V75 M15 SMA Alerts (LIVE)

on:
  schedule:
    - cron: "1,16,31,46 * * * *"
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: v75-m15-sma-alerts
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install deps
        run: npm install

      - name: Run alerts (LIVE)
        env:
          TG_BOT_TOKEN: ${{ secrets.TG_BOT_TOKEN }}
          TG_CHAT_ID: ${{ secrets.TG_CHAT_ID }}
        run: node alert.js

      - name: Save updated state.json (if changed)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

          # Rebase first to reduce push conflicts
          git pull --rebase

          if git diff --quiet; then
            echo "No state changes"
            exit 0
          fi

          git add state.json
          git commit -m "Update state"
          git push
