import cluster from 'cluster';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (cluster.isPrimary) {
  const numCPUs = os.cpus().length;
  console.log(`\n=================================================`);
  console.log(`🚀 REFLEX ARENA - CLUSTER MASTER STARTED`);
  console.log(`=================================================`);
  console.log(`   Master PID : ${process.pid}`);
  console.log(`   CPU Cores  : ${numCPUs}`);
  console.log(`   Spawning   : ${numCPUs} workers...`);
  console.log(`-------------------------------------------------\n`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[Master] Worker ${worker.process.pid} is online.`);
  });

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[Master] Worker ${worker.process.pid} died (code: ${code}). Restarting...`);
    cluster.fork();
  });
} else {
  // Execute the main server script inside the worker process
  import('./server.js');
}
