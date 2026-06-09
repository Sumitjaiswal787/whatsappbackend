module.exports = {
  apps: [
    {
      name: 'whatsapp-backend',
      script: 'enhancedWorker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        PORT: 3001,
        NODE_ENV: 'production'
      }
    }
  ]
};
