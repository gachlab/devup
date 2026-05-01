// Script that exits with code 1 after a short delay
setTimeout(() => { console.error('crash!'); process.exit(1); }, 200);
