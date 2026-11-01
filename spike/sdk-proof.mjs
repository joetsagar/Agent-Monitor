// SDK mechanics proof: one real session, scripted responses to verify
// question answering, permission approve and permission deny separately.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";

const cwd = process.argv[2];
mkdirSync(cwd, { recursive: true });
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(CLAUDE|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)/.test(k)) continue;
  env[k] = v;
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
let bashCount = 0;
const q = query({
  prompt:
    "Step 1: use the AskUserQuestion tool to ask me which filename to use, offering options 'alpha.txt' and 'beta.txt'. " +
    "Step 2: use the Bash tool to run exactly: echo hello > <chosen filename>. " +
    "Step 3: use the Bash tool to run exactly: rm <chosen filename>. If a step is denied, do not retry it; just report what happened in one sentence.",
  options: {
    cwd, env, model: "haiku", settingSources: [], permissionMode: "default",
    tools: ["Bash", "AskUserQuestion"],
    canUseTool: async (toolName, input, opts) => {
      log("CAN_USE_TOOL", toolName, opts.toolUseID, JSON.stringify(input).slice(0, 300), "title=", opts.title);
      if (toolName === "AskUserQuestion") {
        const qn = input.questions[0];
        return { behavior: "allow", updatedInput: { questions: input.questions, answers: { [qn.question]: "beta.txt" } } };
      }
      bashCount++;
      if (bashCount === 1) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "User denied this command from Agent Monitor proof." };
    },
  },
});
for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") log("INIT model=", m.model, "apiKeySource=", m.apiKeySource, "version=", m.claude_code_version, "session=", m.session_id);
  else if (m.type === "assistant") for (const b of m.message.content) log("ASSISTANT", b.type, b.type === "text" ? b.text : b.type === "tool_use" ? b.name + " " + JSON.stringify(b.input).slice(0, 200) : "");
  else if (m.type === "user") for (const b of (Array.isArray(m.message.content) ? m.message.content : [])) if (b.type === "tool_result") log("TOOL_RESULT", b.tool_use_id, "is_error=", !!b.is_error, JSON.stringify(b.content).slice(0, 200));
  else if (m.type === "result") log("RESULT", m.subtype, "is_error=", m.is_error, "turns=", m.num_turns, "cost_usd(sdk est)=", m.total_cost_usd, "usage=", JSON.stringify(m.usage).slice(0, 300), "models=", Object.keys(m.modelUsage));
  else log("MSG", m.type, m.subtype ?? "");
}
