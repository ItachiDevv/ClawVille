# BrainChain CI independent review

Last Audited: 2026-11-09. Reviewer: root Codex, separate from the CI implementer.
Verdict: approved for the local CI implementation after C1 correction. Remote workflow execution remains unverified.

## Scope

Reviewed the fixture database helper, isolated suite runner, result parser, narrow fixture setup changes, and the added Gates jobs.
The workflow diff adds66lines and removes0lines. Existing jobs retain their source.
The official pinned Docker action exposes the sock output used by this workflow.
Source: https://raw.githubusercontent.com/docker/setup-docker-action/e43656e248c0bd0647d3f5c195d116aacf6fcaf4/action.yml.

## C1: required PostgreSQL tests could skip

The original suite parser required one passing test but accepted skipped tests.
A partial PostgreSQL or actual-child suite could therefore pass without its required cases.
The implementer extracted parseSuiteResult and made every PostgreSQL suite reject any skip.
The reviewer ran the tracked refusal test:1test,4assertions passed.
It rejects1pass/1skip and0pass/2skip. Protected Linux suites separately enforce exact reviewed pass/skip counts.

## Independent evidence

- Database helper tests:2tests,14assertions passed. URLs require explicit loopback, port, fixture role and fixture database.
- Required PostgreSQL runner without opt-in:exit1 before connection, expected refusal confirmed.
- Actual Linux runner on itachi222 through Ubuntu24.04 and Docker29.1.3:4suites,12tests passed.
- Unexpected synthetic file in the protected bundle directory:exit1 before container launch, expected refusal confirmed.
- The synthetic file was removed after the probe. No source bundle changed.

The Linux runner mounts five compiled files only. It verifies the directory type, exact entry names, regular-file types and SHA256 hashes before each mount.
Compilation disables environment substitution and restricts external imports to built-ins, bun:test and the compiled policy module.
The container has no network, a read-only root, UID10001, dropped capabilities, fixed image digest and private writable fixture directories.
No repository mount, provider credential, wallet credential or Docker socket enters those containers.
The production cognition launcher remains a separate actual fixture under the PostgreSQL lane and uses UID10002.

Owner evidence inspected:PostgreSQL13suites/67tests/0skips, pure41suites/286tests, observer7tests/162assertions.
The reviewer did not repeat the full PostgreSQL run while the purchase owner held its schema fixture.
Private probe evidence:.brainchain-work/ci-root-audit-probes.json. The Linux report was refreshed by the independent run.

## Limits and next gates

A controlled fixture does not prove provider access, live chain eligibility, production mount ownership or power-loss durability.
New purchase and autonomy database suites must join the explicit ordered PostgreSQL inventory.
Remote workflow execution and branch protection remain release requirements.
The checks assume the trusted CI host does not modify its compiled files between verification and mount.
No deployment or credential provisioning occurred during this review.

## Expanded inventory review,19:07UTC

Root reviewed the updated runner, guarded bootstrap, parser and workflow on itachi222.
The PostgreSQL list contains19 named suites plus the separate isolated-process suite.
The pure inventory now includes both external-wallet helper suites.
Each suite uses a separate process. PostgreSQL refuses every skipped test.
The pure Docker split requires its one expected skip; the PostgreSQL lane executes that case.
Reports receive a running marker before execution, so failed reruns cannot retain a prior passed report.

The fixture bootstrap requires the explicit isolated loopback database helper before any DDL.
It creates the minimal owner/session tables and applies0090 plus0100through0114 in order.
It skips legacy0102 only when the signer table already exists, then reapplies the later signer constraints.
Every ordered PostgreSQL suite restores0112 in a finally block and inspects its consent wrapper definition.
This minimal fixture does not replace the full application-schema migration gate.

Independent parser run:1test/4assertions passed.
Independent bootstrap replay:two complete passes plus wrapper restoration exited0 on isolated port55440.
Output:BOOTSTRAP_REPLAY_AND_WRAPPER_PASS. No credentials appeared in the output.
The existing container holds synthetic data and retains its job ownership labels.

Owner reports inspected:60pure suites/350passes;19PostgreSQL suites/125passes/zero skips;
one separately executed scheduler-flow pass;4protected Linux suites/12passes with reviewed skip counts.
Root did not repeat every unchanged suite in this checkpoint.
Scoped CI-source approval covers this inventory through0114, not later migrations or the consent C1 correction.
Remote workflow execution and final integrated browser evidence remain absent.
