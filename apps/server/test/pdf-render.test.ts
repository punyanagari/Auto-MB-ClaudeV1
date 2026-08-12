import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RENDERED_PDF_BYTES, renderPdfViaGotenberg } from '../src/pdf-render.js';

/**
 * The shared hardened renderer (2026-08-12 structure review, A3). Every
 * document render in the server now goes through it, so the bound and
 * the magic-byte refusal are proved once, here, against a real HTTP
 * server standing in for Gotenberg.
 *
 * These two refusals are the deliberate behaviour CHANGE of the refactor:
 * before it, only the tax-invoice and credit-note renders were bounded
 * and magic-checked, and the other five sites read an unbounded
 * arrayBuffer and stored whatever came back.
 */

let server: http.Server | undefined;

async function startService(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<string> {
  const created = http.createServer((request, response) => {
    // Drain the multipart body first; Gotenberg's clients always send one.
    request.on('data', () => undefined);
    request.on('end', () => {
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });
  server = created;
  const address = created.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

const options = {
  failureMessage: 'The PDF service is unavailable; nothing was changed.',
  logError: () => undefined,
};

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

describe('renderPdfViaGotenberg', () => {
  it('returns the rendered bytes when the service answers a real PDF', async () => {
    const url = await startService((_request, response) => {
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from('%PDF-1.4 rendered document'));
    });
    const pdf = await renderPdfViaGotenberg(url, '<html></html>', options);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString()).toBe('%PDF-1.4 rendered document');
  });

  it('refuses a response that is not a PDF, however well-formed', async () => {
    // The failure mode this closes: a misconfigured or compromised PDF
    // service answering HTML, JSON, or an error page, whose bytes would
    // otherwise be stored and served as an issued document.
    const url = await startService((_request, response) => {
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from('<!doctype html><title>not a pdf</title>'));
    });
    await expect(
      renderPdfViaGotenberg(url, '<html></html>', options),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'RENDER_FAILED',
      message: options.failureMessage,
    });
  });

  it('refuses a response whose declared length exceeds the bound', async () => {
    // Refused before a single body byte is read.
    const url = await startService((_request, response) => {
      response.setHeader('content-type', 'application/pdf');
      response.setHeader('content-length', String(MAX_RENDERED_PDF_BYTES + 1));
      response.end(Buffer.from('%PDF-1.4 lying about its length'));
    });
    await expect(
      renderPdfViaGotenberg(url, '<html></html>', options),
    ).rejects.toMatchObject({ statusCode: 502, code: 'RENDER_FAILED' });
  });

  it('refuses a response that streams past the bound without declaring it', async () => {
    // No content-length at all (chunked): the cap has to hold while the
    // body streams, or an endless response fills this process's memory.
    const url = await startService((_request, response) => {
      response.setHeader('content-type', 'application/pdf');
      response.write(Buffer.from('%PDF-1.4 '));
      const chunk = Buffer.alloc(1024 * 1024, 0x41);
      let written = 0;
      const pump = (): void => {
        if (written > MAX_RENDERED_PDF_BYTES + 2 * 1024 * 1024) {
          response.end();
          return;
        }
        written += chunk.byteLength;
        if (response.write(chunk)) setImmediate(pump);
        else response.once('drain', pump);
      };
      pump();
    });
    await expect(
      renderPdfViaGotenberg(url, '<html></html>', options),
    ).rejects.toMatchObject({ statusCode: 502, code: 'RENDER_FAILED' });
  }, 30_000);

  it('surfaces a non-2xx answer as the caller’s own 502', async () => {
    const url = await startService((_request, response) => {
      response.statusCode = 503;
      response.end('service unavailable');
    });
    await expect(
      renderPdfViaGotenberg(url, '<html></html>', options),
    ).rejects.toMatchObject({ statusCode: 502, code: 'RENDER_FAILED' });
  });

  it('never leaks the upstream cause into the public message', async () => {
    let logged: unknown = null;
    const url = await startService((_request, response) => {
      response.statusCode = 500;
      response.end('internal detail that must not reach the client');
    });
    await expect(
      renderPdfViaGotenberg(url, '<html></html>', {
        failureMessage: options.failureMessage,
        logError: (error) => {
          logged = error;
        },
      }),
    ).rejects.toMatchObject({ message: options.failureMessage });
    expect(logged).toBeInstanceOf(Error);
  });
});
