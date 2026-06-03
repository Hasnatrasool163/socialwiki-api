module.exports = {
  apps: [{
    name: 'admin-backend',
    script: './server.js',
    instances: 1, // or 'max' for cluster mode
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env_file: './.env', // Load .env file
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    },
    // Logging
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm Z',
    
    // Advanced settings
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 1000
  }]
};