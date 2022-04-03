import {getAppRoot} from 'app/server/lib/places';
import {fromCallback} from 'bluebird';
import * as express from 'express';
import * as http from 'http';
import {AddressInfo, Socket} from 'net';
import * as path from 'path';
import {fixturesRoot} from 'test/server/testUtils';

export interface Serving {
  url: string;
  shutdown: () => void;
}


// Adds static files from a directory.
// By default exposes /fixture/sites
export function addStatic(app: express.Express, rootDir?: string) {
  // mix in a copy of the plugin api
  app.use(/^\/(grist-plugin-api.js)$/, (req, res) =>
          res.sendFile(req.params[0], {root:
                                        path.resolve(getAppRoot(), "static")}));
  app.use(express.static(rootDir || path.resolve(fixturesRoot, "sites"), {
    setHeaders: (res) => {
      res.set("Access-Control-Allow-Origin", "*");
    }
  }));
}

// Serve from a directory.
export async function serveStatic(rootDir: string): Promise<Serving> {
  return serveSomething(app => addStatic(app, rootDir));
}

// Serve a string of html.
export async function serveSinglePage(html: string): Promise<Serving> {
  return serveSomething(app => {
    app.get('', (req, res) => res.send(html));
  });
}

export function serveCustomViews(): Promise<Serving> {
  return serveStatic(path.resolve(fixturesRoot, "sites"));
}

export async function serveSomething(setup: (app: express.Express) => void, port= 0): Promise<Serving> {
  const app = express();
  const server = http.createServer(app);
  await fromCallback((cb: any) => server.listen(port, cb));

  const connections = new Set<Socket>();
  server.on('connection', (conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
  });

  function shutdown() {
    server.close();
    for (const conn of connections) { conn.destroy(); }
  }

  port = (server.address() as AddressInfo).port;
  app.set('port', port);
  setup(app);
  const url = `http://localhost:${port}`;
  return {url, shutdown};
}
