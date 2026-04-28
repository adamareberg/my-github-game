module.exports = {
  apps: [{
    name: 'reflex-arena',
    script: './server.js',
    instances: 'max', // Uses all available CPU cores
    exec_mode: 'cluster', // Enables Node.js clustering
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 9090
    }
  }]
};
