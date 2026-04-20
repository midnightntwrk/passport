FROM ubuntu:25.04
RUN apt-get update \
   && apt-get install -y --no-install-recommends libssl3 libgcc-s1 ca-certificates \
   && rm -rf /var/lib/apt/lists/*
COPY midnight-node /usr/local/bin/midnight-node
RUN apt-get update && apt-get install -y libssl3 && rm -rf /var/lib/apt/lists/*
COPY res/ /res/
ENTRYPOINT ["/usr/local/bin/midnight-node"]
