import type { Env } from '../env.ts'

/** What every admin route gets: the request, the verified user and the path below /api/admin. */
export interface Ctx {
  req: Request
  env: Env
  url: URL
  email: string
  path: string
}

/** A route group answers its own routes and returns null for everything else. */
export type Routes = (c: Ctx) => Promise<Response | null>
