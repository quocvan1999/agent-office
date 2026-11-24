# Org, message bus & meeting room contract (Hub <-> UI). Source of truth: design Page section 10 (all 6 decisions CHỐT 24/11/2026).

## Seed data (sqlite, seeded once, user edits kept)
Departments (id, name, headAgentId): board "Ban Giám đốc" (admins ly-van, tro-ly-map); server-admin "Quản trị máy chủ" (cursor-hub-ai); ba "BA / Phân tích" (chuyen-gia-ba); design "Thiết kế" (null); backend "Backend" (tho-code); frontend "Frontend / Mobile" (null); qa "QA / Kiểm thử" (null); devops "DevOps" (null); security "An ninh" (hacker-lo); research "Nghiên cứu" (tcs-ai-lab); token "Giám sát Token" (giam-sat-token).
Roles (templates): id, name, departmentId, defaultProvider, defaultEffort, systemPrompt (short Vietnamese), e.g. board-admin, server-admin, ba-analyst, designer, backend-dev, frontend-dev, qa-tester, devops-engineer, security-reviewer, researcher, token-supervisor.
Agents (instances): `Agent = { id, name, departmentId, roleId, kind: "human"|"grok_bot"|"local_agent", provider: "human"|"grok_external"|"antigravity"|"cursor"|"codex", slotId: string|null, model: string|null, effort, isHead: boolean (derived from department.headAgentId), isAdmin: boolean, status: "online"|"offline"|"manual"|"idle"|"busy", bridge: "none"|"hub" , note }`.
Seed: ly-van (human, board, admin, status online), tro-ly-map (grok_bot, board, admin), cursor-hub-ai, chuyen-gia-ba, tho-code, hacker-lo, tcs-ai-lab, giam-sat-token (all grok_bot, provider grok_external, bridge "none", status "manual", note "Bot Grok Bot bên ngoài — chưa có cầu nối API, trạng thái nhập tay"); local agy instances ba-agy-1 "BA-1 (agy)" in ba and be-agy-1 "BE-1 (agy)" in backend (provider antigravity, slotId "default", effort low, bridge "hub").
Admins = agents with isAdmin (ly-van, tro-ly-map). Actor identity: header `X-Actor-Id` (default "ly-van" when absent, since the local UI is Ly Van).

## Message
`BusMessage = { id, ts, fromAgentId, toAgentId: string|null, conversationId, taskId: string|null, kind: "request"|"reply"|"handoff"|"meeting", summary (1..200 chars), body: string|null (max BUS_BODY_MAX=4000; handoff max 1500), tokenEstimate (ceil(chars/4)), status: "delivered"|"rejected", rejectReason: string|null }`
Permission rule (enforced in Hub, rejected otherwise with 403 and logged with status rejected):
- direct (request/reply): allowed if same department OR either side is in board.
- cross-department: only kind "meeting" inside a meeting conversation where BOTH are participants, or kind "handoff" via POST /api/tasks/handoff.
- sender must be a participant of the conversation; closed/paused conversations reject.
Every delivered message belongs to a conversation (direct pairs auto-create/reuse a `direct` conversation) so everything shows in the meeting room.

## Conversation (meeting room)
`Conversation = { id, type: "direct"|"meeting"|"handoff", title, participants: string[], status: "open"|"paused"|"closed", turnCap (default 12), turns, createdBy, taskId, summary: string|null, pauseReason: string|null, openedAt, closedAt, lastMessage?: BusMessage }`
Guardrails: turn cap reached -> auto close with 0-token summary (join of message summaries, max 600 chars) + notify admins (WS `guardrail` event); loop guard -> same normalized summary/body hash 3 times in a conversation, or A->B->A->B with identical texts -> status paused, pauseReason; handoff carries only summary + decisions (never full history).
Who may open a meeting: admins and department heads (any participants). Who may close/resume: admins or the creator.

## Tasks (minimal)
`TaskRecord = { id, title, kind: "assign"|"handoff", fromAgentId, departmentId, toAgentId: string|null, summary, decisions: string[], status: "assigned"|"handed_off"|"accepted"|"done", conversationId: string|null, createdAt }`
Assign permission: admins anywhere; heads only in own department; others 403. Handoff: any agent may hand off from its own dept to another dept; creates a `handoff` conversation (from agent + target head/agent) with one handoff message.
Stop All and resolving approvals: admins only (403 for other X-Actor-Id).

## Endpoints
GET /api/org -> {departments, roles, agents}
POST /api/org/agents, PATCH /api/org/agents/:id, DELETE /api/org/agents/:id (admins only; seeds of humans/admins undeletable)
PATCH /api/org/departments/:id {headAgentId} (admins only)
POST /api/bus/messages {fromAgentId, toAgentId?, conversationId?, taskId?, kind, summary, body?} -> BusMessage | 403 {error, reason}
GET /api/bus/messages?conversationId=&limit=100&includeRejected=1
GET /api/conversations?status=open|all -> Conversation[]
POST /api/conversations {type:"meeting", title, participants, turnCap?, taskId?} -> Conversation
GET /api/conversations/:id -> Conversation & {messages: BusMessage[]}
POST /api/conversations/:id/close {summary?}; POST /api/conversations/:id/resume
POST /api/conversations/:id/run {rounds (1..3), prompt} -> {ok, runId}: for each round, each participant with bridge "hub" takes a turn: Hub runs its agy via the accounts job runner (slot pinned, `--mode plan`, effort from agent, --print-timeout 120s) with prompt = role systemPrompt + topic + conversation summary + last 3 message summaries (no full history), asks for a reply <= 120 words with first line = one-sentence summary; posts it as a "meeting" message. Participants without a bridge are skipped with a system note. Respects turn cap/loop guard; usage counted on the slot.
POST /api/tasks/assign, POST /api/tasks/handoff, GET /api/tasks
WS: {type:"bus_message", message}, {type:"bus_rejected", message}, {type:"conversation_changed", conversation}, {type:"guardrail", conversationId, reason}, {type:"org_changed"}
