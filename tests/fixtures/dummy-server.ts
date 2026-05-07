// Minimal TCP server for integration tests
import net from 'node:net';
const port = parseInt(process.argv[2] ?? '0', 10) || 9999;
const server = net.createServer(socket => {
  socket.on('error', () => {}); // Ignore socket errors
  socket.write('ok\n');
  // Don't end immediately, let client close the connection
  socket.on('end', () => {
    socket.end();
  });
});
server.listen(port, () => console.log(`listening:${port}`));
server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
