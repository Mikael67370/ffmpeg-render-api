# =============================================================================
# FFmpeg Render API — Production Dockerfile
# =============================================================================
# Multi-purpose container for n8n video rendering automation.
# Built on node:18-slim for minimal image size while retaining glibc
# compatibility required by FFmpeg's shared libraries.
# =============================================================================

# --- Base image ---
# node:18-slim is Debian Bookworm-based, ~180 MB. We avoid Alpine because
# FFmpeg's apt package on Debian includes all common codecs (libx264, libx265,
# aac, etc.) out of the box, whereas Alpine requires manual compilation.
FROM node:18-slim

# --- Install FFmpeg and clean up in a single RUN layer ---
# Combining commands in one RUN reduces image layers and final size.
# --no-install-recommends avoids pulling unnecessary X11/GUI packages.
# The apt cache is purged to keep the image lean.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# --- Set working directory ---
# All subsequent commands and COPY instructions are relative to /app.
WORKDIR /app

# --- Copy dependency manifest first (Docker layer caching optimisation) ---
# By copying package.json and package-lock.json before the source code,
# Docker can cache the npm install layer. Source code changes won't
# invalidate the dependency layer, speeding up rebuilds significantly.
COPY package.json package-lock.json* ./

# --- Install production dependencies only ---
# --omit=dev excludes devDependencies, reducing image size and attack surface.
# npm ci is preferred over npm install for deterministic, reproducible builds.
# If no lock file exists, fall back to npm install.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# --- Copy application source ---
COPY . .

# --- Create temp directory for render jobs ---
# Ensures /tmp is writable (it should be by default, but explicit is safer).
RUN mkdir -p /tmp && chmod 1777 /tmp

# --- Expose the service port ---
# Render.com and most orchestrators read this as a hint. The actual port
# binding is controlled by the PORT environment variable at runtime.
EXPOSE 3000

# --- Default environment variables ---
# These can be overridden at runtime via docker run -e or Render env config.
ENV NODE_ENV=production
ENV PORT=3000

# --- Start the application ---
# Using npm start ensures the start script in package.json is the single
# source of truth for how the app launches.
CMD ["npm", "start"]
