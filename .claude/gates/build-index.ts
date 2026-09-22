import { writeFileSync } from 'node:fs';
import { indexText, loadRegistry } from '../../scripts/ci/run-coupling-gates';

writeFileSync('.claude/gates/INDEX.md', indexText(loadRegistry(process.cwd())));
