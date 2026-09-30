#!/bin/bash
# ClawVille hosted-hermes runtime keeper. Since the D1 sandbox (2026-09-30) the runtime runs in its own
# Docker network (not the API netns); cv-agent-sandbox.sh keeps the network, firewall and container.
# Run by hermes-attach.timer (OnBootSec=90, every 120 s). The pre-D1 script is kept as hermes-attach.legacy.sh.
exec /usr/local/bin/cv-agent-sandbox.sh ensure hermes
