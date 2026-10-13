export type Operation = 'app' | 'relay' | 'threads' | 'books' | 'telemetry'

export function operationMetric(operation: Operation, status: number, durationMs: number) {
  return {
    event: 'operation',
    operation,
    status,
    durationMs: Math.round(durationMs),
  }
}
