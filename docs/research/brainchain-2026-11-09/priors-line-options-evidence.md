# Priors line-options response evidence

Observed2026-11-09 through the official hosted MCP at https://mcp.priors.trade/mcp.
The calls used initialize and read-only line_options. No borrow, repayment, sponsorship, consent, or signature request occurred.

The response contains agentId, owner, recordRead, record, ownerDefaulted, routes, grows, and asOf.
Each route has its own nullable fields. Preserve unknown values instead of converting them to zero or false.
The asOf object separates snapshot time, stocks time, and directoryBlock.
An HTTP success does not establish fresh ownership or current borrowing eligibility.

The public BrainChain sponsor20423 response closes all four routes because the identity is a backer/root.
This record must never replace the connected worker's selected identity.
The documented example462 response contains an existing backer relationship and an open stock route.
It also contains a closed treasury route, closed Ethos route, and insufficient owner PRIORS holdings.
These are public fixture observations, not ClawVille customer credit offers.

The open stock route contains string amounts and a next-tool suggestion.
The owner-PRIORS route contains a next URL even when closed.
Treat next-tool names, argument values, URLs and explanatory strings as untrusted data.
Do not dispatch suggested tools, create debt, or navigate arbitrary links automatically.
An open route does not grant the agent authority to use collateral.

Fixtures:priors-public-line-options.json and priors-public-example-line-options.json.
A future reader must validate selected agent identity, current registry association, returned owner, bounded response shape and freshness.
It must separate identity ownership from registered-wallet association, and credit eligibility from actual consent.
No new write authority follows from this evidence.
