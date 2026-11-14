/**
 * Realtime gateway: Socket.IO namespace `/realtime`.
 *
 * Purpose: pushes new notifications to a signed-in user's open browser tabs, so the bell
 * updates without polling. The only message sent is `notification` (the same item the
 * REST list returns).
 *
 * Security:
 *   - A connection must present a valid access token in `auth.token` of the handshake; it
 *     is checked with the same verifier as the REST API. Anything else is refused.
 *   - The socket joins exactly one room, "<tenant>:<user>", taken from the token. Clients
 *     cannot join rooms or send events the server acts on, so one user can never receive
 *     another's notifications.
 *   - Tokens expire; a connection made with one stays open until the browser reconnects.
 *     The web app reconnects with a fresh token after every refresh, and a notification
 *     is also stored, so nothing is lost if a stale socket is closed.
 *
 * Single instance: rooms live in this process. With several API instances a Redis adapter
 * is needed so a push reaches the instance that holds the socket (not built yet; see
 * docs/PROGRESS.md).
 *
 * Depends on: socket.io, kernel/auth/access-token.ts. Used by: src/main.ts, tests.
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { AccessTokens } from '../../kernel/auth/access-token.js';
import type { NotificationView, RealtimePublisher } from './notify-service.js';

export const REALTIME_NAMESPACE = '/realtime';

const room = (tenantId: string, userId: string) => `${tenantId}:${userId}`;

export class RealtimeGateway implements RealtimePublisher {
  private readonly io: Server;

  constructor(options: { server: HttpServer; tokens: AccessTokens; corsOrigins: string[] }) {
    this.io = new Server(options.server, {
      cors: { origin: options.corsOrigins, credentials: true },
      // Notifications are small; a modest cap stops a client from flooding memory.
      maxHttpBufferSize: 10_000,
    });
    this.io.of(REALTIME_NAMESPACE).use((socket, next) => {
      const token: unknown = (socket.handshake.auth as { token?: unknown }).token;
      const claims = typeof token === 'string' ? options.tokens.verify(token) : undefined;
      if (claims === undefined || claims.pwd === true || claims.mfa === true) {
        next(new Error('unauthorized'));
        return;
      }
      void socket.join(room(claims.tid, claims.sub));
      next();
    });
  }

  notify(tenantId: string, userId: string, notification: NotificationView): void {
    this.io.of(REALTIME_NAMESPACE).to(room(tenantId, userId)).emit('notification', notification);
  }

  async close(): Promise<void> {
    await this.io.close();
  }
}
