#!/bin/bash

# 1. Fetch latest changes from github
echo "Fetching latest changes from origin..."
git fetch --all

# 2. Forcefully overwrite all local files to match remote main/master branch
# Replace 'main' with your actual default branch if it is different (e.g., 'master')
echo "Overwriting local changes and synchronizing with remote branch..."
git reset --hard origin/main
git clean -fd

# 3. Install clean, production dependencies and build the app
echo "Installing dependencies & building production assets..."
npm ci
npm run build

# 4. Restart PM2 and save configuration
echo "Restarting service under PM2..."
pm2 restart all
pm2 save

echo "Deployment completed successfully!"
