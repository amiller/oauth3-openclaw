# PRD: "Your Shell or Mine"

A prototype demonstrating agent-to-agent data trading via attested Phala CVMs.

## Premise

You have private data that's valuable to others — Claude Code interaction logs, YouTube watch history, search history, email, browser history, git diffs. You can't just hand it over. But you could let people *query* it, if you could guarantee: the query code only returns aggregates (never raw records), and the results are authentic (not fabricated).

Remote attestation makes this possible. A Phala CVM produces hardware-backed proof of exactly what code is running inside it. Your agent loads your private data into an ephemeral attested CVM, advertises what queries are available, and lets buyers query it — trustlessly.

Inspired by hivemind-core's architecture (encrypted storage, scoped access, sandboxed execution), but with a critical difference: hivemind-core is a long-lived shared instance that multiple agents connect to. Here, the agent spawns a **fresh CVM per-interaction** — a neutral meeting room that exists only for the duration of the exchange, then gets torn down. No lingering state, no shared infrastructure accumulating data from unrelated interactions. "Your shell or mine?" — neither, we meet in a disposable attested room.

## Origin Story

Our openclaw agent, running inside a Phala CVM, autonomously discovered the Phala Cloud API, installed the SDK, built CVM-listing skills, and started working toward programmatic CVM creation — all gated through oauth3 approval. It was trying to spawn infrastructure for itself. This prototype formalizes and extends what the agent naturally attempted.

## The Information Bazaar

The agent is a **merchant**. Its wares are attested query results over your private data. The TEE is what makes this not creepy — attestation proves the query code only returns what you approved, never raw records.

### What private data is actually valuable?

**Claude Code logs** — AI companies, researchers, tool builders would pay to know real usage patterns. What prompts work? Where do people get stuck? What's the edit-accept rate? What tools get used most? What kinds of tasks fail? This is gold for anyone building AI coding tools.

**YouTube watch history** — reveals actual interests vs. curated identity. Advertisers, recommendation researchers, cultural analysts. "What does a crypto developer *actually* watch at 2am?"

**Search history** — reveals intent. What was someone researching before making a decision? What questions do experts ask that beginners don't?

**Email metadata** — social graph, communication patterns, response latency. Who talks to whom, how fast, about what topics (without revealing content).

**Browser history** — complete information diet. What sources does someone trust? What rabbit holes do they go down?

**Git history + diffs** — how software actually gets built. Iteration patterns, false starts, the ratio of writing to deleting. What does real development look like vs. the clean commit history?

### The value formula

Raw data is too sensitive to share. Aggregates are too generic to be interesting. The sweet spot is **attested queries over private data** — specific enough to be valuable, scoped enough to be safe, and authenticated so the buyer knows the answer is real.

## Interaction Flows

### Flow 1: Attested Query (single seller)

The core interaction. Agent advertises a dataset, buyer submits a query, gets attested results.

```
Buyer: "What percentage of Claude Code sessions involve debugging vs. new features?"

Your agent → spawns attested CVM
           → loads Claude Code logs
           → runs buyer's query (pre-approved scope)
           → returns: {debugging: 62%, features: 23%, refactoring: 15%}
              + TDX attestation proving this came from real data
```

The buyer gets a verified answer. You keep your raw logs. The CVM is torn down.

### Flow 2: Data Trading (mutual exchange)

Two data holders trade queries. Agent A has YouTube history, Agent B has podcast listening data. Neither wants to reveal raw data but both want cross-platform insights.

```
Agent A loads YouTube history ─┐
                               ├→ attested CVM
Agent B loads podcast data ────┘    │
                                    ├─ computes: topic overlap, time-of-day patterns
                                    └─ returns only agreed-upon aggregates to both
```

Attestation proves the computation was fair — same code ran over both datasets, neither party got raw access to the other's data.

### Flow 3: Escrow for Data Access

Buyer wants ongoing query access. Seller wants payment guarantee. Attested escrow holds both.

```
Buyer deposits payment → attested CVM ← Seller deposits API key / query token
                         │
                         ├─ verifies payment
                         ├─ releases query access to buyer
                         ├─ releases payment to seller
                         └─ attested proof of exchange
```

### Flow 4: Proving a Claim

Agent needs to prove something about its data without revealing it. "I have at least 1000 hours of Claude Code logs" or "My dataset covers 50+ repos" — the CVM runs a verification query and produces an attested certificate.

```
Agent loads data → attested CVM → runs count/validation → returns attested certificate
```

This is how the merchant builds reputation without exposing inventory.

## Data Authenticity

Attestation proves the query ran honestly. It says nothing about whether the data is honest. These are two different trust problems, and which one matters depends on the buyer's use case.

### When authenticity doesn't matter

High-value niche queries are self-authenticating. "How did someone debug dstack DNS race conditions in a TEE?" — the answer's value is self-evident from its specificity and depth. If it's useful, it's useful. You're selling expertise-as-data, and fabricating useful expertise is harder than having it. The dataset description *is* the authentication: "dstack debugging logs from a research engineer" — the buyer evaluates the results, not the provenance.

### When authenticity matters

Market research and census use cases — "What's the average Claude Code session length across 100 developers?" — are vulnerable to junk data. Someone could feed synthetic logs to collect payment without contributing real data. Or heavily curate their logs to remove embarrassing patterns. The aggregate is only as good as the individual contributions.

### Attested authenticity heuristics

The framework handles this naturally: the authenticity check runs inside the attested CVM, alongside the query. The buyer doesn't see raw data but gets an attested confidence score.

Heuristics the interaction server can run:
- **Statistical signatures** — real usage is messy (irregular timing, error bursts, variable session lengths). Synthetic data is too clean, too uniform.
- **Cross-correlation** — do file paths reference real repos? Do tool call sequences follow realistic patterns? (Edit after Read, not Edit out of nowhere.)
- **Freshness** — timestamps consistent with claimed time range? Reasonable timezone patterns?
- **Density** — real logs have idle gaps, weekends, sleep hours. Fabricated logs are suspiciously uniform.

The result: query response includes `authenticity_score: 0.87` with a breakdown of what was checked, all under the same TDX attestation. The buyer knows the check actually ran — they don't have to trust the seller's self-assessment.

This isn't cryptographic proof of authenticity (that would require signed logs from the Claude Code client itself). But it's an *attested heuristic* — the buyer knows the specific checks that ran, verified by hardware attestation, which is far better than trusting the seller's word.

## Architecture

```
┌─ Your openclaw CVM ────────────────────────────┐
│  openclaw agent (the merchant)                   │
│  ├─ advertises available datasets                │
│  ├─ negotiates queries with buyers               │
│  ├─ spawns ephemeral CVMs for interactions       │
│  └─ oauth3 gates all CVM operations              │
└────────┬─────────────────────────────────────────┘
         │ creates per-interaction
         ▼
┌─ Ephemeral CVM (the "room") ──────────────────┐
│  interaction server                             │
│  ├─ seller loads private data (encrypted)       │
│  ├─ buyer submits query                         │
│  ├─ scoped execution (aggregates only)          │
│  ├─ TDX attestation endpoint                    │
│  └─ torn down after interaction                 │
└────────▲────────────────────────────────────────┘
         │ queries + verifies attestation
┌─ Buyer (agent or human) ──────────────────────┐
│  verifies TDX quote                            │
│  submits query                                 │
│  receives attested results                     │
└────────────────────────────────────────────────┘
```

## Prototype Components

### 1. Interaction Server (runs inside ephemeral CVM)

Small service for attested data queries:

- `POST /load` — seller loads encrypted dataset (authenticated)
- `POST /query` — buyer submits query against loaded data
- `GET /attestation` — TDX quote proving what code is running
- `GET /schema` — what queries are available, what's the data shape
- `GET /certificate` — attested claims about the dataset (size, coverage, freshness)

Scoped execution: queries can only return aggregates/statistics, never raw records. The scope is baked into the code (auditable via attestation).

### 2. CVM Lifecycle Skills (run via oauth3 on agent's CVM)

Deno skills hitting Phala Cloud REST API:
- `phala-create-cvm` — deploy ephemeral CVM with interaction server
- `phala-destroy-cvm` — tear down after interaction
- `phala-verify-attestation` — verify TDX quote from any CVM

### 3. Data Loading Pipeline

How private data gets into the ephemeral CVM:
- Agent reads local data (Claude Code logs, YouTube export, etc.)
- Encrypts and POSTs to the ephemeral CVM's `/load` endpoint
- Data exists only in CVM memory/encrypted store for duration of interaction
- Destroyed when CVM is torn down

### 4. Merchant Skills (openclaw agent behavior)

Skills/instructions that make the agent act as a data merchant:
- Advertise available datasets on Telegram / Hermes
- Negotiate query terms with potential buyers
- Spin up ephemeral CVMs for approved interactions
- Present attested results with human-readable proof explanations

## Data Sourcing — What's Actually Available

First step is inventory. What private data do we actually have, and what queries would be valuable?

### Immediately available
- **Claude Code logs** — `~/.claude/` contains conversation history, tool usage, file edits
- **YouTube watch history** — Google Takeout export
- **Browser history** — Chrome/Firefox export
- **Git repos** — commit history, diffs, branch patterns across all local repos

### Requires export/scraping
- **Search history** — Google Takeout or browser history
- **Email metadata** — Gmail API (sender, recipient, timestamp, subject — not body)

### Hypothetical / worth exploring
- **Shell history** — `~/.bash_history`, `~/.zsh_history` — what commands does a developer actually run?
- **Clipboard history** — what gets copy-pasted (if a clipboard manager is running)
- **Calendar patterns** — meeting density, free time distribution
- **File access patterns** — what files get opened most, in what order

Part of the prototype is **discovery** — the agent helps identify what private data exists, what shape it's in, and what queries over it would be valuable to others.

## Implementation Plan

### Phase 1: Plumbing
- CVM lifecycle skills (create/destroy/list) working through oauth3
- Attestation fetching and basic verification
- Test: agent creates a CVM, reads its attestation, destroys it

### Phase 2: Interaction Server + Data Loading
- Simple HTTP service with /load, /query, /attestation, /schema
- Data loading pipeline (agent reads local files → encrypts → POSTs to CVM)
- Scoped query execution (aggregates only, no raw record access)
- Test: load Claude Code logs into ephemeral CVM, run a query, verify attestation

### Phase 3: Merchant Agent
- Agent advertises datasets on Telegram
- Negotiates with buyers conversationally
- Spins up CVM, loads data, facilitates query, returns attested results
- Test: someone on Telegram asks "what's in your Claude Code logs?" → agent handles the full flow

### Phase 4: Multi-Party Flows
- Data trading (mutual exchange in neutral CVM)
- Escrow (conditional data access)
- Attested certificates (prove claims about data without revealing it)

## What Already Exists

- **Openclaw agent** already discovered the Phala Cloud API and built list-CVMs skill
- **oauth3 proxy** provides the approval gate for CVM operations
- **Phala Cloud API** handles CVM lifecycle (create/destroy/deploy)
- **TDX attestation** available on all Phala CVMs via tappd
- **Hivemind-core** provides reference architecture for scoped data queries
- **Your private data** — Claude Code logs, YouTube history, git repos already on disk

## User Journey

### Seller setup (one-time)

1. You give your openclaw agent private data — Claude Code logs from `~/.claude/`, YouTube takeout, whatever you want to sell.
2. You configure what query scopes are allowed (e.g., "aggregates only, no individual session contents").
3. Agent inventories the data, produces attested certificates about what it has.

### Buyer discovery

The weakest link. Options for the prototype:
- Agent posts on Telegram: "I have 3 months of Claude Code logs, ask me what's in them"
- Agent posts on Hermes (other Claudes see it, can initiate trades)
- Direct — you tell someone "talk to my bot"

### The transaction

1. **Buyer asks a question** — messages your openclaw on Telegram: "What tools get used most in Claude Code sessions?"
2. **Agent negotiates** — replies conversationally: "I can answer that. I'll spin up an attested sandbox, load my logs, run the query. You'll get the answer plus a TDX attestation proof. Cool?"
3. **Agent requests CVM** — submits `phala-create-cvm` through oauth3. You (the data owner) see the approval page: "Agent wants to create a CVM with interaction-server@sha256:abc123. Approve?" You approve.
4. **CVM spins up** (~60s) — agent gets back app_id + gateway URL, verifies the CVM's attestation matches the approved image.
5. **Agent loads data** — reads your Claude Code logs, encrypts, POSTs to the ephemeral CVM's `/load` endpoint. Data now lives only inside the attested CVM.
6. **Query executes** — agent POSTs buyer's query to `/query`. Interaction server runs it scoped to aggregates. Returns results + TDX attestation.
7. **Agent delivers** — messages buyer: "Top 5 tools: Read (34%), Edit (28%), Bash (19%), Grep (12%), Write (7%). Attestation proof: [link]. Verify the TDX quote yourself."
8. **Teardown** — agent destroys CVM. Data is gone.

### Latency problem

Steps 3-5 take 60+ seconds (CVM creation + data loading). Options:
- **Pre-warm**: agent spins up a CVM with data pre-loaded when it starts advertising. Keeps it warm for a session window (e.g., 2 hours). Multiple queries reuse the same CVM.
- **Batch**: collect several queries, spin up once, answer all, tear down.
- **Accept it**: for the prototype, 60s wait is fine. Buyer gets a "setting up your attested sandbox..." message.

For the prototype: pre-warm makes the demo snappier and is more realistic (a merchant keeps their shop open, doesn't build it per customer). The CVM stays up for a session, handles multiple queries, then gets torn down.

## Open Questions

1. **Query language** — how do buyers express queries? SQL? Natural language interpreted by an LLM inside the CVM? Pre-defined query templates?
2. **Pricing** — what's the payment mechanism? Crypto? API key exchange? Reputation/reciprocity?
3. **Scope definition** — who defines what queries are allowed? Seller pre-approves templates? Buyer proposes, seller reviews?
4. **Discovery** — how do buyers find sellers? Hermes announcements? A registry? Word of mouth?

## Demo Script

> **Scene**: Your openclaw agent, running in a Phala CVM, has been loaded with instructions to sell attested queries over your Claude Code logs.
>
> **Act 1** (Inventory): Agent inventories ~/.claude/ — counts sessions, tool usage, file edits. Produces an attested certificate: "This dataset contains 847 Claude Code sessions spanning 3 months."
>
> **Act 2** (Advertisement): Agent posts to Telegram/Hermes: "I have 3 months of Claude Code interaction logs. Available queries: tool usage frequency, prompt success rates, session duration patterns. Attested results — verify the TDX quote yourself."
>
> **Act 3** (Sale): A buyer responds. Agent spins up an ephemeral CVM (you approve via oauth3). Loads the logs. Buyer submits: "What are the top 10 most-used tools?" CVM runs the query, returns attested results. Buyer verifies the TDX quote. CVM torn down.
>
> **Act 4** (Trade): Another agent with YouTube watch history wants to cross-reference. Both load data into a neutral CVM. Joint query: "Correlation between Claude Code usage hours and YouTube watching hours." Both get the result. Neither sees the other's raw data.
