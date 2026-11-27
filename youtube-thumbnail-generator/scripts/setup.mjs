#!/usr/bin/env node
// Checks (and optionally fixes) the Seclai agent this app runs, and the
// .env values setup can fill in itself.
//
//   npm run setup                 # check only, change nothing
//   npm run setup -- --apply      # declare `session_id`; generate SESSION_SECRET
//   npm run setup -- --create     # create the agent from the gallery, save its id
//                                 # to .env, then --apply
//
// The app needs two things from the agent:
//   1. A trigger that accepts images (the gallery agent's `images` slot).
//   2. `session_id` declared as a run metadata key: the API refuses a run with
//      an undeclared custom key, and the chat-turn steps key the conversation on it.
// The gallery agent already streams its reply, so the steps aren't checked.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Seclai } from "@seclai/sdk";

const TEMPLATE = "youtube_thumbnail_chat";
const ENV_FILE = new URL("../.env", import.meta.url);

const args = new Set(process.argv.slice(2));
const create = args.has("--create");
const apply = create || args.has("--apply");

const apiKey = process.env.SECLAI_API_KEY;
let agentId = process.env.SECLAI_AGENT_ID;

if (!apiKey || apiKey === "your_api_key_here") {
  console.error(
    "SECLAI_API_KEY is not set.\n\n" +
      "  1. cp .env.example .env\n" +
      "  2. Sign in at https://seclai.com and open API Keys in the sidebar\n" +
      "  3. Click Create API key and paste it into .env as SECLAI_API_KEY (it's only shown once)\n",
  );
  process.exit(1);
}

const client = new Seclai({ apiKey, fetch: (...a) => globalThis.fetch(...a) });
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ✗ ${msg}`);
let problems = 0;

// ─── Session secret ─────────────────────────────────────────────────────────
// Only an unset or placeholder secret is replaced: a new one signs out every
// browser, so an existing secret is left alone.

const sessionSecret = process.env.SESSION_SECRET;
if (sessionSecret && sessionSecret !== "change_me") {
  ok("SESSION_SECRET is set");
} else if (apply) {
  if (saveEnv("SESSION_SECRET", randomBytes(32).toString("hex"))) {
    ok("Generated SESSION_SECRET and saved it to .env");
  } else {
    problems++;
    warn("Couldn't write .env. Set SESSION_SECRET in it yourself (for example `openssl rand -hex 32`).");
  }
} else {
  problems++;
  warn("SESSION_SECRET isn't set. Run with --apply to generate one.");
}

// ─── 0. Create from the gallery ─────────────────────────────────────────────

if (create) {
  if (agentId) {
    console.error(`SECLAI_AGENT_ID is already set (${agentId}). Remove it from .env to create a new agent.`);
    process.exit(1);
  }
  console.log(`Creating an agent from the gallery template "${TEMPLATE}"…`);
  const agent = await client.createAgent({
    name: "YouTube Thumbnail Chat",
    agent_template: TEMPLATE,
    create_missing_resources: true,
  });
  agentId = agent.id;
  ok(`Created agent ${agent.id} (with its conversation memory bank)`);
  // Save the id right away, so a failed check below can't lead to a second --create.
  if (saveEnv("SECLAI_AGENT_ID", agentId)) {
    ok("Saved SECLAI_AGENT_ID to .env");
  } else {
    warn(`Couldn't write .env. Add this to it yourself:\n\n      SECLAI_AGENT_ID=${agentId}\n`);
  }
}

if (!agentId) {
  console.error(
    "SECLAI_AGENT_ID is not set.\n\n" +
      "Either create the agent here:   npm run setup -- --create\n" +
      'or in the Seclai app: Agents → New → gallery → "YouTube thumbnail", then paste its id into .env.\n',
  );
  process.exit(1);
}

console.log(`\nChecking agent ${agentId}`);
const agent = await client.getAgent(agentId);
ok(`Found "${agent.name}" (trigger: ${agent.trigger_type ?? "unknown"})`);

// ─── 1. Accepted images ─────────────────────────────────────────────────────

const refs = await client.getAgentAttachmentReferences(agentId);
const imageSlot = (refs.accepted_attachments ?? []).find((s) =>
  (s.content_types ?? []).some((t) => t.startsWith("image/")),
);
if (imageSlot) {
  ok(`Accepts images: slot "${imageSlot.name}", up to ${imageSlot.max ?? "any number of"} per message`);
} else {
  problems++;
  warn("The trigger doesn't accept images. Use the gallery agent, or add an image attachment slot to its trigger.");
}

// ─── 2. session_id metadata key ─────────────────────────────────────────────

if (!agent.trigger_id) {
  problems++;
  warn("The agent has no trigger id; can't check its metadata keys.");
} else {
  const keys = await client.getMetadataKeys(agentId, agent.trigger_id);
  if (keys.metadata_keys.some((k) => k.key === "session_id")) {
    ok("Declares the `session_id` metadata key");
  } else if (apply) {
    await client.setMetadataKeys(agentId, agent.trigger_id, {
      metadata_keys: [...keys.metadata_keys, { key: "session_id", origin: "custom", required: false }],
    });
    ok("Declared the `session_id` metadata key");
  } else {
    problems++;
    warn("`session_id` isn't a declared metadata key, so runs from this app would be refused. Run with --apply.");
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log("");
if (problems) {
  console.log(`${problems} problem${problems === 1 ? "" : "s"} found.`);
  process.exit(1);
}
console.log("The agent is ready. Start the app with `npm run dev`.");

// Sets `key` in .env: replaces its existing line (the .env.example template has
// one for each key), or appends it. Creates .env if there isn't one.
function saveEnv(key, value) {
  try {
    const line = `${key}=${value}`;
    const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
    const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
    const next = pattern.test(text)
      ? text.replace(pattern, line)
      : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
    writeFileSync(ENV_FILE, next);
    return true;
  } catch {
    return false;
  }
}
