/**
 * Daily Idea Scout
 *
 * Pulls trending startup / product ideas from Hacker News and Product Hunt,
 * summarises them with an NVIDIA NIM model, and posts the digest to Slack.
 *
 * (Reddit was dropped: as of Nov 2025 Reddit closed self-service API app
 * creation, so a new OAuth app now requires manual approval — not viable
 * for a small script.)
 *
 * Run locally:      node scout.js
 * Run on schedule:  see .github/workflows/scout.yml
 *
 * Node 20+ required (uses built-in fetch).
 */

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

// NOTE: this endpoint is scheduled for deprecation on 2026-10-02 per NVIDIA's
// model page. Check build.nvidia.com closer to that date for the replacement
// model id and update NVIDIA_MODEL below (or via env var) when it changes.
const NVIDIA_MODEL =
  process.env.NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b";

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;
const PRODUCT_HUNT_TOKEN = process.env.PRODUCT_HUNT_TOKEN; // optional

// Reddit was dropped: as of Nov 2025, Reddit closed self-service API app
// creation — new OAuth apps now require manual approval under their
// "Responsible Builder Policy," so this isn't viable for a small script.

// ---------------------------------------------------------------- helpers

function requireEnv() {
  const missing = ["NVIDIA_API_KEY", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

async function getJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

// Sources are fetched independently — one failing source shouldn't kill the run.
async function safely(label, fn) {
  try {
    const items = await fn();
    console.log(`  ${label}: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`  ${label} failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------- sources

async function fetchHackerNews() {
  const ids = (
    await getJSON("https://hacker-news.firebaseio.com/v0/topstories.json")
  ).slice(0, 30);

  const stories = await Promise.all(
    ids.map((id) =>
      getJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(
        () => null
      )
    )
  );

  return stories
    .filter((s) => s && s.title)
    .map((s) => ({
      source: "Hacker News",
      title: s.title,
      url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
      blurb: "",
      score: s.score || 0,
    }));
}

async function fetchProductHunt() {
  if (!PRODUCT_HUNT_TOKEN) return [];

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = `
    query DailyLaunches($since: DateTime!) {
      posts(order: VOTES, postedAfter: $since, first: 20) {
        edges { node { name tagline url votesCount } }
      }
    }
  `;

  const json = await getJSON("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PRODUCT_HUNT_TOKEN}`,
    },
    body: JSON.stringify({ query, variables: { since } }),
  });

  return (json.data?.posts?.edges || []).map(({ node }) => ({
    source: "Product Hunt",
    title: node.name,
    url: node.url,
    blurb: node.tagline || "",
    score: node.votesCount || 0,
  }));
}

// ---------------------------------------------------------------- summarise

async function summarise(items) {
  const corpus = items
    .map(
      (it, i) =>
        `${i + 1}. [${it.source}] ${it.title}\n   ${it.blurb}\n   ${it.url}`
    )
    .join("\n\n");

  const prompt = `You are a startup scout. Below are raw posts from the last 24 hours across Hacker News and Product Hunt.

Pick the 8-12 most genuinely interesting startup ideas, product launches or emerging trends. Skip memes, drama, hiring posts, and low-effort self-promotion.

For each pick write exactly three lines:
*<short idea name>*
<one sentence on why it matters>
<the source URL>

Use Slack formatting (*bold*, not # headers). No preamble, no closing remarks.

RAW POSTS:
${corpus}`;

  const json = await getJSON(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 2000,
    }),
  });

  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("No content returned from NVIDIA API");
  return text.trim();
}

// ---------------------------------------------------------------- slack

// Slack truncates long messages, so split into ~3500 char chunks
// and thread the continuations under the first message.
function chunk(text, size = 3500) {
  const parts = [];
  let current = "";

  for (const line of text.split("\n")) {
    if ((current + line).length > size) {
      parts.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) parts.push(current.trim());

  return parts;
}

async function slackPost(text, threadTs) {
  const json = await getJSON("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_TOKEN}`,
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });

  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
  return json.ts;
}

async function postDigest(digest) {
  const date = new Date().toISOString().slice(0, 10);
  const parts = chunk(digest);

  const rootTs = await slackPost(`*Daily Idea Scout — ${date}*\n\n${parts[0]}`);
  for (const part of parts.slice(1)) {
    await slackPost(part, rootTs);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  requireEnv();

  console.log("Fetching sources...");
  const [hn, ph] = await Promise.all([
    safely("Hacker News", fetchHackerNews),
    safely("Product Hunt", fetchProductHunt),
  ]);

  const items = [...hn, ...ph];
  if (!items.length) throw new Error("No items collected from any source");
  console.log(`Collected ${items.length} items total.`);

  console.log(`Summarising with ${NVIDIA_MODEL}...`);
  const digest = await summarise(items);

  console.log("Posting to Slack...");
  await postDigest(digest);

  console.log("Done.");
}

main().catch((err) => {
  console.error("Scout failed:", err.message);
  process.exit(1);
});