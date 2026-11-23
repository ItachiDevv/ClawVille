# Funding approval panel review

Last Audited: 2026-11-09. Reviewer: root. Status: scoped component correction approval.

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

## F1 correction evidence

The owner added retained destination, networks, token addresses, gas ceiling, minimum quote, original expiry, operation ID and artifact hash.
The service DTO and hosted result projection now carry those terms. The component validates them before rendering the approval control.
The original quote-limit warning remains visible. Desk status still cannot release a liability.
Root read the changed component and independently ran its final three tests with21assertions; all passed.
The wallet-boundary regression inspects rendered retained values before the mocked account signature call.
It uses terms that differ from the creation form, so form defaults cannot satisfy the assertions.
Panel SHA256:55A5588C432672BA213B70E04DE209F8D9759DA65115C1DD473F28C08C9B3973.
This resolves F1 within the source/component scope. Database, final transaction, device layout and authenticated staging checks remain separate.

PARITY: this review covers human approval visibility; bound-agent requests still require the same separately approved owner authority.
