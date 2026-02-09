#!/bin/bash

# Aggressive build reset script
echo "Performing aggressive build reset..."

# Set environment variables to prevent macOS metadata
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

# Remove all build artifacts
echo "Removing build artifacts..."
rm -rf src-tauri/target
rm -rf node_modules
rm -rf ../web/node_modules
rm -rf ../web/.next
rm -rf ../web/out

# Remove all metadata files recursively
echo "Removing metadata files..."
find /Volumes/sambigdisk/code/BriefCast_Pocket -name "._*" -type f -delete
find /Volumes/sambigdisk/code/BriefCast_Pocket -name ".DS_Store" -type f -delete

# Clean cargo cache
echo "Cleaning cargo cache..."
cargo clean 2>/dev/null || true

echo "Build reset complete!"
echo "You can now run: npm run tauri:dev"
