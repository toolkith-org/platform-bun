const server = Bun.serve({
  port: 0,
  routes: {
    '/api/*': req => {
      return Response.json({
        keys: Object.keys(req),
        params: req.params,
        url: req.url,
      });
    },
  },
});

const res = await fetch(`http://localhost:${server.port}/api/foo/bar/baz`);
console.log(await res.json());
server.stop();
