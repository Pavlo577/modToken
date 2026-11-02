// The Durable Object behind the dashboard's live updates (src/live.ts): it holds the user's open dashboards' WebSockets and passes the
// numbers of new calls on to them. The sockets hibernate: an idle dashboard costs nothing. Only the Worker's entry imports this file.
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.ts'

export class Live extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket', { status: 426 })
      const { 0: client, 1: server } = new WebSocketPair()
      this.ctx.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }
    if (path === '/push' && req.method === 'POST') {
      const sockets = this.ctx.getWebSockets()
      if (sockets.length) {
        const msg = JSON.stringify({ type: 'calls', calls: await req.json() })
        for (const ws of sockets) { try { ws.send(msg) } catch { /* a closing socket */ } }
      }
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  // the page only listens; a ping keeps proxies from closing an idle socket
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') ws.send('pong')
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code) } catch { /* already closed */ }
  }
}

