const server = Bun.serve({
  port: 0,
  routes: {
    '/api1/*': req => Response.json({ route: 1, params: req.params }),
    '/api2/:rest*': req => Response.json({ route: 2, params: req.params }),
    '/api3/:*': req => Response.json({ route: 3, params: req.params }),
  },
});

for (const path of ['/api1/foo/bar', '/api2/foo/bar', '/api3/foo/bar']) {
  const res = await fetch(`http://localhost:${server.port}${path}`);
  console.log(path, await res.json());
}
server.stop();
