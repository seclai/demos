#!/usr/bin/env node
// Checks (and optionally fixes) the Seclai agent this app runs.
//
//   npm run setup                 # check only, change nothing
//   npm run setup -- --apply      # make the agent stream, declare `session_id`
//   npm run setup -- --create     # create the agent from the gallery, then --apply
//
// The app needs three things from the agent:
//   1. A trigger that accepts images (the gallery agent's `images` slot).
//   2. `session_id` declared as a run metadata key: the API refuses a run with
//      an undeclared custom key, and the chat-turn steps key the conversation on it.
//   3. A `streaming_result` step under the `prompt_call`, so the reply streams
//      token by token. The gallery agent ships with `display_result`, which
//      only returns the reply at the end.

import { Seclai, SeclaiAPIStatusError } from "@seclai/sdk";

const TEMPLATE = "youtube_thumbnail_chat";
const STREAMING_STEP = { step_type: "streaming_result", id: "stream_reply", name: "Stream the reply" };

const args = new Set(process.argv.slice(2));
const create = args.has("--create");
const apply = create || args.has("--apply");

const apiKey = process.env.SECLAI_API_KEY;
let agentId = process.env.SECLAI_AGENT_ID;

if (!apiKey || apiKey === "your_api_key_here") {
  console.error(
    "SECLAI_API_KEY is not set.\n\n" +
      "  1. cp .env.example .env\n" +
      "  2. Create a key at https://app.seclai.com → Settings → API Keys\n" +
      "  3. Paste it into .env as SECLAI_API_KEY\n",
  );
  process.exit(1);
}

const client = new Seclai({ apiKey, fetch: (...a) => globalThis.fetch(...a) });
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ✗ ${msg}`);
let problems = 0;

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

// ─── 3. streaming_result ────────────────────────────────────────────────────

/** Finds the result step that is a direct child of a prompt_call. */
function findResultStep(node, parent = null) {
  if (!node || typeof node !== "object") return null;
  if (
    (node.step_type === "display_result" || node.step_type === "streaming_result") &&
    parent?.step_type === "prompt_call"
  ) {
    return { step: node, parent };
  }
  for (const child of node.child_steps ?? []) {
    const found = findResultStep(child, node);
    if (found) return found;
  }
  return null;
}

async function ensureStreaming(retry = true) {
  const { definition, change_id } = await client.getAgentDefinition(agentId);
  const found = findResultStep(definition);
  if (!found) {
    problems++;
    warn("No result step under a prompt_call was found; can't switch the agent to streaming.");
    return;
  }
  if (found.step.step_type === "streaming_result") {
    ok("Streams its reply (`streaming_result`)");
    return;
  }

  const { child_steps, ...before } = found.step;
  const after = { ...STREAMING_STEP, ...(child_steps ? { child_steps } : {}) };
  if (!apply) {
    problems++;
    warn("The reply arrives all at once (`display_result`). Run with --apply to make it stream:");
    console.log(`      - ${JSON.stringify(before)}\n      + ${JSON.stringify(STREAMING_STEP)}`);
    return;
  }

  const index = found.parent.child_steps.indexOf(found.step);
  found.parent.child_steps[index] = after;
  try {
    await client.updateAgentDefinition(agentId, { definition, expected_change_id: change_id });
    ok(`Switched "${before.name}" (display_result) to "${STREAMING_STEP.name}" (streaming_result)`);
  } catch (err) {
    if (retry && err instanceof SeclaiAPIStatusError && err.statusCode === 409) {
      console.log("  … the definition changed while we were editing it; reading it again");
      return ensureStreaming(false);
    }
    throw err;
  }
}

await ensureStreaming();

// ─── Summary ────────────────────────────────────────────────────────────────

console.log("");
if (create) {
  console.log(`Add this to .env:\n\n  SECLAI_AGENT_ID=${agentId}\n`);
}
if (problems) {
  console.log(`${problems} problem${problems === 1 ? "" : "s"} found.`);
  process.exit(1);
}
console.log("The agent is ready. Start the app with `npm run dev`.");
