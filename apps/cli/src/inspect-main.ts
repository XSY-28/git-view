import { randomUUID } from 'node:crypto';
import { createRepositoryQueries } from '@git-view/core';
import { createGitAdapter } from '@git-view/git-cli';
import { overviewSchema, QueryError, toAppError } from '@git-view/contracts';
import { parseArguments } from './cli';
import { summarizeOverview } from './inspection';
const queries = createRepositoryQueries(createGitAdapter());
try {
  const args = parseArguments(process.argv.slice(2));
  if (args.command !== 'inspect') throw new QueryError('INVALID_REQUEST', '此入口仅支持 inspect。');
  const session = await queries.open(args.repo!);
  const response = await queries.execute({ schemaVersion: 1, action: 'overview', sessionId: session.sessionId, generation: session.generation + 1, requestId: randomUUID() });
  if (!response.ok) throw new QueryError(response.error.code, response.error.message, response.error.retryable);
  process.stdout.write(`${JSON.stringify(summarizeOverview(overviewSchema.parse(response.data)))}\n`);
} catch (error) { process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: toAppError(error) })}\n`); process.exitCode = 1; }
finally { queries.close(); }
