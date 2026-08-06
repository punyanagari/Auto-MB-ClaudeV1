const controller = new AbortController();

function stop(signal: string): void {
  console.info(JSON.stringify({ level: 'info', service: 'auto-mb-worker', signal, message: 'stopping' }));
  controller.abort();
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

console.info(
  JSON.stringify({
    level: 'info',
    service: 'auto-mb-worker',
    message: 'worker boundary ready; jobs land with the first async workflow',
  }),
);

await new Promise<void>((resolve) => {
  controller.signal.addEventListener('abort', () => resolve(), { once: true });
});
