module.exports = {
    apps: [{
      name: 'event-api',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        PORT: 3001,
        NODE_ENV: 'production'
      }
    }]
  };
