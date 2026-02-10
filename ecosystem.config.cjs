/** PM2 config: run with cwd = project root so .env is loaded from /home/greencore_api_v2/.env */
module.exports = {
  apps: [
    {
      name: 'greencore-api',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
