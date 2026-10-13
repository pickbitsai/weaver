# Codex host contract

Verified for Weaver V1-D on 2026-10-13 against installed `codex-cli 0.160.1`.
This records the documentation and local probes used for the implementation.
The tests use synthetic executable fixtures; no test needs a real account.

## 1. Hooks, payloads, decisions, and trust

Codex discovers JSON hook files beside active config layers: user
`$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`) and project
`<book>/.codex/hooks.json`. Inline `[hooks]` in the corresponding `config.toml`
is another supported representation. Multiple sources merge. Project layers
require workspace trust; each non-managed hook then requires trust of its
current definition hash through `/hooks`.

Weaver installs this shape, with separate shell and patch handlers:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^apply_patch$",
      "hooks": [{ "type": "command", "command": "npx --no-install weaver hook pre --host codex" }]
    }],
    "PostToolUse": [{
      "matcher": "^apply_patch$",
      "hooks": [{ "type": "command", "command": "npx --no-install weaver hook post --host codex" }]
    }]
  }
}
```

The shell pre-hook matches `^Bash$` and invokes `weaver hook shell --host codex`.
These are synchronous hooks: background hooks cannot deny an action.

Input is one JSON object on stdin. Shared fields are `session_id`,
`transcript_path` (nullable), `cwd`, `hook_event_name`, and `model`.
Event-specific fields documented by OpenAI:

| Event | Additional input |
| --- | --- |
| `SessionStart` | `source`: startup, resume, clear, compact |
| `SessionEnd` | `reason`: currently other |
| `PreToolUse` | `turn_id`, `tool_name`, `tool_use_id`, `tool_input` |
| `PermissionRequest` | `turn_id`, `tool_name`, `tool_input`; optional description inside tool input |
| `PostToolUse` | The pre-tool fields plus `tool_response` |
| `PreCompact`, `PostCompact` | `turn_id`, `trigger`: manual or auto |
| `UserPromptSubmit` | `turn_id`, `prompt` |
| `SubagentStart` | `turn_id`, `agent_id`, `agent_type` |
| `SubagentStop` | `turn_id`, `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` |
| `Stop` | `turn_id`, `stop_hook_active`, `last_assistant_message` |
| `Interrupt` | `turn_id` |

`permission_mode` is also present for session start, the three tool events,
prompt submit, subagent start/stop, stop, and interrupt. Weaver uses only
pre/post tool events. Shell/unified exec input is normalized to
`tool_name: "Bash"`, `tool_input.command: "the shell command"`. Patches use
`tool_name: "apply_patch"`, `tool_input.command: "*** Begin Patch\n..."`.
`Edit` and `Write` are matcher aliases; the payload still says `apply_patch`.

To deny before execution, Weaver exits zero and writes:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "That is the author's decision."
  }
}
```

Codex also supports `decision: "block"` with `reason`, or exit 2 with the
reason on stderr. `additionalContext` inside the event-specific output sends
context to the model. A post-tool block supplies feedback but cannot undo the
completed edit. Codex rejects `suppressOutput` on a pre-tool response, so the
Codex adapter does not return Claude's compatibility field.

Source: [OpenAI Hooks documentation](https://learn.chatgpt.com/docs/hooks).
Local evidence: `codex features list` reported `hooks stable true`;
`codex app-server generate-json-schema --out <temp>` enumerated all twelve
events and trust statuses `managed`, `untrusted`, `trusted`, `modified`.
A temporary `CODEX_HOME`, trusted synthetic book, and `hooks/list` RPC returned
the project hook with `source: "project"`, its source path and hash, and
`trustStatus: "untrusted"`. This confirms that workspace trust alone is not
hook trust. Doctor asks this API instead of reverse-engineering the trust file.
The probe never approves or changes a hook.

## 2. Command rules

Project rules are supported: `<book>/.codex/rules/*.rules`, beside the trusted
project config layer. User rules live under `$CODEX_HOME/rules/*.rules`.
`prefix_rule` decisions are exactly `allow`, `prompt`, and `forbidden`;
the most restrictive matching decision wins. These command policies primarily
control execution outside the sandbox; the shell hook is the first guard.

Source: [OpenAI Rules documentation](https://developers.openai.com/codex/rules).
Local evidence: `codex exec --help` describes `--ignore-rules` as skipping user
and project rules. `codex execpolicy check --rules <generated-weaver.rules>`
returned `forbidden` for `git commit`, `npx --no-install weaver approve`, and
`npm install`; `git status` matched no forbidden rule. This exercised the
installed CLI's Starlark parser, including union patterns.

No user rules installation is needed. `hooks install --user-rules` is an
explicit optional global copy; it never edits the user's `config.toml`.

## 3. Packet invocation

The adapter supplies the full prompt on stdin, conceptually:

```text
codex exec [host.args...] --sandbox read-only --ephemeral --skip-git-repo-check -c model_reasoning_effort=medium -c model_provider=openai -c forced_login_method=chatgpt -o <temporary-answer-file> -
```

The final `-` selects stdin as the prompt. The final answer comes only from the
output file, even if stdout contains logs or other text. Each attempt gets a
new temporary directory; cleanup follows success, failure, or timeout.
`--ephemeral` prevents session rollout persistence, not every operational log.
`host.reasoning_effort`, `args`, and `timeout_seconds` configure each call.
The model must support the selected effort. `--output-schema` exists but is
not required: Weaver's packets include Markdown and fenced JSON and already
have validation and a repair round.

Sources: installed `codex exec --help`,
[non-interactive mode](https://developers.openai.com/codex/noninteractive), and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The fake Codex executable checks the flags, reads stdin, emits stdout noise,
writes `-o`, and supports malformed answers and real process timeouts.

Weaver does not pass `--ignore-rules` or `--dangerously-bypass-hook-trust`.
The latter exists in 0.160.1 but bypasses the author's trust step; it is not a
substitute for installing and trusting the guards.

## 4. Authentication and billing

`CODEX_API_KEY` overrides saved authentication for `codex exec`. `OPENAI_API_KEY`
is the conventional OpenAI key variable and can supply API-key login or a
configured provider. Both are removed, case-insensitively, along with
`ANTHROPIC_API_KEY`. Packet calls pin `model_provider=openai` and
`forced_login_method=chatgpt` to require the supported subscription login.
An author with stored API authentication must sign in with ChatGPT first.

Custom model providers can name **any** environment variable in `env_key`, or
use `experimental_bearer_token`/command-backed credentials. There is no finite
list of custom provider secret names to strip. Arbitrary API/gateway provider
configuration is outside Weaver's supported subscription path; environment
stripping alone cannot guarantee billing behavior for custom configurations.
`CODEX_HOME` selects config/auth storage; it is deliberately preserved so the
author's existing ChatGPT login remains available.

Sources: [non-interactive authentication](https://developers.openai.com/codex/noninteractive#authenticate-in-automation),
[authentication](https://developers.openai.com/codex/auth), and
[provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
Local `codex login status` reported ChatGPT login. No credentials were read or
printed and no real model request was needed for the probes.

## Limits and Windows

Local hooks apply to local Codex sessions, including local desktop work.
OpenAI explicitly excludes local hook files from Work Cloud with local
computer access; Weaver cannot provide this protection on that surface.
Use a local session. See [hook deployment limits](https://learn.chatgpt.com/docs/hooks).

On Windows, doctor identifies a configured `read-only` sandbox and explains
how to start interactive writing with `codex --sandbox workspace-write`.
The documentation does not establish that a particular Windows sandbox
backend universally breaks file edits in 0.160.1; Weaver does not invent such
a diagnosis or recommend disabling the sandbox. Current Windows docs discuss
MXC support that depends on OS capabilities and newer CLI versions; those
instructions are not assumed to work on 0.160.1. See
[Windows sandbox documentation](https://developers.openai.com/codex/windows).

Pattern matching and same-user hooks can be bypassed. Unsupported tools,
hook errors, or an unmatchable patch can escape checks. The settings seal,
doctor, and approved history are the audit trail. Doctor blocks hosts listed
in `project.hosts` if their required guards are absent, disabled, or (for
Codex) untrusted/unverifiable. Other hosts are reported without blocking.
