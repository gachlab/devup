// Minimal TCP server for integration tests
import net from 'node:net';
const port = parseInt(process.argv[2] ?? '0', 10) || 9999;
const server = net.createServer(socket => { socket.end('ok\n'); });
server.listen(port, () => console.log(`listening:${port}`));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
