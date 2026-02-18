# Positioning relative to GNAP (RFC 9635)

The oauth3-proxy is a GNAP authorization server where the resource is code execution and the client is a colocated AI agent running inside the same TEE.

## What we implement from GNAP

**Grant lifecycle.** The core request → interact → continue → result flow maps directly:
- `POST /execute` = grant request
- Approval page = interaction (redirect start)
- `GET /execute/:id/status?wait=true` = continuation (poll finish)
- Execution result = access granted

**Session as living grant.** GNAP supports grant continuation and modification. Our session model does the same — each approval widens the policy (union of allowed secrets, networks, risk levels), and the session expires after inactivity. Sessions expand monotonically rather than allowing narrowing.

**Interaction modes.** We use GNAP's `redirect` start (approval URL) + `poll` finish (long-poll status endpoint). The approval token serves as a bound continuation token.

## Where we diverge

**Code-as-request.** GNAP describes requested access as `{type, actions, locations, datatypes}`. We describe access as the code itself, with an LLM deriving the equivalent structured description (secrets used, network targets, mutability, risk level). This is strictly more expressive — the human approves exactly what will happen, not an abstract scope.

**AS + RS collapsed.** GNAP separates authorization server from resource server because tokens travel across trust boundaries. In our TEE model there's one trust boundary (human ↔ TEE). Inside the enclave, the proxy both authorizes and executes. No token is needed because there's no network hop between authorization and resource access.

**TEE replaces key binding.** GNAP's core security property is that tokens are bound to client keys so they can't be stolen and replayed. Our equivalent: secrets never leave the TEE — they're used inside the enclave and only results come out. The TEE attestation substitutes for client key proofing.

**Implicit client identity.** GNAP identifies clients by cryptographic key. We identify the client by network topology — only the colocated agent on the internal docker bridge can reach the proxy. There is exactly one client.

## Summary

A single-client GNAP AS+RS with code-as-scope, LLM-derived access analysis, and TEE attestation substituting for client key proofing.
