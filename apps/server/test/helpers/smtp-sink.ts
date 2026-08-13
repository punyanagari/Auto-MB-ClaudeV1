/**
 * A throwaway SMTP server for tests.
 *
 * The password-recovery tests refuse to assert against a mock of our own
 * sending code: the failure they exist to catch is a deployment that
 * accepts a reset request and never delivers anything, so the proof has
 * to run the real transport over a real socket. This is the other end of
 * that socket — it speaks just enough of RFC 5321 for nodemailer to
 * complete a delivery, and keeps what it received.
 *
 * It implements no authentication and advertises no STARTTLS, so nothing
 * here is a component that could be mistaken for production code.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';

export interface CapturedMessage {
  readonly from: string;
  readonly recipients: readonly string[];
  /** The raw message, headers and body, as it arrived. */
  readonly data: string;
}

export interface SmtpSink {
  readonly url: string;
  readonly messages: readonly CapturedMessage[];
  /** Resolves once `count` messages have arrived, or rejects on timeout. */
  waitForMessages(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: CapturedMessage[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      // A client that hangs up mid-conversation is not this sink's problem.
    });
    socket.setEncoding('utf8');

    let buffer = '';
    let inData = false;
    let from = '';
    let recipients: string[] = [];
    let body = '';

    socket.write('220 auto-mb-test ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\r\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ from, recipients: [...recipients], data: body });
            from = '';
            recipients = [];
            body = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            // Dot-stuffing, undone.
            body += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
        } else {
          const command = line.slice(0, 4).toUpperCase();
          if (command === 'EHLO') {
            socket.write('250-auto-mb-test\r\n250 8BITMIME\r\n');
          } else if (command === 'HELO') {
            socket.write('250 auto-mb-test\r\n');
          } else if (command === 'MAIL') {
            from = addressOf(line);
            socket.write('250 2.1.0 Ok\r\n');
          } else if (command === 'RCPT') {
            recipients.push(addressOf(line));
            socket.write('250 2.1.5 Ok\r\n');
          } else if (command === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (command === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else if (command === 'RSET' || command === 'NOOP') {
            socket.write('250 2.0.0 Ok\r\n');
          } else {
            socket.write('502 5.5.1 Command not implemented\r\n');
          }
        }
        newline = buffer.indexOf('\r\n');
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('SMTP sink did not bind a TCP port');
  }

  return {
    url: `smtp://127.0.0.1:${String(address.port)}`,
    messages,
    async waitForMessages(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `SMTP sink received ${String(messages.length)} of ${String(count)} messages`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

function addressOf(line: string): string {
  return /<([^>]*)>/.exec(line)?.[1] ?? '';
}

/**
 * The body as the recipient reads it.
 *
 * Nodemailer encodes a plain-text part as quoted-printable, which wraps
 * long lines with a trailing `=` and escapes bytes as `=XX`. A reset link
 * is long enough to be wrapped every time, so a test that searched the
 * raw body for it would be testing the line width rather than the link.
 */
export function decodeMessageText(raw: string): string {
  const separator = raw.indexOf('\n\n');
  const headers = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator + 2);
  if (!/content-transfer-encoding:\s*quoted-printable/i.test(headers)) return body;
  const unwrapped = body.replaceAll('=\n', '');
  const bytes = Buffer.from(
    unwrapped.replaceAll(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
    'latin1',
  );
  return bytes.toString('utf8');
}
