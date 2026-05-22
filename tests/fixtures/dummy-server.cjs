/* Plain CommonJS TCP server fixture — no tsx loader needed.
 * Mirrors dummy-server.ts so daemon integration tests don't need
 * tsx resolvable from the service's cwd. */
const net = require('node:net');
const port = parseInt(process.argv[2] || '0', 10) || 9999;
const server = net.createServer(socket => {
  socket.on('error', () => {});
  socket.write('ok\n');
  socket.on('end', () => socket.end());
});
server.listen(port, () => console.log(`listening:${port}`));
server.on('error', err => console.error(`Server error: ${err.message}`));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
