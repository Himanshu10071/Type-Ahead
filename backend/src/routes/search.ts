/**
 * search.ts — POST /search
 *
 * Constraint (per spec §5): this endpoint must NOT write to SQLite directly.
 * It only normalises the query and enqueues it into the batch writer, then
 * returns immediately.  The actual DB write happens asynchronously during the
 * next batch flush.
 *
 * Request body: { "query": "suzanne steinbaum" }
 * Response:     { "message": "searched" }
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { BatchWriter } from '../batch/batchWriter';

interface SearchBody {
  query: string;
}

export function registerSearchRoute(
  app: FastifyInstance,
  batchWriter: BatchWriter,
): void {
  app.post<{ Body: SearchBody }>(
    '/search',
    {
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SearchBody }>, reply: FastifyReply) => {
      const raw = request.body.query;
      const normalized = raw.trim().toLowerCase();

      if (!normalized) {
        return reply.status(400).send({ error: 'query must not be empty' });
      }

      // Enqueue — returns instantly, no I/O on this path
      batchWriter.enqueue(normalized);

      return reply.status(200).send({ message: 'searched' });
    },
  );
}
