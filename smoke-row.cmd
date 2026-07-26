@echo off
cd /d C:\Users\itachi\Documents\Crypto\cv-cove-3d
set CV_PARITY_WEB_BASE=https://itachi222.tail06a01b.ts.net:9443
set CV_PARITY_API_BASE=https://itachi222.tail06a01b.ts.net:9444
set CV_PARITY_AUTH_STATE=scripts/parity/out/auth/live-state.json
set CV_PARITY_GUEST_AUTH_STATE=scripts/parity/out/auth/guest-state.json
set CV_PARITY_CASH_TABLE_ID=98715175-7f1f-473c-b794-3bea8003ab9b
bun scripts/parity/run-parity.ts --live --scenario %1 > scripts\parity\out\smoke-row.log 2>&1
set RC=%ERRORLEVEL%
echo EXITCODE %RC% >> scripts\parity\out\smoke-row.log
exit /b %RC%
