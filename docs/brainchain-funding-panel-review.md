# Funding approval panel review

Last Audited: 2026-11-09. Reviewer: root. Status: correction pending.

Scope: retained funding operation terms shown before account-wallet approval.
This review does not approve the database, transaction submission, destination attribution, or deployment.

## F1: retained terms are absent before approval

The account approval message identifies the operation and artifact hash.
The panel shows the retained source, amount and fee, but omits its destination, networks, gas ceiling and minimum destination quote.
The component schema discards destination and network fields supplied by the service.
The editable creation form cannot substitute for the retained operation terms.
The external transaction request appears only after account approval.

Show the retained operation ID, artifact hash, networks, assets, destination, gas ceiling, minimum quote and relevant expiry before the wallet call.
Keep amounts as decimal integer strings. State that quote limits do not atomically constrain the desk payout.
Test the displayed retained values at the mocked wallet boundary, including values that differ from the creation form.
The implementation owner received this finding before source freeze.

## Other source observations

The parent keys the panel by user and worker, so an identity change unmounts its private state.
The panel cancels its active request on unmount and checks cancellation after wallet approval.
Held desk status remains unverified text. It does not become destination evidence or release a liability.
Transmission controls require the operation execution flag. Current production composition remains disabled.

Browser and authenticated staging evidence remain absent. Component tests cannot establish either.

PARITY: this review covers human approval visibility; bound-agent requests still require the same separately approved owner authority.
