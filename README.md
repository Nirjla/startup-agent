# Daily Idea Scout

A script that pulls trending startup/product ideas from Hacker News and Product Hunt,
summarizes them with an NVIDIA NIM model, and posts the digest to Slack.

## Features

- Fetches top stories from Hacker News (last day)
- Fetches recent launches from Product Hunt (optional, requires token)
- Uses NVIDIA's Nemotron model to summarize and pick the top ideas
- Posts the digest to a Slack channel
- Can be run locally or scheduled via GitHub Actions

## Setup

1. Clone the repository
2. Install Node.js 20+
3. Create a `.env` file with the following variables:
   - NVIDIA_API_KEY: from build.nvidia.com
   - SLACK_BOT_TOKEN: from your Slack app (xoxb-...)
   - SLACK_CHANNEL_ID: the Slack channel ID (e.g., C01...)
   - PRODUCT_HUNT_TOKEN: optional, from Product Hunt API

4. Run locally: `node scout.js`

## GitHub Actions

The workflow `.github/workflows/scout.yml` runs the script daily at 01:15 UTC (07:00 Kathmandu).
It can also be triggered manually from the Actions tab.

## Notes

- Reddit was removed as of Nov 2025 due to API restrictions.
- The NVIDIA model endpoint is scheduled for deprecation on 2026-10-02; check build.nvidia.com for updates.

## License

MIT