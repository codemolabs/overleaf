# syntax=docker/dockerfile:1-labs
# ----------------------------------------------------------
# Overleaf: COSL Edition for Enterprises (codemolabs/overleaf)
# Built atop Overleaf Community Edition (overleaf/overleaf)
# ----------------------------------------------------------

ARG OVERLEAF_BASE_TAG=sharelatex/sharelatex-base:latest
FROM $OVERLEAF_BASE_TAG

WORKDIR /overleaf

# Install COSL runtime utilities (Cloud ZIP media optimization + host sync)
# ------------------------------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3-pil \
      optipng \
      qpdf \
      rsync && \
    rm -rf /var/lib/apt/lists/*

# Add required source files for yarn install
# ------------------------------------------
COPY --parents libraries/*/package.json .yarn/patches/ services/*/package.json tools/migrations/ package.json yarn.lock .yarnrc.yml .pnp.register.mjs /overleaf/
COPY server-ce/genScript.js server-ce/services.js /overleaf/

# Pre-install yarn via corepack so it is available at runtime for all users
# -------------------------------------------------------------------------
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack install -g yarn@4.18.0
ENV COREPACK_ENABLE_NETWORK=0

# Install yarn dependencies
# -------------------------
RUN --mount=type=cache,target=/root/.cache \
    --mount=type=cache,target=/root/.yarn/berry/cache,id=server-ce-yarn-cache \
    --mount=type=cache,target=/usr/local/share/.cache/yarn,id=server-ce-yarn-fallback-cache \
    --mount=type=tmpfs,target=/tmp node genScript install | bash

# Add source tree and COSL patches/extensions
# -------------------------------------------
COPY --parents libraries/ services/ tools/migrations/ /overleaf/
COPY apply-patches.mjs /overleaf/apply-patches.mjs
RUN node /overleaf/apply-patches.mjs --root /overleaf && \
    chmod +x /overleaf/services/web/app/src/Features/Downloads/cloud_zip_optimize.py

# Compile backend and frontend bundles (with build-time heap headroom)
# --------------------------------------------------------------------
RUN --mount=type=cache,target=/root/.cache \
    --mount=type=cache,target=/root/.yarn/berry/cache,id=server-ce-yarn-cache \
    --mount=type=cache,target=/usr/local/share/.cache/yarn,id=server-ce-yarn-fallback-cache \
    --mount=type=cache,target=/overleaf/services/web/.cache,id=server-ce-webpack-cache \
    --mount=type=tmpfs,target=/tmp \
    NODE_OPTIONS="--max-old-space-size=3072" node genScript compile | bash && \
    cd /overleaf/services/web && \
    NODE_OPTIONS="--require /overleaf/.pnp.cjs --import /overleaf/.pnp.register.mjs --max-old-space-size=3072" \
      yarn webpack --config webpack.config.ide.js && \
    NODE_OPTIONS="--require /overleaf/.pnp.cjs --import /overleaf/.pnp.register.mjs --max-old-space-size=3072" \
      yarn webpack --config webpack.config.project-list.js && \
    node merge-manifest.mjs

# Enable Yarn PnP resolution for all runtime Node.js processes
# ------------------------------------------------------------
ENV NODE_OPTIONS="--require /overleaf/.pnp.cjs --import /overleaf/.pnp.register.mjs"

# Copy runit service startup scripts
# ----------------------------------
ADD server-ce/runit /etc/service
COPY server-ce/runit/package-hub/run /etc/service/package-hub/run
COPY server-ce/runit/local-sync/run /etc/service/local-sync/run
RUN chmod +x /etc/service/package-hub/run /etc/service/local-sync/run

# Copy runit global settings
# --------------------------
ADD server-ce/config/env.sh /etc/overleaf/env.sh

# Configure nginx
# ---------------
ADD server-ce/nginx/nginx.conf.template /etc/nginx/templates/nginx.conf.template
ADD server-ce/nginx/overleaf.conf /etc/nginx/sites-enabled/overleaf.conf
ADD server-ce/nginx/clsi-nginx.conf /etc/nginx/sites-enabled/clsi-nginx.conf

# Configure log rotation
# ----------------------
ADD server-ce/logrotate/overleaf /etc/logrotate.d/overleaf
RUN chmod 644 /etc/logrotate.d/overleaf

# Configure cron tasks
# --------------------
ADD server-ce/cron /overleaf/cron
ADD server-ce/config/crontab-history /etc/cron.d/crontab-history
RUN chmod 600 /etc/cron.d/crontab-history
ADD server-ce/config/crontab-deletion /etc/cron.d/crontab-deletion
RUN chmod 600 /etc/cron.d/crontab-deletion

# Copy Phusion startup, admin bootstrap, and shutdown scripts
# -----------------------------------------------------------
COPY server-ce/init_scripts/ /etc/my_init.d/
COPY server-ce/init/920_bootstrap_admin.sh /etc/my_init.d/920_bootstrap_admin.sh
COPY server-ce/init/bootstrap-admin.mjs /overleaf/scripts/bootstrap-admin.mjs
RUN chmod +x /etc/my_init.d/*.sh
COPY server-ce/init_preshutdown_scripts/ /etc/my_init.pre_shutdown.d/

# Copy app and history-v1 settings
# --------------------------------
COPY server-ce/config/settings.js /etc/overleaf/settings.js
COPY server-ce/config/production.json /overleaf/services/history-v1/config/production.json
COPY server-ce/config/custom-environment-variables.json /overleaf/services/history-v1/config/custom-environment-variables.json

# Copy grunt thin wrapper and history helper scripts
# --------------------------------------------------
ADD server-ce/bin/grunt /usr/local/bin/grunt
RUN chmod +x /usr/local/bin/grunt
ADD server-ce/bin/flush-history-queues /overleaf/bin/flush-history-queues
RUN chmod +x /overleaf/bin/flush-history-queues
ADD server-ce/bin/force-history-resyncs /overleaf/bin/force-history-resyncs
RUN chmod +x /overleaf/bin/force-history-resyncs

# Copy Latexmkrc
# --------------
COPY server-ce/config/latexmkrc /usr/local/share/latexmk/LatexMk

# Apply COSL low-memory container tuning and runtime directories
# --------------------------------------------------------------
COPY scripts/tune-sharelatex-memory.sh /overleaf/scripts/tune-sharelatex-memory.sh
RUN chmod +x /overleaf/scripts/tune-sharelatex-memory.sh && \
    bash /overleaf/scripts/tune-sharelatex-memory.sh && \
    mkdir -p /projects/OverleafProjects /usr/local/texlive/texmf-local

# File that controls open|closed status of the site
# -------------------------------------------------
ENV SITE_MAINTENANCE_FILE="/etc/overleaf/site_status"
RUN touch $SITE_MAINTENANCE_FILE

# Set COSL Enterprise Environment Defaults
# ----------------------------------------
ENV OVERLEAF_CONFIG=/etc/overleaf/settings.js
ENV WEB_API_USER="overleaf"
ENV ADMIN_PRIVILEGE_AVAILABLE="true"
ENV OVERLEAF_APP_NAME="Overleaf: COSL Edition for Enterprises"
ENV OPTIMISE_PDF="true"
ENV REQ_VALIDATION_MODE=enforce-log
ENV OVERLEAF_ENABLE_PACKAGE_HUB="true"
ENV LOCAL_SYNC_ALLOWED_ROOT="/projects"
ENV LOCAL_SYNC_DEFAULT_BASE_DIR="/projects/OverleafProjects"
ENV MAX_UNFLUSHED_AGE_SECONDS=15
ENV CONTINUOUS_BACKGROUND_FLUSH=true

# Phusion Image timeouts before sending SIGKILL to processes
# ----------------------------------------------------------
ENV KILL_PROCESS_TIMEOUT=55
ENV KILL_ALL_PROCESSES_TIMEOUT=55
ENV GRACEFUL_SHUTDOWN_DELAY_SECONDS=1

ENV NODE_ENV="production"
ENV LOG_LEVEL="info"

EXPOSE 80

ENTRYPOINT ["/sbin/my_init"]
