/**
 * Hand-rolled Prometheus text-format metrics (docs/DEPENDENCIES.md:
 * OpenTelemetry waits for a telemetry backend; a counter map and one
 * histogram do not justify an SDK). Request counts are labelled by
 * method/route/status — routes, not raw URLs, so tenant ids and document
 * ids never become label values. Durations feed a single global histogram
 * to keep cardinality bounded.
 */

const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface MetricsRegistry {
  observe(method: string, route: string, statusCode: number, seconds: number): void;
  render(): string;
}

export function createMetricsRegistry(): MetricsRegistry {
  const requests = new Map<string, number>();
  const bucketCounts = new Array<number>(DURATION_BUCKETS.length).fill(0);
  let durationSum = 0;
  let durationCount = 0;

  return {
    observe(method, route, statusCode, seconds) {
      const key = `method="${method}",route="${route}",status="${String(statusCode)}"`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      durationSum += seconds;
      durationCount += 1;
      for (const [index, bound] of DURATION_BUCKETS.entries()) {
        if (seconds <= bound) bucketCounts[index] = (bucketCounts[index] ?? 0) + 1;
      }
    },
    render() {
      const lines = [
        '# HELP http_requests_total HTTP requests served, by method, route, and status.',
        '# TYPE http_requests_total counter',
      ];
      for (const [labels, count] of [...requests.entries()].sort()) {
        lines.push(`http_requests_total{${labels}} ${String(count)}`);
      }
      lines.push(
        '# HELP http_request_duration_seconds HTTP request duration.',
        '# TYPE http_request_duration_seconds histogram',
      );
      for (const [index, bound] of DURATION_BUCKETS.entries()) {
        lines.push(
          `http_request_duration_seconds_bucket{le="${String(bound)}"} ${String(bucketCounts[index] ?? 0)}`,
        );
      }
      lines.push(
        `http_request_duration_seconds_bucket{le="+Inf"} ${String(durationCount)}`,
        `http_request_duration_seconds_sum ${String(durationSum)}`,
        `http_request_duration_seconds_count ${String(durationCount)}`,
      );
      return `${lines.join('\n')}\n`;
    },
  };
}
