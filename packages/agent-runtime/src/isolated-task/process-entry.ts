/** Bundle this clean entry for the network=none OS worker. Never import the ordinary package entry. */
import { runIsolatedTaskProcess } from './process';

const exitCode = await runIsolatedTaskProcess({
  input: Bun.stdin.stream(),
  write: async bytes => { await Bun.write(Bun.stdout, bytes); },
});
process.exit(exitCode);
