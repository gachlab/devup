// A dev server that behaves like `ng serve`: it opens its port immediately and
// only says it is actually serving some time later. The gap is the whole point
// — a port probe reports ready during it, and a browser gets nothing.
import net from 'node:net';
const port = parseInt(process.argv[2] ?? '0', 10) || 9999;
const compileMs = parseInt(process.argv[3] ?? '600', 10);
const server = net.createServer(socket => {
  socket.on('error', () => {});
  socket.write('ok\n');
  socket.on('end', () => socket.end());
});
server.listen(port, () => {
  console.log(`listening on :${port} — compiling…`);
  setTimeout(() => console.log('Application bundle generation complete.'), compileMs);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
