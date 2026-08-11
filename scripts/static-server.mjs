import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env['NGRX_OFFLINE_E2E_PORT'] ?? 4173);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const target = resolveTarget(pathname);
    if (!target.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const details = await stat(target);
    if (!details.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1');

function resolveTarget(pathname) {
  if (pathname === '/ngrx-offline' || pathname === '/ngrx-offline/') {
    return path.resolve(root, 'dist/showcase/browser/index.html');
  }
  if (pathname.startsWith('/ngrx-offline/')) {
    const nested = pathname.slice('/ngrx-offline/'.length);
    const candidate = path.resolve(root, 'dist/showcase/browser', nested);
    return path.extname(candidate) === ''
      ? path.resolve(root, 'dist/showcase/browser/index.html')
      : candidate;
  }
  return path.resolve(root, `.${pathname}`);
}
