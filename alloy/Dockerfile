# Grafana Alloy — Tranche 1 deliverable 1.3 (public status dashboard).
#
# Deploys as its own Render service ("vellar-alloy" in render.yaml), separate
# from the facilitator. Its only job: scrape the facilitator's public
# /metrics endpoint on a 15s interval and remote_write the samples to
# Grafana Cloud, since Grafana Cloud's Prometheus service is push-based and
# cannot pull from an arbitrary public URL itself. See
# docs/grafana-dashboard-setup.md for the full account-setup trail and
# alloy/config.alloy for the scrape/forward pipeline this image runs.
#
# PINNED, not `latest`: an unpinned tag here would mean a routine Render
# rebuild could silently pick up a new Alloy major version with no diff in
# this repo to review — the same class of hazard render.yaml's own comments
# warn about for dashboard-set env vars. Bump deliberately; check the
# CHANGELOG at https://github.com/grafana/alloy/releases before bumping.
FROM grafana/alloy:v1.5.1

COPY config.alloy /etc/alloy/config.alloy

# Render's own free-tier web services require the process to bind
# 0.0.0.0:$PORT (Render assigns $PORT; it is not always 10000) or Render's
# port-binding detection reports the service as down. Grafana's own upstream
# Dockerfile (github.com/grafana/alloy, tag v1.5.1) leaves Alloy's built-in
# UI/health server on its default 127.0.0.1:12345 — loopback-only, which
# Render cannot reach. --server.http.listen-addr overrides that to Render's
# $PORT, which also gives us a free, incidental way to confirm the container
# is alive (Render's port-binding detection) without a dedicated
# healthCheckPath, matching vellar-seller-demo's own "no healthCheckPath,
# port-binding detection is what we want" precedent in render.yaml.
#
# Shell form (not exec-form JSON array) so $PORT is expanded at container
# start, not baked in at build time.
ENTRYPOINT ["/bin/sh", "-c", "exec /bin/alloy run --server.http.listen-addr=0.0.0.0:${PORT:-12345} /etc/alloy/config.alloy"]
