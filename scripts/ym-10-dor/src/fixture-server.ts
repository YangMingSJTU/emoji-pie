import { readFile } from 'node:fs/promises'
import { createServer, type Server as HttpsServer } from 'node:https'
import { join } from 'node:path'
import { CORPUS_50_FORBIDDEN_VALUES, findForbiddenValues } from './privacy'

const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAZElEQVR42u3QMREAAAgEIJOY2cZvDk8GClA9yWclQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIE3LcrsMJ3eyvKoQAAAABJRU5ErkJggg==',
  'base64'
)

export interface FixtureServerStats {
  requestCount: number
  searchRequests: number
  imageRequests: number
  forbiddenValueHits: number
}

export interface RunningFixtureServer {
  origin: string
  ca: string
  stats: FixtureServerStats
  close(): Promise<void>
}

function closeServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

export async function startFixtureServer(fixturesDirectory: string): Promise<RunningFixtureServer> {
  const [key, cert, ca, responseTemplate] = await Promise.all([
    readFile(join(fixturesDirectory, 'certs', 'localhost-key.pem'), 'utf8'),
    readFile(join(fixturesDirectory, 'certs', 'localhost-cert.pem'), 'utf8'),
    readFile(join(fixturesDirectory, 'certs', 'localhost-ca.pem'), 'utf8'),
    readFile(join(fixturesDirectory, 'openverse-smoke.json'), 'utf8')
  ])
  const stats: FixtureServerStats = {
    requestCount: 0,
    searchRequests: 0,
    imageRequests: 0,
    forbiddenValueHits: 0
  }
  let origin = ''
  const server = createServer({ key, cert }, (request, response) => {
    stats.requestCount += 1
    const rawTarget = request.url ?? ''
    stats.forbiddenValueHits += findForbiddenValues(rawTarget, CORPUS_50_FORBIDDEN_VALUES).length
    const url = new URL(rawTarget, origin)
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    if (url.pathname === '/v1/images/') {
      stats.searchRequests += 1
      if (url.searchParams.get('q') === 'redirect-fixture') {
        response.writeHead(302, { location: `${origin}/v1/images/` }).end()
        return
      }
      if (url.searchParams.get('license') !== 'cc0,pdm' ||
        url.searchParams.get('mature') !== 'false') {
        response.writeHead(400).end()
        return
      }
      const body = Buffer.from(responseTemplate.replaceAll('{{ORIGIN}}', origin))
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(body.byteLength)
      }).end(body)
      return
    }
    if (/^\/v1\/images\/[0-9a-f-]+\/thumb\/$/iu.test(url.pathname)) {
      stats.imageRequests += 1
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(FIXTURE_PNG.byteLength)
      }).end(FIXTURE_PNG)
      return
    }
    if (url.pathname === '/fixture/redirect') {
      response.writeHead(302, { location: `${origin}/v1/images/` }).end()
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('fixture_server_address_unavailable')
  }
  origin = `https://127.0.0.1:${address.port}`
  return {
    origin,
    ca,
    stats,
    close: () => closeServer(server)
  }
}
