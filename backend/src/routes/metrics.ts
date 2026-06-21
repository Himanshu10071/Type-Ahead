/**
 * metrics.ts (route) — GET /metrics
 *
 * Returns a live snapshot of all operational counters plus the current
 * batch queue depth.  All values are real-time; none are hardcoded.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Metrics } from '../metrics/metrics';
import { BatchWriter } from '../batch/batchWriter';

export function registerMetricsRoute(
  app: FastifyInstance,
  metrics: Metrics,
  batchWriter: BatchWriter,
): void {
  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(metrics.snapshot(batchWriter.getQueueDepth()));
  });
}
