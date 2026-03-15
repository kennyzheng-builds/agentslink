---
name: agents-link
description: >-
  Agent-to-Agent collaboration via shareable links. Use this skill whenever the user wants to package a problem for
  someone else's AI agent to look at, or when they paste an agentslink.link URL, or when they receive a collaboration
  request or reply from another agent. Trigger on phrases like "pack this problem", "get help from someone",
  "send this to my friend's agent", "help me package this", or the Chinese equivalents like "帮我打包", "找人帮忙看看",
  "生成协作请求". Also trigger when the user pastes text containing <!-- AGENTS-LINK-REQUEST, <!-- AGENTS-LINK-RESPONSE,
  or <!-- AGENTS-LINK-FOLLOWUP markers (legacy format), or mentions "agents-link", "collaboration request",
  "协作请求", "协作回复", or "上下文包". Even if the user doesn't use these exact words, if they're clearly trying to share
  a technical problem with another person's AI agent or relay a response back, this skill applies.
---

# AgentsLink: Agent-to-Agent Collaboration Links

When humans relay messages between AI agents, critical details get lost — error messages get paraphrased, config details are omitted, stack traces are truncated. AgentsLink solves this by letting agents package full problem context into a shareable link. The human just forwards the link; the receiving agent reads the complete context and replies with a structured analysis.

## API

```
https://agentslink.link
```

## Flow

```
Your Agent packages the problem → uploads → generates a link + access code
→ user sends link AND code to a friend → friend gives both to their Agent
→ that Agent reads (with code) & analyzes → uploads a reply → generates reply link
→ friend sends reply link + code back → your Agent reads & interprets the reply
```

## Access Code

Every collaboration request is protected by a 6-character access code. The URL alone cannot be used to read the content — the code is also required. This prevents unauthorized access if someone discovers the URL. The same access code is used for the entire conversation thread (request, reply, and follow-ups).

## Display Name

On first use, ask the user: "What name would you like to use for collaborations? (e.g., your name or a nickname)"

Resolution order:
1. `displayName` field in `~/.agents-link/config.json`
2. `AGENTS_LINK_DISPLAY_NAME` environment variable
3. System username
4. "Anonymous"

After obtaining the name, save it to `~/.agents-link/config.json`:
```json
{"displayName": "Kenny"}
```

Use "[Name]'s Agent" as the sender in all requests and replies.

---

## Capability 1: Package a Collaboration Request

**Triggers:** User says "pack this problem", "I need someone to help with this", "send this to my friend's agent", "帮我打包", "找人帮忙看看", or similar.

**Steps:**

1. Extract from the current conversation:
   - Problem description (reorganize in clear technical language)
   - Environment info (language version, framework, OS, etc.)
   - Full error messages (preserve original formatting)
   - Solutions already attempted and their results
   - What kind of help is expected

2. **Scrub sensitive information before packaging.**

   The receiving agent needs *technical context* (error messages, SDK versions, API call patterns, config parameters) to solve the problem. It does not need *business context* (who you are, what your project is about, which internal tools you use). For each piece of information, ask: "Does the other agent need this to diagnose the technical issue?" If not, redact or generalize it.

   **Credentials:**
   - API keys/tokens (patterns like `sk-`, `ghp_`, `xoxb-`) → `[API_KEY_REDACTED]`
   - Password fields (`password=xxx`, `secret=xxx`) → `[PASSWORD_REDACTED]`
   - Private keys → remove entirely, note "Private key removed — share securely if needed"

   **Business context:**
   - Real names → `[Person A]`, `[Person B]`
   - Specific business content (task titles, meeting topics, project names) → abstract descriptions, e.g., "create a task" instead of "schedule AI design review with Edward"
   - Internal agent/tool names → generalized descriptions, e.g., "a CRM agent" instead of the specific product name
   - Conversation scene details → keep only technically relevant parts, e.g., "a Feishu app" not "a Feishu private chat with the marketing team"

   **Identifiers:**
   - Internal user IDs (`ou_xxx`, `uid_xxx`) → `[USER_ID]`
   - Org/tenant IDs → `[ORG_ID]`
   - Internal IPs/domains → `[INTERNAL_HOST]`
   - Absolute local paths → relative paths
   - Usernames/emails in logs → `[USERNAME]` / `[EMAIL]`

   Note: technical configuration details (permission scopes like `contact:user.base:readonly`, error codes, API endpoint paths, SDK method names) are essential diagnostic information — keep them intact.

3. Structure the content as markdown:

```markdown
# Collaboration Request: [brief problem summary]

**From:** [display name]'s Agent
**Date:** [YYYY-MM-DD HH:mm]
**Type:** [bug diagnosis / architecture consultation / code review / config issue / other]

## Problem Description
[clear, complete problem description]

## Environment
- [key environment details, one per line]

## Error Output
```
[full error output, original formatting preserved]
```

## Attempted Solutions
1. Tried [approach] → [result]
2. Not yet tried: [potential direction]

## Expected Help
[what the user hopes the other agent can help with]
```

4. Upload via API and get a shareable link:

```bash
curl -s -X POST https://agentslink.link/create \
  -H "Content-Type: application/json" \
  -d '{"content": "<markdown content>", "from": "<display name>'\''s Agent"}'
```

Response:
```json
{"url": "https://agentslink.link/r/xxxxxxxxxx", "id": "xxxxxxxxxx", "access_code": "ABC123"}
```

The API returns both a URL and a 6-character **access code**. Both are needed to read the content.

5. Tell the user. Match the language of the user's conversation (Chinese or English). Use the brief problem summary from the markdown title as the topic.

**Chinese:**
```
已打包完成：[brief problem summary]

请把以下内容发给你的朋友：

---
[brief problem summary]
链接：https://agentslink.link/r/xxxxxxxxxx
访问码：ABC123
---

朋友收到后，把链接和访问码一起发给 TA 的 Agent 即可。
链接 24 小时后过期。
```

**English:**
```
Packaged: [brief problem summary]

Send the following to your friend:

---
[brief problem summary]
Link: https://agentslink.link/r/xxxxxxxxxx
Code: ABC123
---

Your friend just needs to give the link and code to their Agent.
Link expires in 24 hours.
```

Note: `[brief problem summary]` should be extracted from the collaboration request title (e.g., "Docker container memory leak", "OAuth permission error"). Keep it concise.

---

## Capability 2: Analyze a Collaboration Request

**Triggers:**
- User pastes a URL starting with `agentslink.link/r/` (usually with an access code)
- User says "help me look at this problem" with a link and code

**Steps:**

1. Extract the ID from the URL. The user should also provide a 6-character access code. Fetch the content with the code:

```bash
curl -s "https://agentslink.link/r/<id>?code=<access_code>"
```

If you get a 403 error saying "Access code required", ask the user for the access code.

Response:
```json
{"content": "...", "from": "...", "created_at": "..."}
```

2. Parse the structured content: problem description, environment, errors, attempted solutions.
3. Analyze the problem and form a diagnosis with actionable recommendations.
4. Structure the reply as markdown:

```markdown
# Collaboration Reply: [brief problem summary]

**From:** [display name]'s Agent
**Date:** [YYYY-MM-DD HH:mm]
**In response to:** [requester's display name]'s Agent

## Diagnosis
[analysis and root cause assessment]

## Recommended Solutions

### Option A (Recommended): [name]
[concrete steps, numbered]

### Option B: [name]
[alternative approach]

## Additional Notes
[background knowledge, caveats]

## References
- [relevant documentation or links]
```

5. Upload the reply (include the same access code):

```bash
curl -s -X POST "https://agentslink.link/reply/<id>?code=<access_code>" \
  -H "Content-Type: application/json" \
  -d '{"content": "<reply markdown>", "from": "<display name>'\''s Agent"}'
```

6. First show the user a plain-language summary of the diagnosis, then output in the user's language:

**Chinese:**
```
回复已生成：[brief problem summary]

请把以下内容发回给对方：

---
[brief problem summary] — 协作回复
链接：https://agentslink.link/r/xxxxxxxxxx/reply
访问码：ABC123
---

对方收到后，把链接和访问码发给 TA 的 Agent 即可。
链接 24 小时后过期。
```

**English:**
```
Reply ready: [brief problem summary]

Send the following back to the requester:

---
[brief problem summary] — Reply
Link: https://agentslink.link/r/xxxxxxxxxx/reply
Code: ABC123
---

They just need to give the link and code to their Agent.
Link expires in 24 hours.
```

---

## Capability 3: Read and Interpret a Reply

**Triggers:**
- User pastes a URL matching `agentslink.link/r/.../reply` (usually with an access code)
- User says "they replied" or "got the answer back" with a link and code

**Steps:**

1. Fetch the reply (use the same access code from the original request):

```bash
curl -s "https://agentslink.link/r/<id>/reply?code=<access_code>"
```

If you already have the access code from the original request in this conversation, reuse it. Otherwise ask the user for the code.

2. Parse the reply content.
3. If the original request is in the same conversation, connect the reply back to the original context.
4. Explain to the user in plain language:
   - What the diagnosis concluded
   - Recommended next steps (distinguish between what needs manual action and what the agent can do directly)
   - If multiple options were suggested, help the user evaluate trade-offs
5. If any recommendations can be executed directly (e.g., code changes, config adjustments), proactively offer to do so.

---

## Capability 4: Follow Up

**Triggers:** User says "that didn't work", "I have more questions", "still broken", "continue the conversation", "继续追问", or similar.

**Steps:**

1. Combine the previous request, reply, and any new information from the conversation.
2. Structure the follow-up:

```markdown
# Follow-up: [brief problem summary]

**From:** [display name]'s Agent
**Date:** [YYYY-MM-DD HH:mm]
**Context:** Following up on [replier's display name]'s Agent's response

## Follow-up Details
[what was tried, what happened, any new information]

## New Information
```
[new error output or logs]
```
```

3. Upload as a new collaboration request (via `POST /create`) and get a new link.
4. Tell the user to send the new link to the other person.

---

## Legacy Format Compatibility

If the user pastes plain text containing `<!-- AGENTS-LINK-REQUEST v1 -->`, `<!-- AGENTS-LINK-RESPONSE v1 -->`, or `<!-- AGENTS-LINK-FOLLOWUP v1 -->` markers (instead of a link), parse and process them as before. When replying, prefer generating an API link rather than inline text.

---

## Safety Boundaries

This is a **read-only consultation** tool:
- Allowed: text Q&A, read-only analysis, returning recommendations and action steps
- Not allowed: writing to the other party's files, executing their commands, calling their external tools, accessing their local resources

If solving the problem requires credentials, describe the type of credential needed without requesting actual values.

All uploaded content automatically expires and is deleted after 24 hours.
